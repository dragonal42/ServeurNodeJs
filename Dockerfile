# ============================================================
# Serveur lobby multijeux billiar.info — image Docker
# (construite automatiquement par Dockhand depuis GitHub)
# ============================================================
# L'image contient : Node 20 + dépendances npm + nodemon
#                    + entrypoint.sh (superviseur restart.txt)
#                    + seed/ (fichiers de départ, copiés SEULEMENT
#                      s'ils manquent dans /opt/nodejs)
# Elle ne contient PAS votre code vivant : /opt/nodejs est monté
# en entier sur /app ; vous le gérez par SFTP.
#
# Dépendances dans /deps (hors /app, jamais masquées par le mount)
# → un changement de package.json poussé sur GitHub = rebuild
#   Dockhand = nouvelles dépendances actives, sans rien d'autre.
# ============================================================
FROM node:20-slim

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/app/data/chat.db \
    NODE_PATH=/deps/node_modules

WORKDIR /deps
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
 && npm install -g --no-audit --no-fund nodemon \
 && npm cache clean --force

# Fichiers de départ (amorçage no-clobber, voir entrypoint.sh)
COPY seed/ /seed/

# Superviseur (sed : protège contre des fins de ligne Windows)
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh \
 && chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /app
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
