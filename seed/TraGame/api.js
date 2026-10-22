'use strict';

const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const E = require('./public/engine');
const { openScores } = require('./scores');

const cleanPseudo = value => typeof value === 'string'
  ? value.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 30) : '';
const roomCode = value => typeof value === 'string' ? value.trim().toUpperCase() : '';
let shutdown;

async function register(app, ctx) {
  const io = ctx.io;
  const scores = await openScores(path.resolve(ctx.dossierPath, '..', 'data', 'tragame-scores.db'));
  const rooms = new Map();
  const pendingWrites = new Set();
  const report = error => ctx.log(`Erreur TraGame : ${error.message}`);

  app.get('/leaderboard', async (request, reply) => {
    try { return await scores.list(); }
    catch (error) { report(error); return reply.code(500).send({ error: 'Classement indisponible.' }); }
  });

  function snapshot(room, move = null) {
    io.to(room.code).emit('game:state', {
      room: room.code, gameId: room.gameId, revision: room.revision,
      players: [...room.players.values()], hostId: room.hostId,
      phase: room.phase, challengerId: room.challengerId, duelIds: room.duelIds,
      rematchReady: [...room.rematchReady], nextHostSeat: room.nextHostSeat,
      terrain: room.terrain, state: room.state, move, history: room.history, ranked: room.ranked
    });
  }

  function assignDuel(room) {
    for (const player of room.players.values()) player.seat = 0;
    room.duelIds = [room.hostId, room.challengerId];
    room.players.get(room.hostId).seat = room.nextHostSeat;
    room.players.get(room.challengerId).seat = 3 - room.nextHostSeat;
  }

  function resetLobby(room) {
    room.phase = 'lobby';
    room.challengerId = null;
    room.duelIds = [];
    room.rematchReady.clear();
    room.state = null;
    room.gameId = null;
    room.history = [];
    room.ranked = false;
    room.revision++;
    for (const player of room.players.values()) player.seat = 0;
  }

  function begin(room, terrain) {
    const generated = E.generateBoard(terrain);
    assignDuel(room);
    room.phase = 'playing';
    room.rematchReady.clear();
    room.state = E.newGame(generated.board);
    room.terrain = generated.terrain;
    room.gameId = randomUUID();
    room.revision++;
    room.positions = new Map([[E.positionKey(room.state), 1]]);
    room.ranked = false;
    room.moves = [0, 0];
    room.history = [];
    snapshot(room);
  }

  function remember(room) {
    const key = E.positionKey(room.state);
    const count = (room.positions.get(key) || 0) + 1;
    room.positions.set(key, count);
    if (!room.state.gameOver && count >= 3)
      Object.assign(room.state, { gameOver: true, winner: 0, reason: 'Triple repetition' });
  }

  function leave(socket) {
    const room = rooms.get(socket.data.tragameRoom);
    if (!room) return;
    const inDuel = room.duelIds.includes(socket.id);
    const wasHost = room.hostId === socket.id;
    room.players.delete(socket.id);
    socket.leave(room.code);
    delete socket.data.tragameRoom;
    if (!room.players.size) { rooms.delete(room.code); return; }
    if (wasHost) {
      room.hostId = room.players.keys().next().value;
      room.nextHostSeat = 1;
    }
    // Le depart d'un spectateur ne touche jamais au duel en cours.
    if (inDuel || wasHost) resetLobby(room);
    snapshot(room);
  }

  function connected(socket) {
    let windowStart = Date.now(), messages = 0;
    function action(name, handler) {
      socket.on(name, (raw, ack) => {
        const reply = typeof ack === 'function' ? ack : () => {};
        if (Date.now() - windowStart > 1000) { windowStart = Date.now(); messages = 0; }
        if (++messages > 20) return reply({ error: 'Trop de demandes.' });
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return reply({ error: 'Demande invalide.' });
        try { handler(raw, reply); }
        catch (error) { report(error); reply({ error: 'Action impossible.' }); }
      });
    }
    const currentRoom = () => rooms.get(socket.data.tragameRoom);

    action('room:join', (data, reply) => {
      if (socket.data.tragameRoom) return reply({ error: 'Quittez votre salle avant de rejoindre une autre.' });
      const pseudo = cleanPseudo(data.pseudo);
      if (!pseudo) return reply({ error: 'Indiquez votre pseudo.' });
      let code = roomCode(data.room);
      if (!code) do { code = randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(code));
      if (!/^[A-Z0-9]{3,12}$/.test(code)) return reply({ error: 'Code de salle : 3 a 12 lettres ou chiffres.' });
      let room = rooms.get(code);
      if (room?.players.size >= 50) return reply({ error: 'Salle pleine (50 participants).' });
      if (room && [...room.players.values()].some(p => p.pseudo === pseudo))
        return reply({ error: 'Ce pseudo est deja utilise dans la salle.' });
      if (!room) {
        if (rooms.size >= 200) return reply({ error: 'Serveur complet.' });
        room = { code, players: new Map(), hostId: socket.id, revision: 0, state: null,
          phase: 'lobby', challengerId: null, duelIds: [], rematchReady: new Set(), nextHostSeat: 1,
          terrain: Object.hasOwn(E.TERRAINS, data.terrain) ? data.terrain : 'random',
          gameId: null, ranked: false, history: [] };
        rooms.set(code, room);
      }
      room.players.set(socket.id, { id: socket.id, pseudo, seat: 0 });
      socket.data.tragameRoom = code;
      socket.join(code);
      reply({ room: code });
      snapshot(room);
    });

    action('room:ready', (data, reply) => {
      const room = currentRoom();
      if (!room || socket.id === room.hostId) return reply({ error: 'L’admin lance le match apres le choix d’un adversaire.' });
      if (!['lobby', 'ready'].includes(room.phase)) return reply({ error: 'Attendez la fin du match ou une nouvelle selection.' });
      if (data.ready === false) {
        if (room.challengerId !== socket.id) return reply({ error: 'Vous n’etes pas l’adversaire reserve.' });
        resetLobby(room);
      } else {
        if (room.challengerId && room.challengerId !== socket.id)
          return reply({ error: 'Un autre joueur a deja reserve la place.' });
        if (room.challengerId === socket.id) return reply({ ok: true });
        room.challengerId = socket.id;
        room.phase = 'ready';
        assignDuel(room);
      }
      snapshot(room);
      reply({ ok: true });
    });

    action('game:start', (data, reply) => {
      const room = currentRoom();
      if (!room || room.hostId !== socket.id) return reply({ error: 'Seul l’admin peut lancer le match.' });
      if (room.phase !== 'ready' || !room.players.has(room.challengerId))
        return reply({ error: 'Un adversaire doit etre pret avant le lancement.' });
      if (data.terrain !== 'random' && !Object.hasOwn(E.TERRAINS, data.terrain))
        return reply({ error: 'Terrain inconnu.' });
      begin(room, data.terrain);
      reply({ ok: true });
    });

    action('game:rematch', (data, reply) => {
      const room = currentRoom();
      if (!room || room.phase !== 'finished' || !room.duelIds.includes(socket.id))
        return reply({ error: 'La revanche est reservee aux deux joueurs du match termine.' });
      if (data.gameId !== room.gameId) return reply({ error: 'Cette demande concerne un ancien match.' });
      room.rematchReady.add(socket.id);
      if (room.rematchReady.size === 2) {
        room.phase = 'ready';
      }
      snapshot(room);
      reply({ ok: true });
    });

    action('room:reset', (data, reply) => {
      const room = currentRoom();
      if (!room || room.hostId !== socket.id) return reply({ error: 'Seul l’admin peut rouvrir la selection.' });
      if (data.confirmed !== true) return reply({ error: 'Confirmez Nouvelle partie pour annuler le match.' });
      if (data.gameId !== room.gameId) return reply({ error: 'Le match a change. Confirmez de nouveau Nouvelle partie.' });
      resetLobby(room);
      snapshot(room);
      reply({ ok: true });
    });

    action('game:move', (data, reply) => {
      const room = currentRoom();
      const player = room?.players.get(socket.id);
      if (!player || room.phase !== 'playing' || !room.duelIds.includes(socket.id) || !room.state || room.state.gameOver)
        return reply({ error: 'Seuls les deux joueurs du match peuvent jouer.' });
      if (data.gameId !== room.gameId || data.revision !== room.revision)
        return reply({ error: 'Ce coup concerne un ancien etat.' });
      if (room.state.turn !== player.seat) return reply({ error: 'Ce n’est pas votre tour.' });
      const move = E.legalMoves(room.state).find(m => m.id === data.id && m.r === data.r && m.c === data.c);
      if (!move) return reply({ error: 'Coup illegal.' });
      room.state = E.applyMove(room.state, move);
      room.moves[player.seat - 1]++;
      room.history.push({ ...move, ply: room.state.moveCount });
      remember(room);
      while (!room.state.gameOver && !E.legalMoves(room.state).length) {
        room.state = E.passTurn(room.state);
        remember(room);
      }
      room.revision++;
      if (room.state.gameOver) {
        room.phase = 'finished';
        room.nextHostSeat = 3 - room.players.get(room.hostId).seat;
      }
      snapshot(room, move);
      reply({ ok: true });
      if (room.state.gameOver) {
        const gameId = room.gameId;
        // Copier les camps avant qu'une revanche puisse les inverser.
        const contestants = room.duelIds.map(id => ({ ...room.players.get(id) }));
        const write = scores.saveGame(gameId, contestants, room.state, [...room.moves]).then(() => {
          if (room.gameId === gameId) { room.ranked = true; snapshot(room); }
          io.emit('scores:updated');
        }).catch(error => {
          report(error);
          io.to(room.code).emit('game:error', { error: 'Partie terminee, mais enregistrement des statistiques impossible.' });
        }).finally(() => pendingWrites.delete(write));
        pendingWrites.add(write);
      }
    });
    action('room:leave', (data, reply) => { leave(socket); reply({ ok: true }); });
    socket.on('disconnect', () => leave(socket));
  }

  io.on('connection', connected);
  shutdown = async () => {
    io.off('connection', connected);
    io.disconnectSockets(true);
    await Promise.allSettled([...pendingWrites]);
    await scores.close();
    rooms.clear();
  };
}

async function close() { if (shutdown) { const stop = shutdown; shutdown = null; await stop(); } }
module.exports = { register, close };
