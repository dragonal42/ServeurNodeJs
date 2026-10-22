// Moteur Traversal - règles reprises de traversalgame.com (localGameEngine + page Règles).
// Joueur 1 (rouge) part de la rangée du bas (row 9) et sort par le haut (row -1).
// Joueur 2 (bleu) part du haut (row 0) et sort par le bas (row 10).
const SIZE = 10, MOVE_LIMIT = 200, MAX_H = 9;
const STATS = { explorer: { mv: 5, str: 1 }, vanguard: { mv: 4, str: 2 }, sentinel: { mv: 3, str: 3 } };
const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const inB = (r, c) => r >= 0 && r < SIZE && c >= 0 && c < SIZE;

// ---------- Terrains ----------
// Le générateur du site tourne sur son serveur (non public) : ces modes imitent ses descriptions
// et des plateaux d'exemple de son API (hauteurs 0..9, voisins à ≤ 2 d'écart).
const grid = v => Array.from({ length: SIZE }, () => Array(SIZE).fill(v));
const ring = (r, c) => Math.min(r, c, SIZE - 1 - r, SIZE - 1 - c); // 0 au bord, 4 au centre

function bumps(h, rand, n, [a0, a1], [r0, r1], central = false) {
  for (let i = 0; i < n; i++) {
    const cr = central ? 2.5 + rand() * 4 : rand() * SIZE, cc = central ? 2.5 + rand() * 4 : rand() * SIZE;
    const amp = a0 + rand() * (a1 - a0), rad = r0 + rand() * (r1 - r0);
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++)
      h[r][c] += amp * Math.exp(-((r - cr) ** 2 + (c - cc) ** 2) / rad ** 2);
  }
  return h;
}

function speckle(h, rand, p, values) { // cases isolées (pics, creux)
  for (const row of h) for (let c = 0; c < SIZE; c++) if (rand() < p) row[c] = values[Math.floor(rand() * values.length)];
  return h;
}

function path(h, rand, onPath, bank) { // tracé sinueux d'un bord à l'autre (rivière, crête)
  const vertical = rand() < 0.5;
  let x = 1 + Math.floor(rand() * (SIZE - 2));
  const cells = [];
  for (let y = 0; y < SIZE; y++) {
    cells.push([y, x]);
    const step = Math.floor(rand() * 3) - 1, nx = Math.max(0, Math.min(SIZE - 1, x + step));
    if (nx !== x) cells.push([y, nx]); // reste connexe orthogonalement
    x = nx;
  }
  const set = ([y, x], v) => { const [r, c] = vertical ? [y, x] : [x, y]; if (inB(r, c)) h[r][c] = v; };
  for (const [y, x] of cells) for (const [dy, dx] of DIRS) set([y + dy, x + dx], bank);
  for (const cell of cells) set(cell, onPath);
  return h;
}

function plateaus(h, rand) { // canyons : régions plates (Voronoï) à niveaux échelonnés
  const seeds = Array.from({ length: 5 }, () => [rand() * SIZE, rand() * SIZE, Math.floor(rand() * 4) * 2]);
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++)
    h[r][c] = seeds.reduce((b, s) => ((s[0] - r) ** 2 + (s[1] - c) ** 2 < (b[0] - r) ** 2 + (b[1] - c) ** 2 ? s : b))[2];
  return h;
}

const TERRAINS = {
  mountains: ['Montagnes', rand => bumps(grid(2), rand, 5, [2, 5], [1.5, 2.8], true)],
  valleys: ['Vallées', rand => bumps(grid(6), rand, 3, [-7, -4], [2, 3.5])],
  highlands: ['Hautes terres', rand => bumps(grid(4), rand, 16, [-4, 4], [1, 1.8])],
  woodlands: ['Bois', rand => bumps(grid(3), rand, 4, [-3, 3], [2.5, 4.5])],
  desert: ['Désert', rand => speckle(grid(2), rand, 0.07, [0, 4])],
  dunes: ['Dunes', rand => bumps(grid(0), rand, 3, [1.5, 2.5], [1.2, 2])],
  jungle: ['Jungle', rand => speckle(grid(1), rand, 0.35, [0, 2, 3])],
  meadows: ['Prairies', rand => speckle(grid(2), rand, 0.12, [1, 3, 4])],
  canyons: ['Canyons', rand => plateaus(grid(0), rand)],
  rivers: ['Rivières', rand => path(path(grid(2), rand, 0, 1), rand, 0, 1)],
  ridges: ['Crêtes', rand => path(grid(0), rand, 2, 1)],
  petrified: ['Forêt pétrifiée', rand => speckle(grid(2), rand, 0.1, [4, 4, 0])],
  everest: ['Mont Everest', () => grid(0).map((row, r) => row.map((_, c) => 2 * ring(r, c)))],
  mariana: ['Fosse des Mariannes', () => grid(0).map((row, r) => row.map((_, c) => 8 - 2 * ring(r, c)))],
  hell: ['Enfer', () => grid(0)],
};
const RANDOM_POOL = ['mountains', 'valleys', 'highlands', 'woodlands', 'desert', 'dunes', 'jungle', 'meadows', 'canyons', 'rivers', 'ridges', 'petrified'];

// Renvoie { board, terrain } ; 'random' tire un mode au hasard.
function generateBoard(mode = 'random', rand = Math.random) {
  const terrain = TERRAINS[mode] ? mode : RANDOM_POOL[Math.floor(rand() * RANDOM_POOL.length)];
  const h = TERRAINS[terrain][1](rand).map(row => row.map(v => Math.max(0, Math.min(MAX_H, Math.round(v)))));
  // Adoucit chaque pente > 2 en rapprochant les deux cases (la somme des carrés baisse : ça termine).
  for (let changed = true; changed;) {
    changed = false;
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) for (const [dr, dc] of DIRS) {
      const R = r + dr, C = c + dc;
      if (inB(R, C) && h[r][c] - h[R][C] > 2) { h[r][c]--; h[R][C]++; changed = true; }
    }
  }
  return { board: h, terrain };
}

function newGame(board = generateBoard().board) {
  const layout = [['sentinel', 2], ['vanguard', 3], ['explorer', 4], ['explorer', 5], ['vanguard', 6], ['sentinel', 7]];
  const pieces = [];
  for (const player of [1, 2]) for (const [type, col] of layout)
    pieces.push({ id: `p${player}_${col}`, type, player, row: player === 1 ? SIZE - 1 : 0, col,
      str: STATS[type].str, mv: STATS[type].mv, captured: false, finished: false });
  return { board, pieces, turn: 1, moveCount: 0, finished: [], scores: [0, 0], gameOver: false, winner: null, reason: null };
}

const active = p => !p.captured && !p.finished;
const pieceAt = (s, r, c) => s.pieces.find(p => active(p) && p.row === r && p.col === c);
const goalRow = p => p.player === 1 ? 0 : SIZE - 1;
const exitRow = p => p.player === 1 ? -1 : SIZE;

function combat(s, att, def) {
  const hd = s.board[att.row][att.col] - s.board[def.row][def.col];
  let a = att.str + Math.sign(hd), d = def.str;
  for (const [dr, dc] of DIRS) {
    const q = pieceAt(s, def.row + dr, def.col + dc);
    if (!q) continue;
    if (q.player === att.player && q.id !== att.id) a += q.str; // alliés : + force de base
    if (q.player === def.player) d += 1;                         // renforts : +1
  }
  return { a, d };
}

// Coups légaux d'une pièce : {id, r, c, capture?, exit?, a?, d?}
function pieceMoves(s, p) {
  const key = (r, c) => r * SIZE + c;
  const best = new Map([[key(p.row, p.col), p.mv]]); // mouvement restant max par case (départ interdit)
  const moves = [], attackCost = new Map(), exitCols = new Set();
  if (p.row === goalRow(p)) exitCols.add(p.col);
  const queue = [[p.row, p.col, p.mv]];
  while (queue.length) {
    const [r, c, rem] = queue.shift();
    if (rem < best.get(key(r, c))) continue;
    if (r === goalRow(p) && rem >= 1) exitCols.add(c);
    for (const [dr, dc] of DIRS) {
      const R = r + dr, C = c + dc;
      if (!inB(R, C)) continue;
      const cost = Math.abs(s.board[R][C] - s.board[r][c]) + 1;
      if (cost > rem) continue;
      const q = pieceAt(s, R, C);
      if (q) {
        const used = p.mv - rem + cost, k = key(R, C);
        if (q.player !== p.player && !(attackCost.get(k)?.used <= used)) attackCost.set(k, { used, q });
        continue;
      }
      const left = rem - cost, k = key(R, C);
      if (left > (best.get(k) ?? -1)) {
        if (!best.has(k)) moves.push({ id: p.id, r: R, c: C });
        best.set(k, left);
        if (left > 0) queue.push([R, C, left]);
      }
    }
  }
  for (const { used, q } of attackCost.values()) {
    const { a, d } = combat(s, p, q);
    const att = a + (p.type === 'vanguard' && used === 4 ? 1 : 0);
    if (att >= d) moves.push({ id: p.id, r: q.row, c: q.col, capture: q.id, a: att, d });
  }
  if (p.type === 'explorer') {
    const fwd = p.player === 1 ? -1 : 1;
    for (const [dr, dc] of [[-1, -1], [-1, 1], [1, -1], [1, 1], [-2, 0], [0, -2], [2, 0], [0, 2]]) {
      const R = p.row + dr, C = p.col + dc;
      if (Math.abs(dr) === 2 || Math.abs(dc) === 2) { // bond : la case du milieu doit être libre
        const mr = p.row + dr / 2, mc = p.col + dc / 2;
        if (!inB(mr, mc) || pieceAt(s, mr, mc)) continue;
      }
      if ((R < 0 || R >= SIZE) && C >= 0 && C < SIZE) {
        if (Math.sign(dr) === fwd) exitCols.add(C);
        continue;
      }
      if (!inB(R, C) || best.has(key(R, C)) || attackCost.has(key(R, C))) continue;
      const q = pieceAt(s, R, C);
      if (!q) moves.push({ id: p.id, r: R, c: C });
      else if (q.player !== p.player) {
        const { a, d } = combat(s, p, q);
        if (a >= d) moves.push({ id: p.id, r: R, c: C, capture: q.id, a, d });
      }
    }
  }
  for (const c of exitCols) moves.push({ id: p.id, r: exitRow(p), c, exit: true });
  return moves;
}

const legalMoves = s => s.gameOver ? [] :
  s.pieces.filter(p => active(p) && p.player === s.turn).flatMap(p => pieceMoves(s, p));

const compare = (a, b) => a > b ? 1 : b > a ? 2 : 0;

function applyMove(s, m) {
  const n = { ...s, pieces: s.pieces.map(p => ({ ...p })), finished: [...s.finished], scores: [...s.scores] };
  const p = n.pieces.find(x => x.id === m.id);
  if (m.capture) n.pieces.find(x => x.id === m.capture).captured = true;
  if (m.exit) {
    p.finished = true;
    n.finished.push(p.id);
    n.scores[p.player - 1] += p.str;
    if (n.finished.length === 1 && p.type === 'sentinel')
      Object.assign(n, { gameOver: true, winner: p.player, reason: 'Sentinelle arrivée en premier' });
  } else { p.row = m.r; p.col = m.c; }
  if (!n.gameOver && n.finished.length >= 2)
    Object.assign(n, { gameOver: true, winner: compare(...n.scores), reason: 'Deux pièces arrivées' });
  if (!n.gameOver) {
    const left = [1, 2].map(pl => n.pieces.filter(x => x.player === pl && active(x)));
    if (!left[0].length || !left[1].length) {
      left.forEach((ps, i) => { n.scores[i] += ps.length ? Math.max(...ps.map(x => x.str)) : 0; });
      Object.assign(n, { gameOver: true, winner: compare(...n.scores), reason: 'Domination totale' });
    }
  }
  n.turn = 3 - n.turn;
  n.moveCount++;
  if (!n.gameOver && n.moveCount >= MOVE_LIMIT) moveLimit(n);
  return n;
}

function moveLimit(n) {
  n.gameOver = true;
  n.reason = 'Limite de coups';
  if (n.scores[0] !== n.scores[1]) { n.winner = compare(...n.scores); return; }
  // Sinon : pièce la plus proche de l'arrivée, puis la plus forte.
  const lead = pl => n.pieces.filter(x => x.player === pl && active(x))
    .map(x => [pl === 1 ? x.row : SIZE - 1 - x.row, x.str])
    .sort((a, b) => a[0] - b[0] || b[1] - a[1])[0];
  const a = lead(1), b = lead(2);
  const better = (x, y) => x && (!y || x[0] < y[0] || (x[0] === y[0] && x[1] > y[1]));
  n.winner = better(a, b) ? 1 : better(b, a) ? 2 : 0;
}

const passTurn = s => {
  if (s.gameOver) return s;
  const n = { ...s, scores: [...s.scores], turn: 3 - s.turn, moveCount: s.moveCount + 1 };
  if (n.moveCount >= MOVE_LIMIT) moveLimit(n);
  return n;
};

const positionKey = s => s.turn + '|' + s.pieces.filter(active).map(p => `${p.id}@${p.row},${p.col}`).join(';') + '|' + s.finished.join(',');

// ---------- IA : negamax alpha-beta, approfondissement itératif borné en temps ----------
function evaluate(s, pl) {
  let v = 0;
  for (const p of s.pieces) {
    if (!active(p)) continue;
    const progress = p.player === 1 ? SIZE - 1 - p.row : p.row; // 0..9
    const val = p.str * 10 + progress * (p.type === 'sentinel' ? 3 : 2) + (progress === SIZE - 1 ? 6 : 0);
    v += p.player === pl ? val : -val;
  }
  return v + (s.scores[pl - 1] - s.scores[2 - pl]) * 25;
}

function orderMoves(ms) {
  const score = m => (m.exit ? 100 : 0) + (m.capture ? 50 : 0);
  return ms.sort((a, b) => score(b) - score(a));
}

function negamax(s, depth, alpha, beta, ply, deadline) {
  if (s.gameOver) return s.winner === 0 ? 0 : (s.winner === s.turn ? 1 : -1) * (100000 - ply);
  if (depth === 0) return evaluate(s, s.turn);
  if (performance.now() > deadline) throw 'timeout';
  const ms = orderMoves(legalMoves(s));
  if (!ms.length) return -negamax(passTurn(s), depth - 1, -beta, -alpha, ply + 1, deadline);
  let best = -Infinity;
  for (const m of ms) {
    const v = -negamax(applyMove(s, m), depth - 1, -beta, -alpha, ply + 1, deadline);
    if (v > best) best = v;
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }
  return best;
}

// ponytail: pas de table de transposition ni de détection de répétition dans la recherche ; à ajouter si l'IA doit voir plus loin.
function bestMove(s, maxDepth = 3, timeMs = 1500) {
  const deadline = performance.now() + timeMs;
  const ms = legalMoves(s).sort(() => Math.random() - 0.5); // variété entre coups équivalents
  if (!ms.length) return null;
  orderMoves(ms);
  let chosen = ms[0];
  for (let depth = 1; depth <= maxDepth; depth++) {
    try {
      let alpha = -Infinity, best = ms[0];
      for (const m of ms) {
        const v = -negamax(applyMove(s, m), depth - 1, -Infinity, -alpha, 1, deadline);
        if (v > alpha) { alpha = v; best = m; }
      }
      chosen = best;
      ms.splice(ms.indexOf(best), 1); ms.unshift(best); // meilleur coup en tête pour la profondeur suivante
      if (alpha > 90000) break; // victoire forcée trouvée
    } catch (e) { if (e !== 'timeout') throw e; break; }
  }
  return chosen;
}

if (typeof module !== 'undefined')
  module.exports = { SIZE, TERRAINS, generateBoard, newGame, legalMoves, pieceMoves, applyMove, bestMove, pieceAt, positionKey, passTurn };
