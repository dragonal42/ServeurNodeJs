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

    const alice = await connect(), candidateB = await connect(), candidateC = await connect(), other = await connect();
    assert((await send(alice, 'room:join', { pseudo: '', room: 'ROOM1' })).error);
    assert((await send(alice, 'room:join', { pseudo: 'Alice', room: '<script>' })).error);
    await send(alice, 'room:join', { pseudo: 'Alice', room: 'ROOM1', terrain: 'hell' });
    await send(candidateB, 'room:join', { pseudo: 'Bob', room: 'ROOM1' });
    await send(candidateC, 'room:join', { pseudo: 'Third', room: 'ROOM1' });
    await send(other, 'room:join', { pseudo: 'Other', room: 'ROOM2' });
    await until(() => alice.latest?.players.length === 3 && other.latest);
    assert.equal(alice.latest.phase, 'lobby');
    assert.equal(alice.latest.state, null);
    assert((await send(alice, 'game:start', { terrain: 'hell' })).error);
    assert((await send(alice, 'room:ready', {})).error);
    assert.equal((await send(candidateB, 'room:ready', { ready: true })).ok, true);
    assert((await send(candidateC, 'room:ready', { ready: true })).error);
    assert.equal((await send(candidateB, 'room:ready', { ready: false })).ok, true);
    await until(() => alice.latest.phase === 'lobby');
    // Two concurrent readiness requests reserve exactly one opponent.
    const race = await Promise.all([send(candidateB, 'room:ready', { ready: true }), send(candidateC, 'room:ready', { ready: true })]);
    assert.equal(race.filter(result => result.ok).length, 1);
    assert.equal(race.filter(result => result.error).length, 1);
    const bob = race[0].ok ? candidateB : candidateC;
    const third = race[0].ok ? candidateC : candidateB;
    const opponentName = race[0].ok ? 'Bob' : 'Third';
    const spectatorName = race[0].ok ? 'Third' : 'Bob';
    await until(() => alice.latest.phase === 'ready');
    assert.equal(alice.latest.challengerId, bob.id);
    assert((await send(bob, 'game:start', { terrain: 'hell' })).error);
    assert((await send(third, 'room:reset', {})).error);
    assert((await send(alice, 'game:start', { terrain: '__proto__' })).error);
    assert.equal((await send(alice, 'game:start', { terrain: 'hell' })).ok, true);
    await until(() => alice.latest?.state && bob.latest?.state && third.latest?.state);
    assert.deepEqual(alice.latest.duelIds, [alice.id, bob.id]);
    assert.equal(third.latest.players.find(p => p.id === third.id).seat, 0);
    assert((await send(alice, 'room:reset', {})).error);
    assert((await send(alice, 'game:start', { terrain: 'hell' })).error);
    const first = alice.latest;
    const valid = E.legalMoves(first.state)[0];
    assert((await send(bob, 'game:move', { ...valid, gameId: first.gameId, revision: first.revision })).error);
    assert((await send(third, 'game:move', { ...valid, gameId: first.gameId, revision: first.revision })).error);
    assert((await send(alice, 'game:move', { id: 'p1_2', r: -1, c: 0, gameId: first.gameId, revision: first.revision })).error);
    assert((await send(alice, 'game:move', { ...valid, gameId: 'old-game', revision: first.revision })).error);
    await delay(1000); // New anti-flood window after the protocol rejection checks.

    async function move(player, id, r, c, extra = {}) {
      const previous = player.latest;
      assert.equal((await send(player, 'game:move', { ...extra, id, r, c,
        gameId: previous.gameId, revision: previous.revision })).ok, true);
      await until(() => alice.latest.revision > previous.revision && bob.latest.revision === alice.latest.revision && third.latest.revision === alice.latest.revision);
      await delay(70);
      return previous;
    }
    const reds = [[9, 0], [6, 0], [3, 0], [0, 0], [-1, 0]];
    for (let index = 0; index < reds.length; index++) {
      const previous = await move(alice, 'p1_2', ...reds[index], { capture: 'p2_2', scores: [9999, 0], winner: 1 });
      assert.equal(alice.latest.state.pieces.find(p => p.id === 'p2_2').captured, false);
      assert.equal(other.latest.state, null);
      assert.equal(third.latest.state.moveCount, alice.latest.state.moveCount);
      if (index === 0) {
        assert((await send(alice, 'game:move', { ...valid, gameId: previous.gameId, revision: previous.revision })).error);
        const late = await connect();
        await send(late, 'room:join', { pseudo: 'Late spectator', room: 'ROOM1' });
        await until(() => late.latest?.state && alice.latest.players.length === 4);
        assert.equal(late.latest.state.moveCount, 1);
        assert.equal(late.latest.history.length, 1);
        const beforeLeave = alice.latest;
        late.disconnect();
        await until(() => alice.latest.players.length === 3);
        assert.equal(alice.latest.gameId, beforeLeave.gameId);
        assert.equal(alice.latest.revision, beforeLeave.revision);
        assert.equal(alice.latest.phase, 'playing');
      }
      if (index < reds.length - 1) await move(bob, 'p2_7', index % 2 ? 2 : 1, 7);
    }
    assert.equal(alice.latest.state.gameOver, true);
    assert.equal(alice.latest.state.winner, 1);
    assert.equal(alice.latest.phase, 'finished');
    await until(() => alice.latest.ranked);
    const rows = await (await fetch(`${base}/TraGame/leaderboard`)).json();
    assert.deepEqual(rows.map(row => [row.pseudo, row.wins, row.played, row.winning_moves_total, row.best_win_moves, row.captures, row.losses]),
      [['Alice', 1, 1, 5, 5, 0, 0], [opponentName, 0, 1, 0, null, 0, 0]]);
    assert(!rows.some(row => row.pseudo === spectatorName));

    async function rematch() {
      const oldGame = alice.latest.gameId;
      assert((await send(third, 'game:rematch', { gameId: oldGame })).error);
      assert((await send(alice, 'game:rematch', { gameId: 'old-game' })).error);
      assert.equal((await send(bob, 'game:rematch', { gameId: oldGame })).ok, true);
      assert((await send(alice, 'game:start', { terrain: 'hell' })).error);
      assert.equal((await send(alice, 'game:rematch', { gameId: oldGame })).ok, true);
      await until(() => alice.latest.phase === 'ready');
      assert.equal((await send(alice, 'game:start', { terrain: 'hell' })).ok, true);
      await until(() => alice.latest.gameId !== oldGame && bob.latest.gameId === alice.latest.gameId && third.latest.gameId === alice.latest.gameId);
      assert((await send(alice, 'game:move', { ...valid, gameId: oldGame, revision: 1 })).error);
    }
    await rematch();
    assert.equal(alice.latest.players.find(p => p.id === alice.id).seat, 2);
    assert.equal(bob.latest.players.find(p => p.id === bob.id).seat, 1);
    // Red (the previous challenger) now starts. Both participants get a played game for the draw.
    for (let step = 0; step < 8; step++) {
      const red = step % 2 === 0;
      const forward = Math.floor(step / 2) % 2 === 0;
      await move(red ? bob : alice, red ? 'p1_2' : 'p2_7', red ? (forward ? 8 : 9) : (forward ? 1 : 0), red ? 2 : 7);
    }
    assert.equal(alice.latest.state.winner, 0);
    assert.equal(alice.latest.state.reason, 'Triple repetition');
    await until(() => alice.latest.ranked);
    const afterDraw = await (await fetch(`${base}/TraGame/leaderboard`)).json();
    assert.equal(afterDraw.find(row => row.pseudo === 'Alice').played, 2);
    assert.equal(afterDraw.find(row => row.pseudo === opponentName).played, 2);
    assert.equal(afterDraw.find(row => row.pseudo === opponentName).wins, 0);

    await rematch();
    assert.equal(alice.latest.players.find(p => p.id === alice.id).seat, 1);
    const attacks = [[6, 2], [5, 2], [4, 2], [3, 2], [3, 0], [0, 0], [-1, 0]];
    const defenders = [[3, 7], [3, 4], [3, 2], [1, 2], [2, 2], [1, 2]];
    for (let index = 0; index < attacks.length; index++) {
      await move(alice, 'p1_2', ...attacks[index]);
      if (defenders[index]) await move(bob, index > 2 ? 'p2_2' : 'p2_7', ...defenders[index]);
    }
    await until(() => alice.latest.ranked);
    const afterCapture = await (await fetch(`${base}/TraGame/leaderboard`)).json();
    const attackerStats = afterCapture.find(row => row.pseudo === 'Alice');
    assert.deepEqual([attackerStats.wins, attackerStats.played, attackerStats.winning_moves_total, attackerStats.captures, attackerStats.losses, attackerStats.best_win_moves], [2, 3, 12, 1, 0, 5]);
    const defenderStats = afterCapture.find(row => row.pseudo === opponentName);
    assert.deepEqual([defenderStats.wins, defenderStats.played, defenderStats.captures, defenderStats.losses, defenderStats.best_win_moves], [0, 3, 0, 1, null]);
    assert.equal(afterCapture.length, 2);

    // The admin can choose a new opponent after the match, and only the first ready player gets the place.
    assert.equal((await send(alice, 'room:reset', {})).ok, true);
    await until(() => alice.latest.phase === 'lobby');
    assert.equal((await send(third, 'room:ready', {})).ok, true);
    assert((await send(bob, 'room:ready', {})).error);
    await send(alice, 'game:start', { terrain: 'hell' });
    await until(() => alice.latest.phase === 'playing' && third.latest.phase === 'playing');
    const inProgress = alice.latest.gameId;
    bob.disconnect(); // Now a spectator: its departure must not stop the duel.
    await until(() => alice.latest.players.length === 2);
    assert.equal(alice.latest.gameId, inProgress);
    assert.equal(alice.latest.phase, 'playing');
    third.disconnect(); // An active player leaves: return to the lobby without recording an unfinished game.
    await until(() => alice.latest.phase === 'lobby');
    assert.equal(alice.latest.state, null);
    const replacement = await connect();
    await send(replacement, 'room:join', { pseudo: 'Replacement', room: 'ROOM1' });
    await until(() => replacement.latest?.hostId === alice.id);
    alice.disconnect();
    await until(() => replacement.latest.hostId === replacement.id);
    assert.equal(replacement.latest.phase, 'lobby');
    assert.equal(replacement.latest.challengerId, null);
    assert.deepEqual(await (await fetch(`${base}/TraGame/leaderboard`)).json(), afterCapture);
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
