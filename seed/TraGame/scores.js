'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3');

async function openScores(filename) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = await new Promise((resolve, reject) => {
    const connection = new sqlite3.Database(filename, err => err ? reject(err) : resolve(connection));
  });
  const run = (sql, values = []) => new Promise((resolve, reject) =>
    db.run(sql, values, function (err) { if (err) reject(err); else resolve(this.changes); }));
  try {
    await run('PRAGMA busy_timeout = 5000');
    await run(`CREATE TABLE IF NOT EXISTS player_stats (
      pseudo TEXT PRIMARY KEY NOT NULL,
      wins INTEGER NOT NULL DEFAULT 0,
      played INTEGER NOT NULL DEFAULT 0,
      winning_moves_total INTEGER NOT NULL DEFAULT 0,
      best_win_moves INTEGER,
      captures INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      played_at TEXT NOT NULL
    )`);
    await run(`CREATE TABLE IF NOT EXISTS completed_games (
      game_id TEXT PRIMARY KEY NOT NULL, played_at TEXT NOT NULL
    )`);
  } catch (error) {
    await new Promise(resolve => db.close(resolve));
    throw error;
  }

  // Serialise les transactions de salles differentes sur cette connexion.
  let queue = Promise.resolve();
  function enqueue(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }
  async function persist(gameId, players, state, moves) {
    await run('BEGIN IMMEDIATE');
    try {
      const timestamp = new Date().toISOString();
      const inserted = await run('INSERT OR IGNORE INTO completed_games (game_id, played_at) VALUES (?, ?)', [gameId, timestamp]);
      if (inserted) for (const player of players) {
        const won = state.winner === player.seat ? 1 : 0;
        const winningMoves = won ? moves[player.seat - 1] : null;
        const captures = state.pieces.filter(p => p.player !== player.seat && p.captured).length;
        const losses = state.pieces.filter(p => p.player === player.seat && p.captured).length;
        await run(`INSERT INTO player_stats
          (pseudo, wins, played, winning_moves_total, best_win_moves, captures, losses, played_at)
          VALUES (?, ?, 1, ?, ?, ?, ?, ?)
          ON CONFLICT(pseudo) DO UPDATE SET
            wins = player_stats.wins + excluded.wins,
            played = player_stats.played + 1,
            winning_moves_total = player_stats.winning_moves_total + excluded.winning_moves_total,
            best_win_moves = CASE
              WHEN excluded.best_win_moves IS NULL THEN player_stats.best_win_moves
              WHEN player_stats.best_win_moves IS NULL THEN excluded.best_win_moves
              ELSE MIN(player_stats.best_win_moves, excluded.best_win_moves) END,
            captures = player_stats.captures + excluded.captures,
            losses = player_stats.losses + excluded.losses,
            played_at = excluded.played_at`,
        [player.pseudo, won, winningMoves || 0, winningMoves, captures, losses, timestamp]);
      }
      await run('COMMIT');
    } catch (error) { await run('ROLLBACK'); throw error; }
  }

  return {
    saveGame(gameId, players, state, moves) {
      if (!state.gameOver) return Promise.reject(new Error('Partie non terminee.'));
      return enqueue(() => persist(gameId, players, state, moves));
    },
    async list() {
      // Aucune lecture ne voit les statistiques d'un seul des deux joueurs.
      const rows = await enqueue(() => new Promise((resolve, reject) => db.all(`
        SELECT pseudo, wins, played, winning_moves_total, best_win_moves, captures, losses, played_at
        FROM player_stats ORDER BY wins DESC, best_win_moves IS NULL, best_win_moves ASC, captures DESC, pseudo ASC
      `, [], (err, result) => err ? reject(err) : resolve(result))));
      return rows.map((row, index) => ({ ...row, rank: index + 1 }));
    },
    async close() {
      await queue;
      await new Promise((resolve, reject) => db.close(err => err ? reject(err) : resolve()));
    }
  };
}

module.exports = { openScores };
