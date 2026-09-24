const express = require('express');
const app = express();
const http = require('http').createServer(app);
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
// FIX DOCKER : chemin de la base configurable par variable d'environnement.
// Sur o2switch (sans variable) : comportement inchangé ('./chat.db').
// Dans Docker : DB_PATH=/data/chat.db → la base survit aux redéploiements
// (volume persistant), voir docker/DEPLOY_DOCKER.md.
const db = new sqlite3.Database(process.env.DB_PATH || './chat.db');

// ==========================================
// MOTEUR DE LOGS CENTRALISÉ
// ==========================================
// ==========================================
// MOTEUR DE LOGS CENTRALISÉ — FIX PERF (sept. 2026)
// ==========================================
// ⚠️ L'ancienne version utilisait fs.appendFileSync : un appel SYNCHRONE qui
// BLOQUE tout Node.js à chaque écriture. Avec 4 à 5 lignes de log par
// game:event et des events temps réel (WARP_SYNC/WARP_INPUT) à 10-20 par
// seconde et par joueur, le serveur passait son temps le nez dans le disque :
// latence ajoutée à TOUS les clients, toutes rooms confondues — et en
// long-polling (o2switch), chaque requête HTTP attend ce event loop bloqué.
// C'était probablement LA cause serveur des saccades/micro-coupures.
//
// → Écriture désormais ASYNCHRONE (flux) + les events haute fréquence ne sont
//   plus logués. Pour retrouver le debug complet (à ne JAMAIS laisser en
//   production) : démarrer avec  LOG_VERBOSE=1 node server.js
const LOG_VERBOSE = process.env.LOG_VERBOSE === '1';
const LOG_PATH = path.join(__dirname, 'public', 'debug.txt');
fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
// Événements temps réel à ne JAMAIS logger par défaut (plusieurs dizaines/s) :
const HIGH_FREQ_EVENTS = ['WARP_SYNC', 'WARP_INPUT', 'WARP_POWER_ACTIVATED'];

function logToFile(msg) {
    const time = new Date().toISOString();

    // Si le message est un objet ou une erreur, on le transforme en texte lisible
    let formattedMsg = msg;
    if (typeof msg === 'object') {
        formattedMsg = JSON.stringify(msg, null, 2);
    }

    // FIX PERF : écriture asynchrone, le event loop reste libre pour les sockets
    logStream.write(`[${time}] ${formattedMsg}\n`);

    // Optionnel : On garde l'affichage dans le terminal o2switch pour le voir en direct
    console.log(`[${time}] ${formattedMsg}`);
}

logToFile("=========================================");
logToFile("🚀 DÉMARRAGE DU SERVEUR MULTIJEUX");
logToFile("=========================================");

// 1. On importe le module externe Bibiplay
const registerBibiplayEvents = require('./server-bibiplay');

// 2. Le Registre des logiques de jeux (Anti-Triche et API)
const gameServerModules = {}; 
const gamesDir = path.join(__dirname, 'public', 'games');

// Processus technique : 
// Au démarrage, on scanne les dossiers des jeux. Si un jeu possède un fichier 'server.js',
// on le charge en mémoire pour l'utiliser lors des requêtes 'game:event'.
if (fs.existsSync(gamesDir)) {
  fs.readdirSync(gamesDir).forEach(folder => {
    const gameLogicPath = path.join(gamesDir, folder, 'server.js');
    if (fs.existsSync(gameLogicPath)) {
      const gameModule = require(gameLogicPath);
      gameServerModules[folder] = gameModule;
      logToFile(`🛡️ Module serveur (Anti-Triche) chargé pour le jeu : ${folder}`);
      
      // Si le jeu possède une API (comme tes stats), on l'initialise ici
      if (typeof gameModule.initAPI === 'function') {
          gameModule.initAPI(app);
          logToFile(`📊 API de Statistiques activée pour le jeu : ${folder}`);
      }
    }
  });
} else {
    logToFile(`⚠️ Attention : Le dossier ${gamesDir} n'existe pas.`);
}

const adminSessions = new Map(); // roomId → { userId, lastPing, warned20s: false, pseudo }
const USER_TIMEOUT   = 30000;    // 30s
const WARNING_TIME   = 20000;    // 20s
const PING_INTERVAL  = 5000;     // check toutes les 5s

// ==========================================
// CONFIGURATION SOCKET.IO (polling STRICT)
// ==========================================
const io = new Server(http, {
  cors: {
    origin: ['https://billiar.info', 'https://test.billiar.info', 'https://insiders.billiar.info', 'https://multi.billiar.info'],
    methods: ['GET', 'POST'],
    credentials: false
  },
    // 👉 FIX : WebSocket proposé d'abord, repli AUTOMATIQUE sur le Polling.
  //    - Sur o2switch mutualisé (proxy sans « Upgrade ») : les clients
  //      retombent seuls sur polling, exactement comme avant, sans erreur.
  //    - Si ce fichier est déplacé (VPS, Northflank, Render, Oracle, local
  //      + Cloudflare Tunnel…) : le WebSocket s'active TOUT SEUL, aucun
  //      changement de code nécessaire. Le jeu détecte le transport réel
  //      côté client et adapte son netcode (voir index.html).
  transports: ['websocket', 'polling'],
  
  // 👉 On ajuste les délais pour éviter que les requêtes ne s'accumulent
  pingInterval: 10000, // Le serveur demande des nouvelles toutes les 10s (au lieu de 25s)
  pingTimeout: 15000,   // Le client a 15s pour répondre avant d'être déconnecté
  
  // 👉 On garde le bouclier anti-corruption
  perMessageDeflate: false,
  httpCompression: false,
  connectTimeout: 10000,
  reconnection: true,           // active la reconnexion auto
  reconnectionAttempts: 10,     // max 10 tentatives
  reconnectionDelay: 1000,      // départ : 1s
  reconnectionDelayMax: 5000,   // max : 5s
  randomizationFactor: 0.5      // jitter pour éviter la synchro
});

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room TEXT,
    pseudo TEXT,
    message TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.removeHeader('Cross-Origin-Embedder-Policy');
  res.removeHeader('Cross-Origin-Opener-Policy');
  next();
});

// ── API games ─────────────────────────────────────
app.get('/api/games', (req, res) => {
  const gamesDir = path.join(__dirname, 'public', 'games'); 
  
  const games = [];
  if (fs.existsSync(gamesDir)) {
    fs.readdirSync(gamesDir).forEach(folder => {
      const gamePath = path.join(gamesDir, folder);
      if (fs.statSync(gamePath).isDirectory()) {
        const hasHtml  = fs.existsSync(path.join(gamePath, 'index.html'));
        const hasPhp   = fs.existsSync(path.join(gamePath, 'index.php'));
        const hasLogo  = fs.existsSync(path.join(gamePath, 'logo.png'));
        
        if (hasHtml || hasPhp) {
          games.push({
            id: folder,
            name: folder.replace(/[-_]/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
            path: `games/${folder}/${hasHtml ? 'index.html' : 'index.php'}`,
            hasLogo,
            logoPath: hasLogo ? `games/${folder}/logo.png` : null
          });
        }
      }
    });
  }
  res.json(games);
});

const userMap = new Map();           // socket.id → { pseudo, roomId, userId, lastPing }
const gameStateByRoom = {};          // roomId → { adminUserId, players, phase, scores, currentGame? }

function pseudoExistsInRoom(roomId, pseudo, userId) {
  return Array.from(userMap.values())
    .some(u => u.roomId === roomId && u.pseudo === pseudo && u.userId !== userId);
}

function updateUserList(roomId) {
  const users = Array.from(userMap.values())
    .filter(u => u.roomId === roomId)
    .map(u => u.pseudo);
  io.to(roomId).emit('user-list', Array.from(new Set(users)));
}

// ==========================================
// NETTOYEUR DE FANTÔMES (CRON)
// ==========================================
setInterval(() => {
  const now = Date.now();
  for (const [sid, u] of userMap) {
    if (u.lastPing && now - u.lastPing > 30000) {
        
      const clientSocket = io.sockets.sockets.get(sid);
      
      if (!clientSocket || !clientSocket.connected) {
          logToFile(`🧹 Nettoyage : Le joueur ${u.pseudo} (Room: ${u.roomId}) a été déconnecté pour inactivité.`);
          userMap.delete(sid);
          if (u.roomId) updateUserList(u.roomId);
      } else {
          // Onglet en veille, on pardonne
          u.lastPing = now;
      }
    }
  }
}, 10000);

// ==========================================
// CRON ADMIN TIMEOUT
// ==========================================
setInterval(() => {
  const now = Date.now();
  for (const [roomId, adminData] of adminSessions) {
    const elapsed = now - adminData.lastPing;
    const roomUsers = Array.from(userMap.values()).filter(u => u.roomId === roomId);
    const adminConnected = roomUsers.some(u => u.userId === adminData.userId);

    if (!adminConnected) {
      if (elapsed > USER_TIMEOUT) {
        if (roomUsers.length > 0) {
          const newAdmin = roomUsers[0];
          adminSessions.set(roomId, {
            userId: newAdmin.userId,
            lastPing: now,
            warned20s: false,
            pseudo: newAdmin.pseudo
          });
          gameStateByRoom[roomId].adminUserId = newAdmin.userId;
          logToFile(`👑 Transfert Admin auto dans ${roomId} : ${newAdmin.pseudo} devient le chef.`);

          io.to(roomId).emit('admin-changed', {
            adminUserId: newAdmin.userId,
            adminPseudo: newAdmin.pseudo,
            reason: 'timeout'
          });
        } else {
          logToFile(`🛑 Fermeture de la room ${roomId} (vide).`);
          adminSessions.delete(roomId);
          delete gameStateByRoom[roomId];
        }
      }
      else if (elapsed > WARNING_TIME && !adminData.warned20s) {
        adminData.warned20s = true;
        const entry = Array.from(userMap.entries()).find(([_, u]) =>
          u.userId === adminData.userId && u.roomId === roomId
        );
        if (entry) {
          io.to(entry[0]).emit('admin-warning', {
            message: 'Vous allez perdre vos droits admin dans 10s !',
            timeLeft: 10000
          });
        }
      }
    } else {
      adminData.lastPing = now;
      adminData.warned20s = false;
    }
  }
}, PING_INTERVAL);

// ==========================================
// CONNEXIONS DES CLIENTS
// ==========================================
io.on('connection', (socket) => {
  let currentRoom = null;
  let currentPseudo = null;
  let currentUserId = null;
  logToFile(`🔌 [RESEAU] Nouvelle connexion physique établie (ID: ${socket.id})`);
  registerBibiplayEvents(socket, logToFile); 
  
  // 👉 Événement global et dynamique pour les jeux
    socket.on('game:event', ({ roomId, type, payload }) => {
      
      // FIX PERF : les events haute fréquence (WARP_SYNC/WARP_INPUT, 10-20/s
      // par joueur) ne sont plus logués — ils saturaient le disque et le
      // event loop. LOG_VERBOSE=1 pour tout revoir en debug.
      const quiet = HIGH_FREQ_EVENTS.includes(type);
      
      if (!quiet) {
          logToFile(`\n--- RECEPTION game:event ---`);
          logToFile(`Type: ${type} | Room: ${roomId}`);
      }
      
      if (!roomId || !type) return logToFile(`❌ Rejeté : roomId ou type manquant.`);

      // FIX PERF : anti-flood du relais (300 msg/s max par socket). Protège
      // l'hébergement mutualisé et les autres rooms d'un client qui émet trop
      // vite (bug ou triche). Au-delà, les messages sont silencieusement jetés.
      const nowMs = Date.now();
      if (!socket.data.rate || nowMs - socket.data.rate.t > 1000) socket.data.rate = { n: 0, t: nowMs };
      if (++socket.data.rate.n > 300) return;

      // Sécurité : on récupère le joueur, mais on ne bloque plus si l'annonce a 1ms de retard
      const user = userMap.get(socket.id) || { pseudo: 'Inconnu' };
      const state = gameStateByRoom[roomId];

      // FIX ROSTER : chaque iframe de jeu envoie REQUEST_SYNC à son chargement.
      // Si les announce-user du parent ont eu lieu AVANT (cas normal), l'event
      // 'game-players' a été émis dans le vide → le jeu ne connaît pas le roster
      // (partie fantôme au lancement). On renvoie la liste au DEMANDEUR uniquement
      // (pas de spam du salon, aucun impact sur les autres jeux).
      if (type === 'REQUEST_SYNC' && state && Array.isArray(state.players)) {
        socket.emit('game-players', state.players);
      }

      // 1. Tenter d'exécuter la logique serveur s'il y a un module anti-triche
      if (state && state.currentGame) {
          const gameLogic = gameServerModules[state.currentGame];
          if (gameLogic && typeof gameLogic[type] === 'function') {
              if (!quiet) logToFile(`✅ Succès : L'action '${type}' est gérée par le module du jeu !`);
              gameLogic[type]({ io, socket, roomId, user, state, payload });
          }
      }

      // 2. Relais systématique au salon
      if (!quiet) logToFile(`➡️ Relais de l'action '${type}' à la room ${roomId}.`);
      //socket.to(roomId).emit('game:update', { type, payload, from: user.pseudo }); // mode brodcast sans l'emmeteur
      io.to(roomId).emit('game:update', { type, payload, from: user.pseudo }); // mode echo -> tous
  });
  
  // 👉 Événement global et dynamique pour les jeux
    socket.on('game:broadcast', ({ roomId, type, payload }) => {
      
      // FIX PERF : mêmes garde-fous que game:event (logs filtrés + anti-flood)
      const quiet = HIGH_FREQ_EVENTS.includes(type);
      
      if (!quiet) {
          logToFile(`\n--- RECEPTION game:broadcast ---`);
          logToFile(`Type: ${type} | Room: ${roomId}`);
      }
      
      if (!roomId || !type) return logToFile(`❌ Rejeté : roomId ou type manquant.`);

      const nowMs = Date.now();
      if (!socket.data.rate || nowMs - socket.data.rate.t > 1000) socket.data.rate = { n: 0, t: nowMs };
      if (++socket.data.rate.n > 300) return;

      // Sécurité : on récupère le joueur, mais on ne bloque plus si l'annonce a 1ms de retard
      const user = userMap.get(socket.id) || { pseudo: 'Inconnu' };
      const state = gameStateByRoom[roomId];

      // 1. Tenter d'exécuter la logique serveur s'il y a un module anti-triche
      if (state && state.currentGame) {
          const gameLogic = gameServerModules[state.currentGame];
          if (gameLogic && typeof gameLogic[type] === 'function') {
              if (!quiet) logToFile(`✅ Succès : L'action '${type}' est gérée par le module du jeu !`);
              gameLogic[type]({ io, socket, roomId, user, state, payload });
          }
      }

      // 2. Relais systématique au salon
      // On utilise socket.to() pour envoyer à tout le monde SAUF l'émetteur
      if (!quiet) logToFile(`➡️ Relais de l'action '${type}' à la room ${roomId}.`);
      socket.to(roomId).emit('game:update', { type, payload, from: user.pseudo }); // mode broadcast sans l'emmeteur
  });

  socket.on('join-room', (roomId) => {
    if (currentRoom && currentRoom !== roomId) socket.leave(currentRoom);
    currentRoom = roomId;
    socket.join(roomId);
	logToFile(`📥 [RESEAU] Le socket ${socket.id} est bien entré dans la room ${roomId}`);
	
    db.all('SELECT * FROM messages WHERE room = ? ORDER BY id ASC', [roomId],
      (err, rows) => { if (!err) socket.emit('history', rows); }
    );

    updateUserList(roomId);

    if (!gameStateByRoom[roomId]) {
      gameStateByRoom[roomId] = { adminUserId: null, players: [], phase: 'waiting', scores: [] };
    }
  });

  socket.on('clear-chat', ({ roomId }) => {
      logToFile(`🗑️ Le chat de la room ${roomId} a été vidé par l'admin.`);
      db.all('DELETE FROM messages WHERE room = ? ORDER BY id ASC', [roomId],
      (err, rows) => { if (!err) socket.emit('history', rows); }
        );
      io.to(roomId).emit('chat-cleared');
  });

  socket.on('admin-ping', ({ roomId, userId }) => {
    const admin = adminSessions.get(roomId);
    if (admin && admin.userId === userId) {
      admin.lastPing = Date.now();
      admin.warned20s = false;
    }
  });

  socket.on('announce-user', ({ pseudo, roomId, userId }) => {
    if (pseudoExistsInRoom(roomId, pseudo, userId)) {
      socket.emit('pseudo-taken', pseudo);
      return;
    }

    currentPseudo = pseudo;
    currentRoom = roomId;
    currentUserId = userId;

    userMap.set(socket.id, { pseudo, roomId, userId, lastPing: Date.now() });

    let adminData = adminSessions.get(roomId);
    const roomUsers = Array.from(userMap.values()).filter(u => u.roomId === roomId);

    if (!adminData || !roomUsers.some(u => u.userId === adminData.userId)) {
      adminData = { userId, lastPing: Date.now(), warned20s: false, pseudo };
      adminSessions.set(roomId, adminData);
      logToFile(`👑 Nouvel Admin pour ${roomId} : ${pseudo}`);
      io.to(roomId).emit('admin-changed', {
        adminUserId: userId,
        adminPseudo: pseudo,
        reason: 'new'
      });
    }

    if (!gameStateByRoom[roomId]) {
      gameStateByRoom[roomId] = { adminUserId: adminData.userId, players: [], phase: 'waiting', scores: [] };
    }
    gameStateByRoom[roomId].adminUserId = adminData.userId;

    if (!gameStateByRoom[roomId].players.includes(pseudo))
      gameStateByRoom[roomId].players.push(pseudo);

    const sysMsg = `${pseudo} a rejoint le salon.`;
    db.run('INSERT INTO messages (room, pseudo, message) VALUES (?, ?, ?)', [roomId, '', sysMsg]);
    socket.to(roomId).emit('system-message', sysMsg);

    updateUserList(roomId);

    if (gameStateByRoom[roomId]?.currentGame) {
      socket.emit('game-started', { game: gameStateByRoom[roomId].currentGame });
    }

    socket.emit('admin-status', {
      isAdmin: adminData.userId === userId,
      adminUserId: adminData.userId,
      adminPseudo: adminData.pseudo
    });

    if (gameStateByRoom[roomId].currentGame) {
      socket.emit('game-selected', { game: gameStateByRoom[roomId].currentGame });
    }

    io.to(roomId).emit('game-admin', { adminUserId: adminData.userId });
    io.to(roomId).emit('game-players', gameStateByRoom[roomId].players);
  });

  socket.on('transfer-admin', ({ roomId, newAdminUserId }) => {
    const admin = adminSessions.get(roomId);
    if (!admin || admin.userId !== currentUserId) return;

    const roomUsers = Array.from(userMap.values()).filter(u => u.roomId === roomId);
    const target = roomUsers.find(u => u.userId === newAdminUserId);
    if (!target) return;

    adminSessions.set(roomId, {
      userId: newAdminUserId,
      lastPing: Date.now(),
      warned20s: false,
      pseudo: target.pseudo
    });

    gameStateByRoom[roomId].adminUserId = newAdminUserId;
    logToFile(`👑 Admin transféré dans ${roomId} : de ${currentPseudo} à ${target.pseudo}`);

    io.to(roomId).emit('admin-changed', {
      adminUserId: newAdminUserId,
      adminPseudo: target.pseudo,
      reason: 'transferred'
    });

    socket.emit('admin-transferred-ok');
  });

  socket.on('chat message', ({ pseudo, message, roomId }) => {
    if (!pseudo || !message || !roomId) return;
    db.run('INSERT INTO messages (room, pseudo, message) VALUES (?, ?, ?)', [roomId, pseudo, message]);
    io.to(roomId).emit('chat message', { pseudo, message, timestamp: new Date().toISOString() });
  });

  socket.on('player-score', ({ roomId, pseudo, score }) => {
    const state = gameStateByRoom[roomId];
    if (!state) return;

    if (!state.scores) state.scores = [];
    if (state.scores.some(r => r.pseudo === pseudo)) return;

    state.scores.push({ pseudo, score });

    if (state.scores.length === state.players.length) {
      const results = state.scores;
      const winner = results.reduce((a, b) => a.score > b.score ? a : b, results[0]);

      io.to(roomId).emit('game-end', { results, winner });

      const txt = 'Classement final :\n' +
        results.sort((a,b)=>b.score-a.score)
               .map((r,i) => `${i+1}. ${r.pseudo} (${r.score} pts)`)
               .join('\n');

      db.run('INSERT INTO messages (room, pseudo, message) VALUES (?, ?, ?)', [roomId, '', txt]);
      io.to(roomId).emit('system-message', txt);
      state.phase = 'results';
      logToFile(`🏁 Fin de partie dans ${roomId}. Gagnant: ${winner.pseudo} avec ${winner.score} pts.`);
    }
  });

  socket.on('disconnect', () => {
    if (!userMap.has(socket.id)) return;
    const { pseudo, roomId, userId } = userMap.get(socket.id);
    userMap.delete(socket.id);

    if (roomId) {
      updateUserList(roomId);

      const state = gameStateByRoom[roomId];
      if (state) {
        state.players = state.players.filter(p => p !== pseudo);
      }

      const admin = adminSessions.get(roomId);
      if (admin && admin.userId === userId) {
        logToFile(`⚠️ Admin ${pseudo} s'est déconnecté → Période de grâce de 30s lancée.`);
      }
    }
  });
  
  socket.on('user-ping', ({ roomId, userId }) => {
      if (userMap.has(socket.id)) {
        userMap.get(socket.id).lastPing = Date.now();
      }
  });

  socket.on('start-game', ({ roomId, game }) => {
      const u = userMap.get(socket.id);
      if (!u) return;

      const admin = adminSessions.get(roomId);
      if (!admin || admin.userId !== u.userId) {
        logToFile(`❌ Tentative de lancement refusée: ${u.pseudo} n'est pas admin dans ${roomId}.`);
        return;
      }

      logToFile(`🚀 Lancement du jeu ${game} par ${u.pseudo} dans la room ${roomId}`);

      gameStateByRoom[roomId].phase = 'playing';
      gameStateByRoom[roomId].currentGame = game;

      io.to(roomId).emit('game-started', { game });
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  logToFile(`✅ Serveur lobby multijeux lancé et en écoute sur le port ${PORT}`);
});