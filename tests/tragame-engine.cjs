// node test.js
const assert = require('assert');
const E = require('../seed/TraGame/public/engine.js');
const flat = () => Array.from({ length: 10 }, () => Array(10).fill(0));

// Terrain : chaque mode respecte pentes ≤ 2 et hauteurs 0..9
for (const mode of ['random', ...Object.keys(E.TERRAINS)]) for (let i = 0; i < 30; i++) {
  const { board: b, terrain } = E.generateBoard(mode);
  assert(E.TERRAINS[terrain] && (mode === 'random' || terrain === mode));
  for (let r = 0; r < 10; r++) for (let c = 0; c < 10; c++) {
    assert(b[r][c] >= 0 && b[r][c] <= 9);
    if (c < 9) assert(Math.abs(b[r][c] - b[r][c + 1]) <= 2, mode);
    if (r < 9) assert(Math.abs(b[r][c] - b[r + 1][c]) <= 2, mode);
  }
}

// Coût de pente : sentinelle (3) face à une marche de +2 (coût 3) ne peut pas aller plus loin
let s = E.newGame(flat());
s.board[8][2] = 2;
const sent = s.pieces.find(p => p.id === 'p1_2');
const up = E.pieceMoves(s, sent).filter(m => m.c === 2 && !m.exit).map(m => m.r);
assert(up.includes(8) && !up.includes(7));

// Combat : vanguard vs vanguard, +1 hauteur -> capture (3 >= 2)
s = E.newGame(flat());
s.pieces = s.pieces.filter(p => ['p1_3', 'p2_3', 'p1_2', 'p2_2'].includes(p.id));
Object.assign(s.pieces.find(p => p.id === 'p1_3'), { row: 5, col: 3 });
Object.assign(s.pieces.find(p => p.id === 'p2_3'), { row: 4, col: 3 });
s.board[5][3] = 1;
let atk = E.pieceMoves(s, s.pieces.find(p => p.id === 'p1_3')).find(m => m.capture === 'p2_3');
assert(atk && atk.a === 3 && atk.d === 2);
// Vanguard bonus +1 quand il faut les 4 points : ici coût 2 -> pas de bonus
s = E.applyMove(s, atk);
assert(s.pieces.find(p => p.id === 'p2_3').captured && s.turn === 2);

// Sentinelle arrivée en premier = victoire immédiate
s = E.newGame(flat());
Object.assign(s.pieces.find(p => p.id === 'p1_2'), { row: 0, col: 0 });
const exit = E.pieceMoves(s, s.pieces.find(p => p.id === 'p1_2')).find(m => m.exit);
s = E.applyMove(s, exit);
assert(s.gameOver && s.winner === 1);

// Diagonale de l'explorateur ignore la hauteur (case inaccessible normalement)
s = E.newGame(flat());
const ex = s.pieces.find(p => p.id === 'p1_4');
Object.assign(ex, { row: 5, col: 4 });
s.board[5][4] = 0; s.board[4][5] = 6; s.board[4][4] = 6; s.board[5][5] = 6;
assert(E.pieceMoves(s, ex).some(m => m.r === 4 && m.c === 5));

// IA : prend une victoire immédiate
s = E.newGame(flat());
s.turn = 2;
Object.assign(s.pieces.find(p => p.id === 'p2_7'), { row: 9, col: 0 });
Object.assign(s.pieces.find(p => p.id === 'p1_2'), { row: 0, col: 9 });
const m = E.bestMove(s, 2, 2000);
assert(m.exit && m.id === 'p2_7', JSON.stringify(m));

// Partie IA vs IA jusqu'au bout sans crash
s = E.newGame();
while (!s.gameOver) { const mv = E.bestMove(s, 1, 50); s = mv ? E.applyMove(s, mv) : E.passTurn(s); }
console.log('ok -', s.reason, 'gagnant', s.winner, 'en', s.moveCount, 'coups');
