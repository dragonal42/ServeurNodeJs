# billiar-lobby — serveur de jeux multijoueurs (Docker + Dockhand)

Fastify + Socket.IO + sqlite3, SFTP avec interface web (SFTPGo), publié
par Caddy (caddy-docker-proxy, réseau `proxy-net`) sur `multi.billiar.info`. Installation et mises à jour
**automatiques depuis GitHub via Dockhand**.

## Principe : qui gère quoi ?

| Où | Contenu | Mis à jour par |
|---|---|---|
| **GitHub** (ce dépôt) | `docker-compose.yml`, `Dockerfile`, `entrypoint.sh`, `package.json`, `seed/` | `git push` → Dockhand redéploie |
| **`/opt/nodejs`** (serveur) | `server.js`, `public/` (jeux), `data/`, `tmp/` | **SFTP** (FileZilla) + `tmp/restart.txt` |
| **`/opt/sftpgo`** (serveur) | comptes SFTP | interface web SFTPGo |

Git ne touche **jamais** à `/opt/nodejs` : un redéploiement ne peut pas
écraser vos jeux. `seed/` ne sert qu'au tout premier démarrage (fichiers
copiés **seulement s'ils manquent**).

```
dépôt GitHub                         serveur Docker
├── docker-compose.yml               /opt/nodejs/          ← SFTP (home)
├── Dockerfile                       ├── server.js         (générique, seed)
├── entrypoint.sh                    ├── public/
├── package.json                     │   ├── index.html    (mini-jeu, seed)
├── seed/   ← fichiers de départ     │   ├── jeu.js        (mini-jeu, seed)
│   ├── server.js                    │   └── lib/p5.min.js (seed)
│   └── public/ index.html, jeu.js,  ├── data/
│       lib/p5.min.js                └── tmp/restart.txt · restart.log
├── .env.example                     /opt/sftpgo/          ← comptes SFTP
└── README.md
```

## 1. Mettre le dépôt sur GitHub (une fois)

Dépôt **privé** conseillé (il contient votre `server.js`).

```bash
cd depot-github
git init -b main
git add .
git commit -m "Stack serveur de jeux billiar.info"
git remote add origin git@github.com:VOTRE_COMPTE/billiar-lobby.git
git push -u origin main
```

> `.gitattributes` force `entrypoint.sh` en fins de ligne Unix (LF) même
> depuis Windows ; le Dockerfile les corrige aussi par sécurité.

## 2. Prérequis sur le serveur (une fois)

- **Réseau Caddy** : la stack rejoint `proxy-net` (réseau externe de votre
  caddy-docker-proxy, comme vos autres stacks) — rien à faire s'il existe
  (`docker network ls | grep proxy-net`).
- Si Dockhand avait déjà une ancienne version déployée à la main
  (`docker compose up` dans /opt/nodejs) : `docker compose down` dessus
  d'abord (conflit de noms `billiar-lobby` / `sftpgo`). **Aucun fichier
  perdu** : tout est dans `/opt/nodejs` et `/opt/sftpgo`.
- Pas besoin de créer `/opt/nodejs` ni `/opt/sftpgo` : le service
  `prepare` s'en charge (droits uid 1000 compris).

## 3. Créer la stack dans Dockhand

1. **Settings → Git repositories → Add** : URL du dépôt
   + identifiants (dépôt privé : *deploy key* SSH en lecture seule, ou
   *token* GitHub à portée « Contents: read »).
2. **Stacks → Create → From Git** :
   - Repository : `billiar-lobby` — branche `main`
   - Compose path : `docker-compose.yml`
   - **Build on deploy : activé** (l'image est construite depuis le Dockerfile)
3. **Environment** de la stack (voir `.env.example`) :
   ```
   SFTPGO_ADMIN_PASSWORD=un-mot-de-passe-long
   CADDY_URL=multi.billiar.info
   ```
   (Sans `SFTPGO_ADMIN_PASSWORD`, le déploiement s'arrête volontairement
   avec un message explicite.)
4. **Deploy**. Résultat attendu :
   - `prepare` → **Exited (0)** : normal, il a préparé `/opt` puis s'est arrêté ;
   - `sftpgo` et `billiar-lobby` → **Running**.

## 4. Mise à jour automatique à chaque `git push` (webhook)

1. Dans Dockhand, stack → copier l'**URL du webhook** (+ son secret).
2. GitHub → dépôt → **Settings → Webhooks → Add webhook** :
   - Payload URL : l'URL copiée
   - Content type : `application/json`
   - Secret : celui de Dockhand
   - Événement : *Just the push event*
3. Désormais : `git push` → Dockhand re-clone, rebuild, recrée **seulement**
   ce qui a changé.

> GitHub doit pouvoir joindre Dockhand depuis Internet (ex. le publier par
> labels Caddy : `caddy=dockhand.billiar.info` sur `proxy-net`). Si vous
> ne voulez pas l'exposer : utilisez à la place la **synchro planifiée**
> de Dockhand (ex. toutes les 5 min), même résultat, sans ouverture.

## 5. Après le premier déploiement

1. Connectez-vous à SFTPGo `https://sftp.billiar.info/web/admin` (entrée DNS `sftp` → IP du serveur, comme `multi`) (admin + mot de passe
   de l'étape 3) → créez l'utilisateur SFTP, **home** : `/app`.
2. FileZilla : protocole **SFTP**, hôte `multi.billiar.info`, port **2022**.
3. Le serveur **tourne déjà** : `https://multi.billiar.info` affiche le
   mini-jeu **Attrape-étoiles** (ouvrez 2 onglets pour le voir en multi).
   Remplacez/ajoutez vos fichiers par SFTP, puis déposez **`tmp/restart.txt`**.
   Astuce : supprimer un fichier de départ puis déposer `restart.txt` le
   réinstalle dans sa version d'origine.
4. Test : `https://multi.billiar.info` et
   `curl "https://multi.billiar.info/socket.io/?EIO=4&transport=polling"` → `0{"sid":…`

## Le serveur multi-sites (`server.js` de départ, Fastify)

```
/opt/nodejs/                  → https://multi.billiar.info/
├── server.js                   le serveur (réinstallé s'il est supprimé)
├── server-*.js                 modules RACINE chargés tout seuls
│                               (server-chat.js, server-bibiplay.js…)
├── blacklist.txt               IP bannies — relu en 2 s, sans redémarrer
├── public/                     site par défaut  → /
├── courseetoile/               exemple de sous-site → /courseetoile/
│   ├── api.js                    logique serveur : register(app, contexte)
│   ├── .env                      réglages propres (facultatif)
│   └── public/                   pages, jeu p5.js
└── MON-API/ …                  un dossier = une adresse
```

- **Sous-site** : tout dossier contenant `api.js` (ou `server.js`) et/ou `public/`.
  Ses routes sont préfixées (`app.get('/etat')` → `/courseetoile/etat`) et il a
  son propre espace Socket.IO (`io('/courseetoile')` côté navigateur).
  Désactiver sans supprimer : renommer le dossier avec `_` devant.
- **Racine** : `public/` est servi sur `/` ; les `server-*.js` reçoivent
  l'instance principale. Format historique `function (socket, log)` accepté.
- **Liste manuelle** : `MODULES_MANUELS` en haut de `server.js` (vide = auto).
- **Compatibilité Express** : `res.json()`, `res.status().json()`, `res.set()`…
  marchent dans les routes (ex. `initAPI(app)` des jeux `public/games/*/server.js`).
- **Jamais servis** : `server.js`, `api.js`, `*.db`, `*.sqlite`, `.env`, fichiers cachés.
- **`/health`** : sites chargés, erreurs, joueurs par espace.
- Un module en erreur n'empêche pas les autres de démarrer (voir `/health`).
- Les fichiers de départ ne sont installés qu'**une fois** (mémorisés dans
  `data/.seeds-installes`) : un exemple supprimé ne revient pas. Seul
  `server.js` est réinstallé s'il manque.

## Ports

Un seul port est ouvert sur l'hôte : **2022 (SFTP)**, réglable par
`SFTPGO_PORT_SFTP`. Le jeu (`CADDY_URL`) et l'interface web SFTPGo
(`SFTPGO_URL`) passent par Caddy via `proxy-net` → aucun conflit avec les
ports 3000/8080/8081/8082 déjà pris par vos autres services.

## Port 3000

Le lobby ne publie **aucun port** sur l'hôte : Caddy le joint via `proxy-net`
(le port 3000 de l'hôte est souvent déjà pris, par ex. par Dockhand →
erreur `Bind for 0.0.0.0:3000 failed: port is already allocated`).

## Au quotidien

| Je veux… | Je fais… |
|---|---|
| modifier un jeu (HTML/JS client) | SFTP → `public/…` (effet immédiat) |
| modifier `server.js` / un module `.js` | SFTP, puis déposer **`tmp/restart.txt`** |
| ajouter une dépendance npm | éditer `package.json` **dans Git** → `git push` |
| changer ports / domaine / config Docker | éditer le compose **dans Git** → `git push` |
| voir ce qui se passe | `tmp/restart.log` (SFTP) ou onglet Logs de Dockhand |

⚠️ Ne déposez pas de dossier `node_modules` dans `/opt/nodejs` (par ex.
copié depuis o2switch) : il serait prioritaire sur les dépendances de l'image
et `sqlite3` (module compilé) pourrait refuser de charger.

Note : `seed/server.js` ne sert qu'aux installations vierges ; le serveur
utilise toujours `/opt/nodejs/server.js`. Mettre à jour `seed/` dans Git ne
modifie donc **pas** un serveur déjà installé (c'est voulu).

## Sauvegarde

```bash
sudo tar czf /root/billiar-$(date +%F).tar.gz -C / opt/nodejs opt/sftpgo
```
Réinstallation complète d'un serveur = restaurer cette archive + créer la
stack Dockhand (§3) : tout revient à l'identique.
