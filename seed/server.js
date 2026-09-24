'use strict';

// ============================================================
//  server.js — SERVEUR MULTI-SITES (Fastify + Socket.IO)
// ------------------------------------------------------------
//  Un seul serveur Node pour tout multi.billiar.info :
//
//   /opt/nodejs/                     → https://multi.billiar.info/
//   ├── server.js                      ce fichier (le « chef d'orchestre »)
//   ├── server-bibiplay.js             ┐ modules RACINE : tout fichier
//   ├── server-chat.js                 ┘ « server-*.js » est chargé tout seul
//   ├── blacklist.txt                  IP bannies (relu sans redémarrer)
//   ├── public/                        site par défaut  →  /
//   ├── courseetoile/                  sous-site        →  /courseetoile/
//   │   ├── api.js                       sa logique serveur (facultatif)
//   │   ├── .env                         ses réglages     (facultatif)
//   │   └── public/                      ses pages        (facultatif)
//   └── BAN-API/  …                    autant de sous-sites que voulu
//
//  ─── Modules ────────────────────────────────────────────────
//  Même contrat que votre ancien serveur Fastify :
//
//      module.exports = { register, close };
//      register(app, contexte)   (peut être async)
//      close()                   (facultatif, appelé à l'arrêt)
//
//  • Sous-site  : « app » est une instance Fastify ISOLÉE dont toutes
//    les routes sont préfixées :  app.get('/scores')  →  /courseetoile/scores
//    contexte.io = SON espace Socket.IO ('/courseetoile') : ses joueurs
//    et ses messages ne se mélangent pas avec les autres sites.
//  • Racine     : « app » = l'instance principale (routes à la racine),
//    contexte.io = le serveur Socket.IO principal (espace '/').
//    Format historique accepté aussi :  module.exports = function (socket, log)
//    (comme server-bibiplay.js) → appelé à chaque connexion Socket.IO.
//
//  contexte = { env, nom, dossierPath, fichierPath, urlBase,
//               io, ioRacine, log, ipDe, qui }
//
//  ─── Compatibilité Express ──────────────────────────────────
//  Les anciennes routes écrites en Express marchent telles quelles
//  (ex. initAPI(app) de public/games/PouletGame/server.js) :
//  res.json(), res.status(500).json(), res.set(), res.sendStatus()…
//  sont ajoutés aux réponses Fastify. (Pas les middlewares app.use.)
//
//  ─── Sécurité ───────────────────────────────────────────────
//  • blacklist.txt : IP ou plages (CIDR) refusées partout (pages, API,
//    Socket.IO). Modifié par SFTP → pris en compte en 2 s, sans restart ;
//    les connexions déjà ouvertes des IP bannies sont coupées.
//  • Jamais servis depuis un dossier public : server.js, api.js, *.db,
//    *.sqlite, .env, fichiers cachés (évite de télécharger vos bases
//    de données ou votre code serveur).
//
//  ─── Routes du serveur ──────────────────────────────────────
//    /health   → état JSON (sites chargés, modules, erreurs, blacklist)
//
//  Variables d'environnement (toutes facultatives) :
//    PORT (3000) · HOST (0.0.0.0) · LOG_LEVEL (warn)
//    ALLOWED_ORIGINS  domaines autorisés depuis une AUTRE origine
//    API_FILES        noms cherchés dans chaque sous-dossier (api.js,server.js)
// ============================================================

const fs      = require('fs');
const path    = require('path');
const Fastify = require('fastify');
const { Server } = require('socket.io');

// ============================================================
// Configuration globale
// ============================================================

const RACINE = __dirname;

const CONFIG =
{
     host        : process.env.HOST || '0.0.0.0'
    ,port        : Number(process.env.PORT || 3000)
    ,logLevel    : process.env.LOG_LEVEL || 'warn'
    ,origines    : (process.env.ALLOWED_ORIGINS ||
                     'https://billiar.info,https://www.billiar.info,https://test.billiar.info,' +
                     'https://insiders.billiar.info,https://multi.billiar.info')
                     .split(',').map(s => s.trim()).filter(Boolean)

    // Fichier serveur cherché dans chaque sous-dossier (le 1er trouvé gagne)
    ,fichiersApi : (process.env.API_FILES || 'api.js,server.js')
                     .split(',').map(s => s.trim()).filter(Boolean)

    // Dossiers de la racine qui ne sont PAS des sous-sites
    ,dossiersIgnores : ['public', 'data', 'tmp', 'node_modules', 'lib', 'logs']

    ,blacklist   : path.join(RACINE, 'blacklist.txt')
};

// ============================================================
// Liste MANUELLE des modules (facultative)
//
// Vide  → chargement AUTOMATIQUE :
//           1. les server-*.js de la racine (ordre alphabétique)
//           2. chaque sous-dossier (ordre alphabétique)
// Remplie → SEULS ces modules, dans CET ordre. Pour en désactiver
//           un : commenter sa ligne. Les sous-dossiers sans api.js
//           (pages seules) restent servis automatiquement.
//
// Astuce en mode automatique : pour désactiver un sous-site sans le
// supprimer, renommez son dossier avec un « _ » devant (_BAN-API).
// ============================================================

const MODULES_MANUELS =
[
    // './server-bibiplay.js'
    // ,'./server-chat.js'
    // ,'./BAN-API/api.js'
    // ,'./courseetoile/api.js'
];

// ============================================================
// Journal lisible (une ligne par événement, heure de Paris)
// ============================================================

function log(msg)
{
    const heure = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Paris' });
    console.log(`[${heure}] ${msg}`);
}

// ============================================================
// IP et appareil du visiteur
//
// Derrière Caddy, la vraie IP est dans X-Forwarded-For. Fastify la lit
// grâce à trustProxy (seulement si la requête vient d'un réseau privé,
// c.-à-d. de Caddy : impossible de tricher depuis Internet).
// ============================================================

const PROXYS_DE_CONFIANCE = ['127.0.0.1', '::1', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];

function nettoyerIp(ip)
{
    return String(ip || '').replace(/^::ffff:/, '');
}

function ipDepuisEntetes(entetes, adresseDirecte)
{
    const direct = nettoyerIp(adresseDirecte);
    const xff    = entetes && entetes['x-forwarded-for'];

    if (xff && estPrivee(direct))
    {
        return nettoyerIp(String(xff).split(',')[0].trim());
    }
    return direct;
}

// ipDe(request Fastify | socket Socket.IO | requête HTTP brute)
function ipDe(x)
{
    if (!x) return '?';
    if (x.handshake) return ipDepuisEntetes(x.handshake.headers, x.handshake.address);
    if (x.raw && x.ip) return nettoyerIp(x.ip);
    return ipDepuisEntetes(x.headers, x.socket && x.socket.remoteAddress);
}

function appareil(ua)
{
    ua = String(ua || '');
    const os  = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android'
              : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac'
              : /Linux/.test(ua) ? 'Linux' : '?';
    const nav = /bot|crawl|spider|headless|curl|wget|python/i.test(ua) ? 'ROBOT'
              : /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox'
              : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari'
              : ua.slice(0, 40) || '?';
    return `${nav}/${os}`;
}

// qui(socket | request) → "[86.200.12.34 Chrome/Windows]" pour les logs
function qui(x)
{
    const entetes = x && (x.handshake ? x.handshake.headers : x.headers) || {};
    return `[${ipDe(x)} ${appareil(entetes['user-agent'])}]`;
}

// ============================================================
// BLACKLIST — blacklist.txt
//
// Une entrée par ligne : 1.2.3.4 · 1.2.3.0/24 · 2001:db8::1
// « # » = commentaire. Relu automatiquement dès qu'il change.
// ============================================================

function ipv4VersNombre(ip)
{
    const p = ip.split('.');
    if (p.length !== 4 || p.some(x => !/^\d{1,3}$/.test(x) || Number(x) > 255)) return null;
    return ((+p[0] << 24) >>> 0) + (+p[1] << 16) + (+p[2] << 8) + (+p[3]);
}

function lireRegle(texte)
{
    const [ip, bits] = texte.split('/');
    const n = ipv4VersNombre(ip);

    if (n !== null)
    {
        const b = bits === undefined ? 32 : Number(bits);
        if (!(b >= 0 && b <= 32)) return null;
        const masque = b === 0 ? 0 : (0xFFFFFFFF << (32 - b)) >>> 0;
        return { texte, v4: true, reseau: (n & masque) >>> 0, masque };
    }
    if (ip.includes(':') && bits === undefined) return { texte, v4: false, ip: ip.toLowerCase() };
    return null;
}

function correspond(regle, ip)
{
    if (regle.v4)
    {
        const n = ipv4VersNombre(ip);
        return n !== null && ((n & regle.masque) >>> 0) === regle.reseau;
    }
    return ip.toLowerCase() === regle.ip;
}

function estPrivee(ip)
{
    return !ip || ip === '::1' || PROXYS_DE_CONFIANCE.some(r =>
    {
        const regle = lireRegle(r);
        return regle && correspond(regle, ip);
    });
}

let reglesBannies = [];

function chargerBlacklist()
{
    let texte = '';
    try { texte = fs.readFileSync(CONFIG.blacklist, 'utf8'); } catch { /* pas de fichier = personne n'est banni */ }

    const regles = [];
    texte.split(/\r?\n/).forEach((ligne, i) =>
    {
        const propre = ligne.replace(/#.*/, '').trim();
        if (!propre) return;
        for (const mot of propre.split(/[\s,;]+/))
        {
            const r = lireRegle(mot);
            if (r) regles.push(r);
            else log(`⚠️  blacklist.txt ligne ${i + 1} ignorée : « ${mot} » n'est pas une IP valide`);
        }
    });
    reglesBannies = regles;
    log(`⛔ Blacklist : ${regles.length} règle(s) active(s)`);
}

function estBannie(ip)
{
    return reglesBannies.some(r => correspond(r, ip));
}

// Pour ne pas inonder le journal : 1 ligne par IP bannie et par minute
const dernierRefus = new Map();

function noterRefus(ip, ou)
{
    const maintenant = Date.now();
    if (maintenant - (dernierRefus.get(ip) || 0) < 60000) return;
    dernierRefus.set(ip, maintenant);
    log(`⛔ Refusé (blacklist) : ${ip} → ${ou}`);
}

// ============================================================
// .env propre à un sous-site (sans polluer process.env)
// ============================================================

function chargerEnv(dossier)
{
    const env = {};
    let texte = '';
    try { texte = fs.readFileSync(path.join(dossier, '.env'), 'utf8'); } catch { return env; }

    for (const ligne of texte.split(/\r?\n/))
    {
        const m = ligne.match(/^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*?)\s*$/);
        if (!m || ligne.trim().startsWith('#')) continue;
        let v = m[2];
        if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
        else v = v.replace(/\s+#.*$/, '');
        env[m[1]] = v;
    }
    return env;
}

// ============================================================
// Création du serveur Fastify + Socket.IO
// ============================================================

// Pas de ligne de journal par requête (le journal reste lisible)
const sansLogRequetes = Fastify.LogController
    ? { logController: new Fastify.LogController({ disableRequestLogging: true }) }
    : { disableRequestLogging: true };

const app = Fastify(
{
     logger     : { level: CONFIG.logLevel }
    ,trustProxy : PROXYS_DE_CONFIANCE
    ,bodyLimit  : 1024 * 1024
    ,...sansLogRequetes
});

const io = new Server(app.server,
{
     cors               : { origin: CONFIG.origines, methods: ['GET', 'POST'], credentials: true }
    ,transports         : ['websocket', 'polling']    // WebSocket d'abord (Caddy le gère)
    ,pingInterval       : 10000
    ,pingTimeout        : 15000
    ,perMessageDeflate  : false
    ,httpCompression    : false
    ,connectTimeout     : 10000
    // Blacklist appliquée dès la poignée de main, pour TOUS les espaces
    ,allowRequest       : (req, callback) =>
    {
        const ip = ipDe(req);
        if (estBannie(ip))
        {
            noterRefus(ip, 'Socket.IO');
            return callback('IP bannie', false);
        }
        callback(null, true);
    }
});

// Coupe les connexions ouvertes des IP qui viennent d'être bannies
function couperLesBannis()
{
    for (const espace of io._nsps.values())
    {
        for (const socket of espace.sockets.values())
        {
            const ip = ipDe(socket);
            if (estBannie(ip))
            {
                log(`⛔ Connexion coupée (blacklist) : ${ip} ${espace.name}`);
                socket.disconnect(true);
            }
        }
    }
}

// ---- Compatibilité Express : res.json(), res.set(), res.sendStatus() ----
app.decorateReply('json', function (donnees)
{
    return this.send(donnees);
});
app.decorateReply('set', function (nom, valeur)
{
    return typeof nom === 'object' ? this.headers(nom) : this.header(nom, valeur);
});
app.decorateReply('sendStatus', function (code)
{
    return this.code(code).send(String(code));
});
app.decorateReply('end', function (donnees)
{
    return this.send(donnees === undefined ? '' : donnees);
});

// ---- Blacklist HTTP : avant toute page ou API ----
app.addHook('onRequest', async (request, reply) =>
{
    if (estBannie(request.ip))
    {
        noterRefus(request.ip, request.url);
        return reply.code(403).type('text/plain; charset=utf-8').send('Accès refusé');
    }
});

// ============================================================
// Fichiers statiques
// ============================================================

const INTERDITS = /(^|\/)(server|api)\.js$|\.(db|sqlite3?|db-journal|env)$|(^|\/)\./i;

function servirDossier(instance, dossierPublic, premier)
{
    return instance.register(require('@fastify/static'),
    {
         root          : dossierPublic
        ,prefix        : '/'
        ,decorateReply : premier       // un seul décorateur sendFile pour tout le serveur
        ,index         : ['index.html']
        ,allowedPath   : (chemin) => !INTERDITS.test(chemin)
    });
}

// ============================================================
// Recensement des modules
// ============================================================

const Chargements = [];    // { type, nom, url?, fichier?, statut, erreur?, module? }

function estDossierSite(nom)
{
    if (nom.startsWith('.') || nom.startsWith('_')) return false;
    if (CONFIG.dossiersIgnores.includes(nom.toLowerCase())) return false;
    try { return fs.statSync(path.join(RACINE, nom)).isDirectory(); } catch { return false; }
}

function trouverApi(dossier)
{
    for (const nom of CONFIG.fichiersApi)
    {
        const f = path.join(dossier, nom);
        if (fs.existsSync(f)) return f;
    }
    return null;
}

function recenser()
{
    const racine = [];
    const sites  = [];

    if (MODULES_MANUELS.length)
    {
        const vus = new Set();
        for (const entree of MODULES_MANUELS)
        {
            const fichier = path.resolve(RACINE, entree);
            const dossier = path.dirname(fichier);
            if (dossier === RACINE) racine.push(fichier);
            else { sites.push({ nom: path.basename(dossier), dossier, fichier }); vus.add(dossier); }
        }
        // Les sous-sites « pages seules » (sans api.js) restent servis
        for (const nom of fs.readdirSync(RACINE).sort())
        {
            const dossier = path.join(RACINE, nom);
            if (estDossierSite(nom) && !vus.has(dossier) && !trouverApi(dossier)
                && fs.existsSync(path.join(dossier, 'public')))
            {
                sites.push({ nom, dossier, fichier: null });
            }
        }
        return { racine, sites };
    }

    for (const nom of fs.readdirSync(RACINE).sort())
    {
        if (/^server-.+\.js$/.test(nom)) racine.push(path.join(RACINE, nom));
    }
    for (const nom of fs.readdirSync(RACINE).sort())
    {
        if (!estDossierSite(nom)) continue;
        const dossier = path.join(RACINE, nom);
        const fichier = trouverApi(dossier);
        if (fichier || fs.existsSync(path.join(dossier, 'public')))
        {
            sites.push({ nom, dossier, fichier });
        }
    }
    return { racine, sites };
}

// ============================================================
// Modules RACINE (server-*.js)
// ============================================================

async function chargerModuleRacine(fichier)
{
    const nom   = path.basename(fichier);
    const suivi = { type: 'racine', nom, fichier, statut: 'erreur' };
    Chargements.push(suivi);

    try
    {
        const mod = require(fichier);

        if (typeof mod === 'function')
        {
            // Format historique : function (socket, log) — ex. server-bibiplay.js
            io.on('connection', (socket) => mod(socket, log));
        }
        else if (mod && typeof mod.register === 'function')
        {
            await mod.register(app,
            {
                 env         : process.env
                ,nom
                ,dossierPath : RACINE
                ,fichierPath : fichier
                ,urlBase     : '/'
                ,io
                ,ioRacine    : io
                ,log
                ,ipDe
                ,qui
            });
        }
        else
        {
            suivi.erreur = 'ni fonction (socket, log), ni register()';
            log(`⚠️  Module racine ignoré [${nom}] : ${suivi.erreur}`);
            return;
        }
        suivi.statut = 'ok';
        suivi.module = mod;
        log(`🧩 Module racine chargé : ${nom}`);
    }
    catch (err)
    {
        suivi.erreur = err.message;
        log(`❌ Module racine [${nom}] en erreur : ${err.stack || err}`);
    }
}

// ============================================================
// SOUS-SITES (un dossier = une URL)
// ============================================================

function chargerSite({ nom, dossier, fichier })
{
    const urlBase = '/' + nom;
    const suivi   = { type: 'site', nom, url: urlBase + '/', fichier, statut: 'ok' };
    Chargements.push(suivi);

    const dossierPublic = path.join(dossier, 'public');
    const aPublic       = fs.existsSync(dossierPublic);

    if (fs.existsSync(path.join(RACINE, 'public', nom)))
    {
        log(`⚠️  public/${nom}/ est masqué par le sous-site ${urlBase}/`);
    }

    // /courseetoile  →  /courseetoile/  (sinon les liens relatifs cassent)
    app.get(urlBase, (request, reply) =>
    {
        const q = request.url.indexOf('?');
        return reply.redirect(urlBase + '/' + (q >= 0 ? request.url.slice(q) : ''), 301);
    });

    // Chaque sous-site vit dans sa propre « bulle » Fastify (encapsulation) :
    // ses routes, hooks et décorateurs ne débordent pas sur les autres.
    app.register(async (sousApp) =>
    {
        if (aPublic) await servirDossier(sousApp, dossierPublic, false);
        if (!fichier) return;

        try
        {
            const mod = require(fichier);
            if (!mod || typeof mod.register !== 'function')
            {
                throw new Error('fonction register() absente');
            }

            const contexte =
            {
                 env         : chargerEnv(dossier)
                ,nom
                ,dossierPath : dossier
                ,fichierPath : fichier
                ,urlBase
                ,ioRacine    : io
                ,log         : (m) => log(`[${nom}] ${m}`)
                ,ipDe
                ,qui
            };
            // Espace Socket.IO créé seulement si le module s'en sert
            Object.defineProperty(contexte, 'io', { enumerable: true, get: () => io.of(urlBase) });

            await mod.register(sousApp, contexte);
            suivi.module = mod;
            log(`🧩 Sous-site chargé : ${urlBase}/  (${path.basename(fichier)}${aPublic ? ' + public/' : ''})`);
        }
        catch (err)
        {
            // Un sous-site en panne ne fait pas tomber les autres
            suivi.statut = 'erreur';
            suivi.erreur = err.message;
            log(`❌ Sous-site ${urlBase}/ en erreur : ${err.stack || err}`);
        }
    }, { prefix: urlBase });

    if (!fichier) log(`📁 Sous-site chargé : ${urlBase}/  (pages seules)`);
}

// ============================================================
// Routes du serveur
// ============================================================

app.get('/health', async () =>
({
     status    : 'OK'
    ,timestamp : new Date().toISOString()
    ,uptime    : Math.round(process.uptime())
    ,blacklist : reglesBannies.length
    ,racine    : Chargements.filter(c => c.type === 'racine')
                            .map(c => ({ nom: c.nom, statut: c.statut, erreur: c.erreur }))
    ,sites     : Chargements.filter(c => c.type === 'site')
                            .map(c => ({ nom: c.nom, url: c.url, api: c.fichier ? path.basename(c.fichier) : null,
                                         statut: c.statut, erreur: c.erreur }))
    ,joueurs   : Object.fromEntries([...io._nsps.values()].map(n => [n.name, n.sockets.size]))
}));

// ============================================================
// Arrêt propre (restart.txt et docker stop envoient SIGTERM)
// ============================================================

let arretEnCours = false;

async function arreter(signal)
{
    if (arretEnCours) return;
    arretEnCours = true;
    log(`■ Arrêt demandé (${signal})`);
    setTimeout(() => process.exit(0), 3000).unref();

    for (const c of [...Chargements].reverse())
    {
        if (c.module && typeof c.module.close === 'function')
        {
            try { await c.module.close(); log(`   module fermé : ${c.nom}`); }
            catch (err) { log(`   erreur à la fermeture de ${c.nom} : ${err.message}`); }
        }
    }
    try { io.close(); await app.close(); } catch { /* déjà fermé */ }
    process.exit(0);
}

process.on('SIGINT',  () => arreter('SIGINT'));
process.on('SIGTERM', () => arreter('SIGTERM'));

// ============================================================
// Démarrage
// ============================================================

async function demarrer()
{
    log('=========================================');
    log('🚀 DÉMARRAGE DU SERVEUR MULTI-SITES');
    log('=========================================');

    chargerBlacklist();
    fs.watchFile(CONFIG.blacklist, { interval: 2000 }, () =>
    {
        chargerBlacklist();
        couperLesBannis();
    });

    await app.register(require('@fastify/cors'), { origin: CONFIG.origines });

    const { racine, sites } = recenser();

    // 1. Modules racine (chat, Bibiplay…) : routes à la racine
    for (const fichier of racine) await chargerModuleRacine(fichier);

    // 2. Site par défaut : public/ à la racine
    if (fs.existsSync(path.join(RACINE, 'public')))
    {
        await servirDossier(app, path.join(RACINE, 'public'), true);
    }
    else
    {
        app.decorateReply('sendFile', function () { return this.code(404).send(); });
    }

    // 3. Sous-sites
    for (const site of sites) chargerSite(site);

    try
    {
        await app.listen({ host: CONFIG.host, port: CONFIG.port });
    }
    catch (err)
    {
        log(`❌ Démarrage impossible : ${err.stack || err}`);
        process.exit(1);
    }

    const nbErreurs = Chargements.filter(c => c.statut === 'erreur').length;
    log(`✅ Serveur prêt sur le port ${CONFIG.port} — ${Chargements.length} module(s)/site(s)`
        + (nbErreurs ? `, ⚠️  ${nbErreurs} en erreur (voir /health)` : ''));
}

demarrer();
