# billiar-lobby — serveur de jeux multijoueurs (Docker + Dockhand)

Express + Socket.IO + sqlite3, SFTP avec interface web (SFTPGo), publié
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

1. Connectez-vous à SFTPGo `http://IP:8081/web/admin` (admin + mot de passe
   de l'étape 3) → créez l'utilisateur SFTP, **home** : `/srv/warpclash`.
2. FileZilla : protocole **SFTP**, hôte `multi.billiar.info`, port **2022**.
3. Le serveur **tourne déjà** : `https://multi.billiar.info` affiche le
   mini-jeu **Attrape-étoiles** (ouvrez 2 onglets pour le voir en multi).
   Remplacez/ajoutez vos fichiers par SFTP, puis déposez **`tmp/restart.txt`**.
   Astuce : supprimer un fichier de départ puis déposer `restart.txt` le
   réinstalle dans sa version d'origine.
4. Test : `https://multi.billiar.info` et
   `curl "https://multi.billiar.info/socket.io/?EIO=4&transport=polling"` → `0{"sid":…`

## Le serveur générique (`server.js` de départ)

Aucune règle de jeu côté serveur : il sert `public/` et **relaie**.
Toute personne qui ouvre la page est un joueur de la room **commune**
(un jeu peut en demander une autre : `io({ query: { room: 'x' } })`).
Le joueur présent depuis le plus longtemps est élu **hôte** (arbitre) ;
s'il part, le suivant prend le relais.

| Le client envoie | Les autres reçoivent |
|---|---|
| `game:event` data | `game:update {from, data}` — **toute** la room, moi compris |
| `game:broadcast` data | `game:broadcast {from, data}` — les **autres** |
| `game:to` (id, data) | `game:direct {from, data}` — **un** joueur |
| `player:update {name, color}` | `room:player-updated {player}` |

Reçus automatiquement : `room:welcome {you, players, hostId}`,
`room:player-joined`, `room:player-left`, `room:host {hostId}`.
Supervision : `GET /health`. Anti-flood 60 msg/s, 16 Ko max par message.

**Le mini-jeu (`public/jeu.js`, p5.js, entièrement commenté)** montre les
trois usages : position de chaque joueur → `game:broadcast` (~15/s,
interpolée) ; l'hôte fait apparaître les étoiles et valide les prises →
`game:event` ; un nouveau venu reçoit l'état complet → `game:to`.
Premier à 10 étoiles gagne la manche.

p5.js 1.11 est embarqué dans `public/lib/` (aucun CDN) — licence LGPL,
fichier `p5.LICENSE.txt` à côté.

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
