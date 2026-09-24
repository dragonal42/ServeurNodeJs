'use strict';

// ============================================================
//  courseetoile/api.js — RELAIS MULTIJOUEUR GÉNÉRIQUE
// ------------------------------------------------------------
//  Exemple de sous-site : servi sur multi.billiar.info/courseetoile/
//  (le nom du DOSSIER donne l'adresse : renommez-le, tout suit).
//
//  Ce module ne connaît AUCUNE règle de jeu : il relaie les messages
//  entre joueurs. C'est le jeu (public/jeu.js) qui décide quoi envoyer.
//
//  ✔ Toute personne qui ouvre la page est un joueur.
//  ✔ Room commune par défaut ("commune") ; un jeu peut en demander
//    une autre :  io('/courseetoile', { query: { room: 'ma-partie' } })
//  ✔ Un « hôte » par room = le joueur présent depuis le plus longtemps.
//    S'il part, le suivant prend le relais (arbitrage sans serveur).
//
//  ─── API Socket.IO (espace '/courseetoile') ─────────────────
//  Serveur → client
//    room:welcome        { you, players[], hostId, room }  (à l'arrivée)
//    room:player-joined  { player }
//    room:player-left    { id }
//    room:player-updated { player }       (nom/couleur changés)
//    room:host           { hostId }       (nouvel hôte élu)
//    game:update         { from, data }   (réponse à game:event)
//    game:broadcast      { from, data }
//    game:direct         { from, data }
//
//  Client → serveur
//    player:update  { name?, color? }  → change son profil
//    game:event     data  → à TOUTE la room, expéditeur compris
//    game:broadcast data  → aux AUTRES seulement
//    game:to        (idJoueur, data)  → à UN joueur précis
//
//  ─── HTTP ───────────────────────────────────────────────────
//    /courseetoile/        → public/index.html (le jeu)
//    /courseetoile/etat    → rooms et joueurs en JSON
// ============================================================

const DEFAULT_ROOM  = 'commune';
const MAX_MSG_PER_S = 60;           // anti-flood : messages / seconde / joueur
const MAX_PAYLOAD   = 16 * 1024;    // 16 Ko max par message

const COLORS = ['#ff5d73', '#4dd7ff', '#ffd23f', '#7cff6b', '#c38bff',
                '#ff9f43', '#2ee6a6', '#ff6bd6', '#6b8cff', '#e6e6e6'];

function clean(str, max)            // texte sûr et court (anti-injection HTML)
{
    return String(str ?? '').replace(/[<>&"'`]/g, '').trim().slice(0, max);
}

function publicPlayer(p)            // ce que les autres voient d'un joueur
{
    return { id: p.id, name: p.name, color: p.color, joinedAt: p.joinedAt };
}

function tropGros(data)
{
    try { return JSON.stringify(data ?? null).length > MAX_PAYLOAD; } catch { return true; }
}

let espace = null;                  // l'espace Socket.IO de ce sous-site

async function register(app, contexte)
{
    const { log, qui } = contexte;
    const io = contexte.io;         // = io.of('/courseetoile')
    espace = io;

    // rooms : nomRoom → Map(idSocket → joueur)
    // (l'ordre d'insertion de la Map = ordre d'arrivée → sert à élire l'hôte)
    const rooms = new Map();
    const hosts = new Map();        // nomRoom → id de l'hôte

    function electHost(room)
    {
        const players = rooms.get(room);
        const first = players && players.size ? players.keys().next().value : null;
        if (hosts.get(room) !== first)
        {
            if (first) hosts.set(room, first); else hosts.delete(room);
            if (first) io.to(room).emit('room:host', { hostId: first });
            log(`👑 hôte de « ${room} » : ${first ? players.get(first).name : '(room vide)'}`);
        }
    }

    // ---- Route HTTP (préfixée automatiquement : /courseetoile/etat) ----
    app.get('/etat', async () =>
    {
        const detail = {};
        for (const [name, players] of rooms) detail[name] = [...players.values()].map(p => p.name);
        return { ok: true, rooms: detail };
    });

    // ---- Connexions ----
    io.on('connection', (socket) =>
    {
        const room = clean(socket.handshake.query.room, 40) || DEFAULT_ROOM;
        if (!rooms.has(room)) rooms.set(room, new Map());
        const players = rooms.get(room);

        const player =
        {
             id       : socket.id
            ,name     : clean(socket.handshake.query.name, 20) || `Joueur-${socket.id.slice(0, 4)}`
            ,color    : COLORS[players.size % COLORS.length]
            ,joinedAt : Date.now()
        };
        players.set(socket.id, player);
        socket.join(room);
        log(`➕ ${player.name} rejoint « ${room} » (${players.size} joueur(s)) ${qui(socket)}`);

        // 1) Accueil du nouveau : qui il est + qui est déjà là
        electHost(room);
        socket.emit('room:welcome',
        {
             room
            ,you     : publicPlayer(player)
            ,players : [...players.values()].map(publicPlayer)
            ,hostId  : hosts.get(room)
        });
        // 2) Annonce aux autres
        socket.to(room).emit('room:player-joined', { player: publicPlayer(player) });

        // ---- Anti-flood simple (fenêtre d'une seconde) ----
        let debut = Date.now(), nb = 0;
        function autorise(data)
        {
            const maintenant = Date.now();
            if (maintenant - debut > 1000) { debut = maintenant; nb = 0; }
            return ++nb <= MAX_MSG_PER_S && !tropGros(data);
        }

        // ---- Profil ----
        socket.on('player:update', (data = {}) =>
        {
            if (!autorise(data)) return;
            if (data.name)
            {
                const avant = player.name;
                player.name = clean(data.name, 20) || player.name;
                if (player.name !== avant) log(`✏️  ${avant} s'appelle maintenant ${player.name} ${qui(socket)}`);
            }
            if (data.color && /^#[0-9a-f]{6}$/i.test(data.color)) player.color = data.color;
            io.to(room).emit('room:player-updated', { player: publicPlayer(player) });
        });

        // ---- Relais génériques ----
        socket.on('game:event', (data) =>              // à tous, moi compris
        {
            if (!autorise(data)) return;
            io.to(room).emit('game:update', { from: socket.id, data });
        });

        socket.on('game:broadcast', (data) =>          // aux autres
        {
            if (!autorise(data)) return;
            socket.to(room).emit('game:broadcast', { from: socket.id, data });
        });

        socket.on('game:to', (targetId, data) =>       // à un seul joueur de la room
        {
            if (!autorise(data) || !players.has(targetId)) return;
            io.to(targetId).emit('game:direct', { from: socket.id, data });
        });

        // ---- Départ ----
        socket.on('disconnect', (reason) =>
        {
            players.delete(socket.id);
            io.to(room).emit('room:player-left', { id: socket.id });
            log(`➖ ${player.name} quitte « ${room} » (${reason}) — reste ${players.size} ${qui(socket)}`);
            if (players.size === 0) { rooms.delete(room); hosts.delete(room); }
            else electHost(room);
        });
    });
}

async function close()
{
    if (espace) espace.disconnectSockets(true);
}

module.exports = { register, close };
