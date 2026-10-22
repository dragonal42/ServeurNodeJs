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
      terrain: room.terrain, state: room.state, move, ranked: room.ranked
    });
  }

  function begin(room, terrain) {
    const generated = E.generateBoard(terrain);
    room.state = E.newGame(generated.board);
    room.terrain = generated.terrain;
    room.gameId = randomUUID();
    room.revision++;
    room.positions = new Map([[E.positionKey(room.state), 1]]);
    room.ranked = false;
    room.moves = [0, 0];
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
    room.players.delete(socket.id);
    socket.leave(room.code);
    delete socket.data.tragameRoom;
    if (!room.players.size) { rooms.delete(room.code); return; }
    if (room.hostId === socket.id) room.hostId = room.players.keys().next().value;
    // Une partie interrompue n'est jamais reprise avec un nouveau joueur.
    room.state = null;
    room.revision++;
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

    action('room:join', (data, reply) => {
      if (socket.data.tragameRoom) return reply({ error: 'Quittez votre salle avant de rejoindre une autre.' });
      const pseudo = cleanPseudo(data.pseudo);
      if (!pseudo) return reply({ error: 'Indiquez votre pseudo.' });
      let code = roomCode(data.room);
      if (!code) do { code = randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(code));
      if (!/^[A-Z0-9]{3,12}$/.test(code)) return reply({ error: 'Code de salle : 3 a 12 lettres ou chiffres.' });
      let room = rooms.get(code);
      if (room?.players.size >= 2) return reply({ error: 'Salle pleine.' });
      if (room && [...room.players.values()].some(p => p.pseudo === pseudo))
        return reply({ error: 'Ce pseudo est deja utilise dans la salle.' });
      if (!room) {
        if (rooms.size >= 200) return reply({ error: 'Serveur complet.' });
        room = { code, players: new Map(), hostId: socket.id, revision: 0, state: null,
          terrain: Object.hasOwn(E.TERRAINS, data.terrain) ? data.terrain : 'random', gameId: null, ranked: false };
        rooms.set(code, room);
      }
      const wanted = data.side === 2 ? 2 : 1;
      const seat = [...room.players.values()].some(p => p.seat === wanted) ? 3 - wanted : wanted;
      room.players.set(socket.id, { id: socket.id, pseudo, seat });
      socket.data.tragameRoom = code;
      socket.join(code);
      reply({ room: code, seat });
      if (room.players.size === 2) begin(room, room.terrain);
      else snapshot(room);
    });

    action('game:start', (data, reply) => {
      const room = rooms.get(socket.data.tragameRoom);
      if (!room || room.hostId !== socket.id) return reply({ error: 'Seul le createur peut relancer.' });
      if (room.players.size !== 2) return reply({ error: 'Attendez un adversaire.' });
      if (data.terrain !== 'random' && !Object.hasOwn(E.TERRAINS, data.terrain))
        return reply({ error: 'Terrain inconnu.' });
      begin(room, data.terrain);
      reply({ ok: true });
    });

    action('game:move', (data, reply) => {
      const room = rooms.get(socket.data.tragameRoom);
      const player = room?.players.get(socket.id);
      if (!player || room.players.size !== 2 || !room.state || room.state.gameOver)
        return reply({ error: 'Partie indisponible.' });
      if (data.gameId !== room.gameId || data.revision !== room.revision)
        return reply({ error: 'Ce coup concerne un ancien etat.' });
      if (room.state.turn !== player.seat) return reply({ error: 'Ce n’est pas votre tour.' });
      // Les clients transmettent seulement une destination. Le serveur recalcule capture et points.
      const move = E.legalMoves(room.state).find(m => m.id === data.id && m.r === data.r && m.c === data.c);
      if (!move) return reply({ error: 'Coup illegal.' });
      room.state = E.applyMove(room.state, move);
      room.moves[player.seat - 1]++;
      remember(room);
      // Chaque passe compte dans les 200 coups et dans la repetition des positions.
      while (!room.state.gameOver && !E.legalMoves(room.state).length) {
        room.state = E.passTurn(room.state);
        remember(room);
      }
      room.revision++;
      snapshot(room, move);
      reply({ ok: true });
      if (room.state.gameOver) {
        const gameId = room.gameId;
        const write = scores.saveGame(gameId, [...room.players.values()], room.state, [...room.moves]).then(() => {
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
