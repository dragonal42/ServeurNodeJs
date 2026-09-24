#!/bin/sh
# ============================================================
# Superviseur du serveur lobby — façon « Passenger / o2switch »
# ------------------------------------------------------------
# 1. AMORÇAGE : au démarrage, copie depuis l'image (/seed) les
#    fichiers ABSENTS de /opt/nodejs (server.js, page d'accueil…).
#    Ne remplace JAMAIS un fichier existant → vos dépôts SFTP
#    sont toujours prioritaires.
# 2. ATTENTE : si un fichier requis manque (ex. server-bibiplay.js),
#    Express n'est pas lancé ; tmp/restart.log l'indique et le
#    démarrage se fait tout seul dès que le fichier est déposé.
# 3. REDÉMARRAGE PAR FTP : déposer / remplacer / toucher
#       /opt/nodejs/tmp/restart.txt   (= /app/tmp/restart.txt)
#    → Express redémarre (≈2 s). Supprimer seul ne déclenche rien.
# 4. RELANCE AUTO si Node plante (erreur dans un .js).
#
# Compte rendu lisible en SFTP : /opt/nodejs/tmp/restart.log
#
# Variables (compose → environment) :
#   RESTART_POLL=2          intervalle de surveillance (s)
#   RESTART_CRASH_DELAY=5   délai avant relance après un crash (s)
#   REQUIRED_FILES="server.js server-bibiplay.js"
#   WATCH=1                 mode nodemon (reload à chaque .js)
# ============================================================

APP_DIR="${APP_DIR:-/app}"
SEED_DIR="${SEED_DIR:-/seed}"
TMP_DIR="$APP_DIR/tmp"
TRIGGER="$TMP_DIR/restart.txt"
LOG="$TMP_DIR/restart.log"
POLL="${RESTART_POLL:-2}"
CRASH_DELAY="${RESTART_CRASH_DELAY:-5}"
REQUIRED_FILES="${REQUIRED_FILES:-server.js server-bibiplay.js}"
PID=""
WAITING=""

mkdir -p "$TMP_DIR" "$APP_DIR/data" "$APP_DIR/public" 2>/dev/null

log() {
  line="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
  echo "$line"
  echo "$line" >> "$LOG" 2>/dev/null
  if [ "$(wc -l < "$LOG" 2>/dev/null || echo 0)" -gt 400 ]; then
    tail -n 200 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
  fi
}

# ---- 1. Amorçage (no-clobber, fichier par fichier) ----
if [ -d "$SEED_DIR" ]; then
  (cd "$SEED_DIR" && find . -type f) | while IFS= read -r f; do
    f="${f#./}"
    if [ ! -e "$APP_DIR/$f" ]; then
      mkdir -p "$(dirname "$APP_DIR/$f")"
      cp "$SEED_DIR/$f" "$APP_DIR/$f" && log "🌱 fichier initial installé : $f"
    fi
  done
fi

# Permissions alignées avec SFTPGo (uid 1000) : tout reste modifiable
# et supprimable par SFTP.
chown 1000:1000 "$APP_DIR" 2>/dev/null
chown -R 1000:1000 "$APP_DIR/public" "$APP_DIR/data" "$TMP_DIR" 2>/dev/null
for f in $REQUIRED_FILES; do chown 1000:1000 "$APP_DIR/$f" 2>/dev/null; done
true

# Empreinte du déclencheur (date/heure à la nanoseconde). Comparaison par
# « différent » : marche même si le client FTP conserve une date ancienne.
stamp() { stat -c '%y' "$TRIGGER" 2>/dev/null || echo none; }

missing() {
  m=""
  for f in $REQUIRED_FILES; do [ -f "$APP_DIR/$f" ] || m="$m $f"; done
  echo "${m# }"
}

start_node() {
  cd "$APP_DIR" || exit 1
  if [ "${WATCH:-0}" = "1" ]; then
    nodemon --legacy-watch --ext js,json --watch "$APP_DIR" \
      --ignore "$APP_DIR/public/**" --ignore "$APP_DIR/data/**" \
      --ignore "$APP_DIR/tmp/**" --ignore "$APP_DIR/node_modules/**" \
      "$APP_DIR/server.js" &
  else
    node "$APP_DIR/server.js" &
  fi
  PID=$!
  log "▶ Express démarré (pid $PID)"
}

# Démarre seulement si les fichiers requis sont là ; sinon signale
# (une seule fois par état) et réessaie au prochain tour de boucle.
try_start() {
  M=$(missing)
  if [ -n "$M" ]; then
    if [ "$M" != "$WAITING" ]; then
      log "⏳ en attente de : $M — déposez-le(s) par SFTP à la racine (/opt/nodejs), démarrage automatique ensuite"
    fi
    WAITING="$M"
    return 1
  fi
  WAITING=""
  start_node
}

stop_node() {
  [ -n "$PID" ] || return 0
  kill -TERM "$PID" 2>/dev/null
  i=0
  while kill -0 "$PID" 2>/dev/null && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done
  if kill -0 "$PID" 2>/dev/null; then
    log "⚠ arrêt forcé (SIGKILL) pid $PID"
    kill -KILL "$PID" 2>/dev/null
  fi
  wait "$PID" 2>/dev/null
  PID=""
}

trap 'log "■ arrêt du conteneur"; stop_node; exit 0' TERM INT

LAST=$(stamp)
try_start

while true; do
  sleep "$POLL" &
  wait $!          # interruptible : docker stop répond immédiatement

  NOW=$(stamp)
  if [ "$NOW" != "$LAST" ]; then
    LAST="$NOW"
    if [ "$NOW" != "none" ]; then
      log "↻ restart.txt modifié ($NOW) → redémarrage d'Express"
      stop_node
      try_start
      continue
    fi
  fi

  if [ -z "$PID" ]; then          # en attente de fichiers
    try_start
    continue
  fi

  if ! kill -0 "$PID" 2>/dev/null; then
    wait "$PID" 2>/dev/null; CODE=$?
    log "✖ Express s'est arrêté (code $CODE) → relance dans ${CRASH_DELAY}s (détail : docker compose logs lobby / onglet Logs de Dockhand)"
    PID=""
    sleep "$CRASH_DELAY" &
    wait $!
    try_start
  fi
done
