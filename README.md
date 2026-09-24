# billiar-lobby — serveur de jeux multijoueurs (Docker + Dockhand)

Express + Socket.IO + sqlite3, SFTP avec interface web (SFTPGo), publié
par Caddy sur `multi.billiar.info`. Installation et mises à jour
**automatiques depuis GitHub via Dockhand**.

## Principe : qui gère quoi ?

| Où | Contenu | Mis à jour par |
|---|---|---|
| **GitHub** (ce dépôt) | `docker-compose.yml`, `Dockerfile`, `entrypoint.sh`, `package.json`, `seed/` | `git push` → Dockhand redéploie |
| **`/opt/nodejs`** (serveur) | `server.js`, `server-bibiplay.js`, `public/` (jeux), `data/chat.db`, `tmp/` | **SFTP** (FileZilla) + `tmp/restart.txt` |
| **`/opt/sftpgo`** (serveur) | comptes SFTP | interface web SFTPGo |

Git ne touche **jamais** à `/opt/nodejs` : un redéploiement ne peut pas
écraser vos jeux. `seed/` ne sert qu'au tout premier démarrage (fichiers
copiés **seulement s'ils manquent**).

```
dépôt GitHub                         serveur Docker
├── docker-compose.yml               /opt/nodejs/          ← SFTP (home)
├── Dockerfile                       ├── server.js         (seed si absent)
├── entrypoint.sh                    ├── server-bibiplay.js  ← à déposer
├── package.json                     ├── public/           ← vos jeux
├── seed/                            ├── data/chat.db
│   ├── server.js                    └── tmp/restart.txt · restart.log
│   └── public/index.html            /opt/sftpgo/          ← comptes SFTP
├── .env.example
├── .gitignore / .gitattributes / .dockerignore
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

- Le réseau du Caddy existe : `docker network ls | grep caddy`
  — sinon `docker network create caddy` (ou Dockhand → Networks → Create).
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
   DOMAIN=multi.billiar.info
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
> Caddy : `dockhand.billiar.info { reverse_proxy dockhand:3000 }`). Si vous
> ne voulez pas l'exposer : utilisez à la place la **synchro planifiée**
> de Dockhand (ex. toutes les 5 min), même résultat, sans ouverture.

## 5. Après le premier déploiement

1. Connectez-vous à SFTPGo `http://IP:8080/web/admin` (admin + mot de passe
   de l'étape 3) → créez l'utilisateur SFTP, **home** : `/srv/warpclash`.
2. FileZilla : protocole **SFTP**, hôte `multi.billiar.info`, port **2022**.
3. Déposez **`server-bibiplay.js`** à la racine et vos jeux dans `public/`.
   Ouvrez `tmp/restart.log` (F5) :
   ```
   🌱 fichier initial installé : server.js
   ⏳ en attente de : server-bibiplay.js — déposez-le(s) par SFTP…
   ▶ Express démarré (pid 42)
   ```
   Express démarre **tout seul** dès que le fichier arrive.
4. Test : `https://multi.billiar.info` et
   `curl "https://multi.billiar.info/socket.io/?EIO=4&transport=polling"` → `0{"sid":…`

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
