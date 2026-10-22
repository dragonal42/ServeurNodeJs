'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');
const { once } = require('node:events');
const { io } = require('socket.io-client');
const E = require('../seed/TraGame/public/engine');
const { openScores } = require('../seed/TraGame/scores');
const root = path.resolve(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function temporaryDirectory() {
  await fs.mkdir(path.join(root, 'tmp'), { recursive: true });
  return fs.mkdtemp(path.join(root, 'tmp', 'tragame-test-'));
}

test('passes terminate at 200 moves without mutating the previous score', () => {
  const initial = { ...E.newGame(), moveCount: 199 };
  const next = E.passTurn(initial);
  assert.equal(next.moveCount, 200);
  assert.equal(next.gameOver, true);
  assert.equal(next.reason, 'Limite de coups');
  assert.equal(initial.gameOver, false);
  assert.equal(E.passTurn(next), next);
});

test('SQLite accumulates wins, games, winning moves, captures and losses exactly once', async () => {
  const directory = await temporaryDirectory();
  const filename = path.join(directory, 'records.db');
  let scores = await openScores(filename);
  try {
    const players = [{ pseudo: 'Alice', seat: 1 }, { pseudo: 'Bob', seat: 2 }];
    const state = winner => ({ gameOver: true, winner, pieces: [
      { player: 1, captured: true }, { player: 2, captured: true }, { player: 2, captured: true },
      { player: 2, captured: false, finished: true }
    ] });
    await Promise.all([
      scores.saveGame('one', players, state(1), [15, 14]),
      scores.saveGame('two', players, state(1), [9, 8]),
      scores.saveGame('three', players, state(2), [4, 5]),
      scores.saveGame('draw', players, state(0), [6, 6]),
      scores.saveGame('one', players, state(1), [15, 14])
    ]);
    let rows = await scores.list();
    assert.deepEqual(rows.map(row => [row.pseudo, row.wins, row.played, row.winning_moves_total, row.best_win_moves, row.captures, row.losses, row.rank]),
      [['Alice', 2, 4, 24, 9, 8, 4, 1], ['Bob', 1, 4, 5, 5, 4, 8, 2]]);
    // Neither half of a failed game may be recorded. The queue recovers afterwards.
    await assert.rejects(scores.saveGame('rollback', [{ pseudo: 'New', seat: 1 }, { pseudo: null, seat: 2 }], state(1), [1, 1]));
    assert(!(await scores.list()).some(row => row.pseudo === 'New'));
    await assert.rejects(scores.saveGame('unfinished', players, { ...state(1), gameOver: false }, [1, 1]));
    await scores.saveGame('rollback', [{ pseudo: 'New', seat: 1 }, { pseudo: 'Other', seat: 2 }], state(0), [1, 1]);
    assert.equal((await scores.list()).find(row => row.pseudo === 'New').best_win_moves, null);
    await scores.close();
    scores = await openScores(filename);
    rows = await scores.list();
    assert.equal(rows.length, 4);
    assert.equal(rows[0].winning_moves_total, 24);
    assert.equal(rows[0].best_win_moves, 9);
  } finally { await scores.close(); }
});

test('actual multi-site server: routes, rooms, legal moves, isolation and persistent leaderboard', { timeout: 45000 }, async () => {
  const directory = await temporaryDirectory();
  const seed = path.join(root, 'seed');
  await fs.cp(seed, directory, { recursive: true,
    filter: source => !path.relative(seed, source).split(path.sep).some(part => ['data', 'tmp', 'node_modules'].includes(part))
  });
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  let output = '';
  const server = spawn(process.execPath, [path.join(directory, 'server.js')], {
    cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_PATH: path.join(root, 'node_modules') },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  server.stdout.on('data', value => { output += value; });
  server.stderr.on('data', value => { output += value; });
  const clients = [];
  async function connect() {
    const socket = io(`${base}/TraGame`, { transports: ['websocket'], forceNew: true, reconnection: false });
    clients.push(socket);
    socket.on('game:state', state => { socket.latest = state; });
    await once(socket, 'connect');
    return socket;
  }
  const send = (socket, event, data) => new Promise((resolve, reject) => {
    socket.timeout(3000).emit(event, data, (error, response) => error ? reject(error) : resolve(response));
  });
  async function until(predicate) {
    for (let i = 0; i < 150; i++) { if (predicate()) return; await delay(20); }
    assert.fail(`Timed out. Server output:\n${output}`);
  }
  try {
    let health;
    for (let i = 0; i < 150; i++) {
      try { health = await (await fetch(`${base}/health`)).json(); break; } catch { await delay(30); }
    }
    assert(health, output);
    assert(health.sites.some(site => site.nom === 'TraGame' && site.statut === 'ok'), output);
    assert(health.sites.some(site => site.nom === 'courseetoile' && site.statut === 'ok'), output);
    for (const file of ['', 'game.js', 'engine.js', 'ai-worker.js', 'vendor/three.module.js', 'vendor/OrbitControls.js', 'vendor/tabulator.min.js', 'vendor/tabulator.min.css', 'leaderboard']) {
      assert.equal((await fetch(`${base}/TraGame/${file}`)).status, 200, file);
    }
    for (const file of ['api.js', 'scores.js', '../data/tragame-scores.db'])
      assert.equal((await fetch(`${base}/TraGame/${file}`)).status, 404, file);
    assert.deepEqual(await (await fetch(`${base}/TraGame/leaderboard`)).json(), []);
    assert.equal((await fetch(`${base}/courseetoile/`)).status, 200);
    assert.equal((await fetch(`${base}/TraGame/leaderboard`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pseudo: 'Cheat', best_score: 9999 }) })).status, 404);

    const alice = await connect(), bob = await connect(), other = await connect(), third = await connect();
    assert((await send(alice, 'room:join', { pseudo: '', room: 'ROOM1' })).error);
    assert((await send(alice, 'room:join', { pseudo: 'Alice', room: '<script>' })).error);
    assert.equal((await send(alice, 'room:join', { pseudo: 'Alice', room: 'ROOM1', side: 1, terrain: 'hell' })).seat, 1);
    assert.equal((await send(bob, 'room:join', { pseudo: 'Bob', room: 'ROOM1', side: 1 })).seat, 2);
    await until(() => alice.latest?.state && bob.latest?.state);
    assert((await send(third, 'room:join', { pseudo: 'Third', room: 'ROOM1' })).error);
    await send(other, 'room:join', { pseudo: 'Other', room: 'ROOM2' });
    await until(() => other.latest);
    assert.equal(other.latest.state, null);
    assert((await send(bob, 'game:start', { terrain: 'hell' })).error);
    assert((await send(alice, 'game:start', { terrain: '__proto__' })).error);
    const first = alice.latest;
    const valid = E.legalMoves(first.state)[0];
    assert((await send(bob, 'game:move', { ...valid, gameId: first.gameId, revision: first.revision })).error);
    assert((await send(alice, 'game:move', { id: 'p1_2', r: -1, c: 0, gameId: first.gameId, revision: first.revision })).error);
    assert((await send(alice, 'game:move', { ...valid, gameId: 'old-game', revision: first.revision })).error);

    const reds = [[9, 0], [6, 0], [3, 0], [0, 0], [-1, 0]];
    for (let index = 0; index < reds.length; index++) {
      const previous = alice.latest;
      const [r, c] = reds[index];
      const move = { id: 'p1_2', r, c, gameId: previous.gameId, revision: previous.revision,
        capture: 'p2_2', scores: [9999, 0], winner: 1 };
      assert.equal((await send(alice, 'game:move', move)).ok, true);
      await until(() => alice.latest.revision > previous.revision && bob.latest.revision === alice.latest.revision);
      assert.equal(alice.latest.state.pieces.find(p => p.id === 'p2_2').captured, false);
      if (index === 0) assert((await send(alice, 'game:move', move)).error);
      assert.equal(other.latest.state, null);
      if (index < reds.length - 1) {
        await delay(70);
        const snapshot = bob.latest;
        assert.equal((await send(bob, 'game:move', { id: 'p2_7', r: index % 2 ? 2 : 1, c: 7, gameId: snapshot.gameId, revision: snapshot.revision })).ok, true);
        await until(() => alice.latest.revision > snapshot.revision && bob.latest.revision === alice.latest.revision);
      }
      await delay(70);
    }
    assert.equal(alice.latest.state.gameOver, true);
    assert.equal(alice.latest.state.winner, 1);
    assert.equal(alice.latest.state.scores[0], 3);
    await until(() => alice.latest.ranked);
    const rows = await (await fetch(`${base}/TraGame/leaderboard`)).json();
    assert.deepEqual(rows.map(row => [row.pseudo, row.wins, row.played, row.winning_moves_total, row.best_win_moves, row.captures, row.losses]),
      [['Alice', 1, 1, 5, 5, 0, 0], ['Bob', 0, 1, 0, null, 0, 0]]);

    const oldGame = alice.latest.gameId;
    await send(alice, 'game:start', { terrain: 'hell' });
    await until(() => alice.latest.gameId !== oldGame);
    bob.disconnect();
    await until(() => alice.latest.state === null);
    assert((await send(alice, 'game:move', { ...valid, gameId: oldGame, revision: 1 })).error);
    assert.equal((await send(third, 'room:join', { pseudo: 'Third', room: 'ROOM1', side: 1 })).seat, 2);
    await until(() => alice.latest.state && alice.latest.players.length === 2);
    assert.equal(alice.latest.state.moveCount, 0);
    assert.equal(alice.latest.hostId, alice.id);
    alice.disconnect();
    await until(() => third.latest.state === null);
    assert.equal(third.latest.hostId, third.id);
    const drawOpponent = await connect();
    await send(drawOpponent, 'room:join', { pseudo: 'Draw', room: 'ROOM1', side: 1 });
    await until(() => third.latest.state && drawOpponent.latest?.state);
    for (let step = 0; step < 8; step++) {
      const player = step % 2 === 0 ? drawOpponent : third;
      const snapshot = player.latest;
      const red = player === drawOpponent;
      const forward = Math.floor(step / 2) % 2 === 0;
      const response = await send(player, 'game:move', {
        id: red ? 'p1_2' : 'p2_7', r: red ? (forward ? 8 : 9) : (forward ? 1 : 0), c: red ? 2 : 7,
        gameId: snapshot.gameId, revision: snapshot.revision
      });
      assert.equal(response.ok, true);
      await until(() => player.latest.revision > snapshot.revision && third.latest.revision === drawOpponent.latest.revision);
      await delay(70);
    }
    assert.equal(third.latest.state.winner, 0);
    assert.equal(third.latest.state.reason, 'Triple repetition');
    await until(() => third.latest.ranked);
    const afterDraw = await (await fetch(`${base}/TraGame/leaderboard`)).json();
    assert.equal(afterDraw.find(row => row.pseudo === 'Third').played, 1);
    assert.equal(afterDraw.find(row => row.pseudo === 'Third').wins, 0);
    assert.equal(afterDraw.find(row => row.pseudo === 'Third').best_win_moves, null);
    assert.equal(afterDraw.find(row => row.pseudo === 'Alice').played, 1);
    const drawnGame = third.latest.gameId;
    await send(third, 'game:start', { terrain: 'hell' });
    await until(() => third.latest.gameId !== drawnGame && drawOpponent.latest.gameId === third.latest.gameId);
    const attacks = [[6, 2], [5, 2], [4, 2], [3, 2], [3, 0], [0, 0], [-1, 0]];
    const defenders = [[3, 7], [3, 4], [3, 2], [1, 2], [2, 2], [1, 2]];
    for (let index = 0; index < attacks.length; index++) {
      for (const [player, target, id] of [
        [drawOpponent, attacks[index], 'p1_2'],
        ...(defenders[index] ? [[third, defenders[index], index > 2 ? 'p2_2' : 'p2_7']] : [])
      ]) {
        const snapshot = player.latest;
        assert.equal((await send(player, 'game:move', {
          id, r: target[0], c: target[1], gameId: snapshot.gameId, revision: snapshot.revision
        })).ok, true);
        await until(() => player.latest.revision > snapshot.revision && third.latest.revision === drawOpponent.latest.revision);
        await delay(70);
      }
    }
    await until(() => drawOpponent.latest.ranked);
    const afterCapture = await (await fetch(`${base}/TraGame/leaderboard`)).json();
    const attackerStats = afterCapture.find(row => row.pseudo === 'Draw');
    assert.deepEqual([attackerStats.wins, attackerStats.played, attackerStats.captures, attackerStats.losses, attackerStats.best_win_moves], [1, 2, 1, 0, 7]);
    const defenderStats = afterCapture.find(row => row.pseudo === 'Third');
    assert.deepEqual([defenderStats.wins, defenderStats.played, defenderStats.captures, defenderStats.losses, defenderStats.best_win_moves], [0, 2, 0, 1, null]);
    // The database is outside public and can be reopened independently.
    const persisted = await openScores(path.join(directory, 'data', 'tragame-scores.db'));
    assert.equal((await persisted.list())[0].pseudo, 'Alice');
    await persisted.close();
  } finally {
    for (const client of clients) client.disconnect();
    const exited = once(server, 'exit');
    server.kill();
    await exited;
  }
});
