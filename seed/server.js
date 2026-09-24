// ============================================================
//  server.js — SERVEUR MULTIJOUEUR GÉNÉRIQUE (version légère)
// ------------------------------------------------------------
//  Rôle : servir le dossier public/ et RELAYER les messages
//  entre joueurs. Il ne connaît AUCUNE règle de jeu : c'est le
//  jeu (côté navigateur) qui décide quoi envoyer.
//
//  ✔ Toute personne qui ouvre la page est un joueur.
//  ✔ Room commune par défaut ("commune") ; un jeu peut en
//    demander une autre :  io({ query: { room: 'ma-partie' } })
//  ✔ Un « hôte » par room = le joueur présent depuis le plus
//    longtemps. S'il part, le suivant prend le relais.
//    (Utile pour l'arbitrage : qui fait apparaître les objets,
//     qui valide les points… sans logique côté serveur.)
//
//  ─── API Socket.IO ──────────────────────────────────────────
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
//    game:event     data  → relayé à TOUTE la room, expéditeur compris
//                           (reçu en « game:update »)
//    game:broadcast data  → relayé aux AUTRES seulement
//                           (reçu en « game:broadcast »)
//    game:to        (idJoueur, data)  → à UN joueur précis
//                           (reçu en « game:direct »)
//
//  ─── HTTP ───────────────────────────────────────────────────
//    /            → public/index.html (le mini-jeu de démo)
//    /health      → état JSON (rooms, joueurs) pour supervision
//
//  Variables d'environnement :
//    PORT             (3000)
//    ALLOWED_ORIGINS  domaines autorisés à se connecter depuis une
//                     AUTRE origine (ex. le site parent qui intègre
//                     le jeu), séparés par des virgules.
// ============================================================
'use strict';

const path    = require('path');
const http    = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 3000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://billiar.info,https://www.billiar.info,https://test.billiar.info,' +
  'https://insiders.billiar.info,https://multi.billiar.info')
  .split(',').map(s => s.trim()).filter(Boolean);

const DEFAULT_ROOM   = 'commune';
const MAX_MSG_PER_S  = 60;        // anti-flood : messages / seconde / joueur
const MAX_PAYLOAD    = 16 * 1024; // 16 Ko max par message

// ---------- Express : fichiers statiques ----------
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// ---------- État en mémoire ----------
// rooms : nomRoom → Map(idSocket → joueur)
// (l'ordre d'insertion de la Map = ordre d'arrivée → sert à élire l'hôte)
const rooms = new Map();
const hosts = new Map();          // nomRoom → id de l'hôte

app.get('/health', (req, res) => {
  const detail = {};
  for (const [name, players] of rooms) detail[name] = players.size;
  res.json({ ok: true, uptime: Math.round(process.uptime()), rooms: detail });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS, credentials: true },
  maxHttpBufferSize: MAX_PAYLOAD,
  transports: ['websocket', 'polling'],  // WebSocket d'abord (Caddy le gère)
  pingInterval: 10000,
  pingTimeout: 8000,
});

// ---------- Utilitaires ----------
const COLORS = ['#ff5d73', '#4dd7ff', '#ffd23f', '#7cff6b', '#c38bff',
                '#ff9f43', '#2ee6a6', '#ff6bd6', '#6b8cff', '#e6e6e6'];

function clean(str, max) {           // texte sûr et court (anti-injection HTML)
  return String(str ?? '').replace(/[<>&"'`]/g, '').trim().slice(0, max);
}

function publicPlayer(p) {           // ce que les autres voient d'un joueur
  return { id: p.id, name: p.name, color: p.color, joinedAt: p.joinedAt };
}

function electHost(room) {
  const players = rooms.get(room);
  const first = players && players.size ? players.keys().next().value : null;
  if (hosts.get(room) !== first) {
    if (first) hosts.set(room, first); else hosts.delete(room);
    if (first) io.to(room).emit('room:host', { hostId: first });
    log(`👑 hôte de « ${room} » : ${first ? players.get(first).name : '(room vide)'}`);
  }
}

function log(msg) {
  console.log(`[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] ${msg}`);
}

// ---------- Connexions ----------
io.on('connection', (socket) => {
  const room = clean(socket.handshake.query.room, 40) || DEFAULT_ROOM;
  if (!rooms.has(room)) rooms.set(room, new Map());
  const players = rooms.get(room);

  const player = {
    id: socket.id,
    name: clean(socket.handshake.query.name, 20) || `Joueur-${socket.id.slice(0, 4)}`,
    color: COLORS[players.size % COLORS.length],
    joinedAt: Date.now(),
  };
  players.set(socket.id, player);
  socket.join(room);
  log(`➕ ${player.name} rejoint « ${room} » (${players.size} joueur(s))`);

  // 1) Accueil du nouveau : qui il est + qui est déjà là
  electHost(room);
  socket.emit('room:welcome', {
    room,
    you: publicPlayer(player),
    players: [...players.values()].map(publicPlayer),
    hostId: hosts.get(room),
  });
  // 2) Annonce aux autres
  socket.to(room).emit('room:player-joined', { player: publicPlayer(player) });

  // ---- Anti-flood simple (fenêtre d'une seconde) ----
  let windowStart = Date.now(), count = 0;
  function allowed() {
    const now = Date.now();
    if (now - windowStart > 1000) { windowStart = now; count = 0; }
    return ++count <= MAX_MSG_PER_S;
  }

  // ---- Profil ----
  socket.on('player:update', (data = {}) => {
    if (!allowed()) return;
    if (data.name)  player.name  = clean(data.name, 20) || player.name;
    if (data.color && /^#[0-9a-f]{6}$/i.test(data.color)) player.color = data.color;
    io.to(room).emit('room:player-updated', { player: publicPlayer(player) });
  });

  // ---- Relais génériques ----
  socket.on('game:event', (data) => {          // à tous, moi compris
    if (!allowed()) return;
    io.to(room).emit('game:update', { from: socket.id, data });
  });

  socket.on('game:broadcast', (data) => {      // aux autres
    if (!allowed()) return;
    socket.to(room).emit('game:broadcast', { from: socket.id, data });
  });

  socket.on('game:to', (targetId, data) => {   // à un seul joueur de la room
    if (!allowed() || !players.has(targetId)) return;
    io.to(targetId).emit('game:direct', { from: socket.id, data });
  });

  // ---- Départ ----
  socket.on('disconnect', (reason) => {
    players.delete(socket.id);
    io.to(room).emit('room:player-left', { id: socket.id });
    log(`➖ ${player.name} quitte « ${room} » (${reason}) — reste ${players.size}`);
    if (players.size === 0) { rooms.delete(room); hosts.delete(room); }
    else electHost(room);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  log(`🚀 Serveur multijoueur générique en écoute sur le port ${PORT}`);
  log(`   Origines autorisées : ${ALLOWED_ORIGINS.join(', ')}`);
});

// Arrêt propre (restart.txt / docker stop envoient SIGTERM)
process.on('SIGTERM', () => {
  log('■ arrêt demandé, fermeture des connexions…');
  io.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
});
