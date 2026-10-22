import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const ICON = { explorer: '⬟', vanguard: '◆', sentinel: '▲' };
const NAME = { explorer: 'Explorateur', vanguard: 'Avant-garde', sentinel: 'Sentinelle' };
const $ = id => document.getElementById(id);
const UNIT = 0.45, BASE = 0.3, HALF = (SIZE - 1) / 2;
let pvp = false, net = null, seat, opponent, busy = Promise.resolve(), state, human, history, positions, selected, lastMove, thinking, animating;
const siteBase = new URL('.', location.href);
let gameId = null, revision = 0, hostId = null, pendingMove = false, session = 0;
let practice = false, latestRoom = null, viewEpoch = 0;
const onlineView = () => !!net && !practice;
let localLocked = false, frozenSettings = null, localSetup = true;
const localParametersLocked = () => localLocked && !state.gameOver;
function lockLocalSettings() {
  if (!onlineView() && !localLocked) {
    localLocked = true;
    frozenSettings = Object.fromEntries(['side', 'terrain', 'level'].map(id => [id, $(id).value]));
  }
}
function setPanelCollapsed(collapsed) {
  document.body.classList.toggle('panel-collapsed', collapsed);
  $('togglePanel').setAttribute('aria-expanded', String(!collapsed));
  const label = collapsed ? 'Afficher le panneau droit' : 'Masquer le panneau droit';
  $('togglePanel').setAttribute('aria-label', label);
  $('togglePanel').title = label;
  $('togglePanel').textContent = collapsed ? '‹' : '›';
  try { localStorage.setItem('tragame:panelCollapsed', collapsed ? '1' : '0'); } catch { }
}
let panelInitiallyCollapsed = false;
try { panelInitiallyCollapsed = localStorage.getItem('tragame:panelCollapsed') === '1'; } catch { }
setPanelCollapsed(panelInitiallyCollapsed);
$('togglePanel').onclick = () => setPanelCollapsed(!document.body.classList.contains('panel-collapsed'));
try { $('pseudo').value = localStorage.getItem('tragame:pseudo') || ''; } catch { }

// ---------- Scène ----------
const view = $('view');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.shadowMap.enabled = true;
view.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color();
// Thème : '' = suit le système ; le fond 3D reprend la variable CSS --scene.
const applyTheme = () => scene.background.set(getComputedStyle(document.documentElement).getPropertyValue('--scene').trim());
const setTheme = t => {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  try { localStorage.setItem('traversal:theme', t); } catch { }
  applyTheme();
};
let theme = '';
try { theme = localStorage.getItem('traversal:theme') ?? ''; } catch { }
setTheme(theme);
$('theme').value = theme;
$('theme').onchange = e => setTheme(e.target.value);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
const controls = new OrbitControls(camera, renderer.domElement);
Object.assign(controls, { enableDamping: true, minDistance: 4, maxDistance: 40, maxPolarAngle: Math.PI / 2.05 });
controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.8);
sun.position.set(5, 14, 7);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9 });
scene.add(sun);
const terrainGroup = new THREE.Group(), pieceGroup = new THREE.Group(), markerGroup = new THREE.Group();
scene.add(terrainGroup, pieceGroup, markerGroup);
const pieceMeshes = new Map(); // id -> mesh, persistants pour pouvoir les animer

// Mini-moteur d'animation : tween(durée, update(t)) -> Promise résolue à la fin.
const tweens = [];
const tween = (dur, update) => new Promise(res => tweens.push({ t0: performance.now(), dur, update, res }));
function stepTweens() {
  const now = performance.now();
  for (const tw of [...tweens]) {
    const t = Math.min(1, (now - tw.t0) / tw.dur);
    tw.update(t);
    if (t === 1) { tweens.splice(tweens.indexOf(tw), 1); tw.res(); }
  }
}
const ease = t => t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;

new ResizeObserver(() => {
  renderer.setSize(view.clientWidth, view.clientHeight);
  camera.aspect = view.clientWidth / view.clientHeight;
  camera.updateProjectionMatrix();
}).observe(view);
renderer.setAnimationLoop(() => { stepTweens(); controls.update(); renderer.render(scene, camera); });

function recenter() { // le joueur humain regarde depuis son bord de départ
  const side = human === 1 ? 1 : -1;
  camera.position.set(0, 11, 11 * side);
  controls.target.set(0, 0.8, 0);
}

// ---------- Géométries / matériaux partagés ----------
const HEIGHT_HSL = [[140, 55, 32], [115, 50, 44], [85, 55, 50], [55, 70, 52], [35, 75, 52], [20, 65, 42], [15, 40, 30], [20, 12, 45], [0, 0, 66], [0, 0, 95]];
const cellMats = HEIGHT_HSL.map(([h, s, l]) => new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(h / 360, s / 100, l / 100, THREE.SRGBColorSpace), roughness: 0.9 }));
const cellGeo = new THREE.BoxGeometry(0.96, 1, 0.96);
const edgeGeo = new THREE.EdgesGeometry(cellGeo), edgeMat = new THREE.LineBasicMaterial({ color: '#1a1a1a', transparent: true, opacity: 0.45 });
// Graduation : un trait autour de la case à chaque niveau, pour compter les marches.
const tickGeo = new THREE.BufferGeometry().setFromPoints([[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, z]) => new THREE.Vector3(x * 0.482, 0, z * 0.482)));
const tickMat = new THREE.LineBasicMaterial({ color: '#1a1a1a', transparent: true, opacity: 0.3 });
const exitGeo = new THREE.BoxGeometry(0.96, 0.06, 0.6);
const exitMat = new THREE.MeshStandardMaterial({ color: '#c9cfd6' });
const hitMat = new THREE.MeshBasicMaterial({ visible: false }); // non rendu, mais touché par le raycaster
// Mouvement = côtés de la base, Force = pointes au sommet (comme les vraies pièces).
const GEO = {
  explorer: new THREE.ConeGeometry(0.3, 0.75, 5).translate(0, 0.375, 0),
  vanguard: new THREE.CylinderGeometry(0.3, 0.3, 0.62, 3).rotateZ(Math.PI / 2).rotateX(-Math.PI / 2).scale(1, 1.3, 1).translate(0, 0.195, 0),
  sentinel: new THREE.CylinderGeometry(0.3, 0.3, 0.6, 3).translate(0, 0.3, 0),
};
const pieceEdgeGeo = Object.fromEntries(Object.entries(GEO).map(([k, g]) => [k, new THREE.EdgesGeometry(g)]));
const pieceMat = { 1: new THREE.MeshStandardMaterial({ color: '#c62828', roughness: 0.5, flatShading: true }), 2: new THREE.MeshStandardMaterial({ color: '#1e4fc2', roughness: 0.5, flatShading: true }) };
const selMat = { 1: pieceMat[1].clone(), 2: pieceMat[2].clone() };
for (const m of Object.values(selMat)) m.emissive.set('#ffcc00'), m.emissiveIntensity = 0.6;
const moveGeo = new THREE.CircleGeometry(0.17, 24).rotateX(-Math.PI / 2);
const moveMat = new THREE.MeshBasicMaterial({ color: '#2e7d32' });
const attackGeo = new THREE.RingGeometry(0.36, 0.46, 32).rotateX(-Math.PI / 2);
const attackMat = new THREE.MeshBasicMaterial({ color: '#e53935', side: THREE.DoubleSide });
const lastGeo = new THREE.RingGeometry(0.4, 0.47, 4, 1, Math.PI / 4).rotateX(-Math.PI / 2);
const lastMat = new THREE.MeshBasicMaterial({ color: '#ffd54f' });
const arrowGeo = new THREE.ConeGeometry(0.15, 0.35, 16);

const X = c => c - HALF, Z = r => r - HALF;
const top = (r, c) => BASE + state.board[r][c] * UNIT;

function mesh(geo, mat, x, y, z, data) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.userData = data;
  return m;
}

function buildTerrain() {
  terrainGroup.clear();
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
    const t = top(r, c), m = mesh(cellGeo, cellMats[state.board[r][c]], X(c), t / 2, Z(r), { r, c });
    m.scale.y = t;
    m.castShadow = m.receiveShadow = true;
    const edges = new THREE.LineSegments(edgeGeo, edgeMat);
    edges.raycast = () => { }; // le survol doit toucher la case, pas son liseré
    m.add(edges);
    terrainGroup.add(m);
    for (let k = 1; k < state.board[r][c]; k++) {
      const tick = new THREE.LineLoop(tickGeo, tickMat);
      tick.position.set(X(c), BASE + k * UNIT, Z(r));
      tick.raycast = () => { };
      terrainGroup.add(tick);
    }
  }
  for (const r of [-1, SIZE]) for (let c = 0; c < SIZE; c++) { // bandes d'arrivée
    terrainGroup.add(mesh(exitGeo, exitMat, X(c), 0.03, Z(r) + (r < 0 ? 0.2 : -0.2), { r, c }));
    // Case invisible à la hauteur de la case voisine : cible de clic plus grande que la bande.
    const t = top(r < 0 ? 0 : SIZE - 1, c), hit = mesh(cellGeo, hitMat, X(c), t / 2, Z(r), { r, c });
    hit.scale.y = t;
    terrainGroup.add(hit);
  }
}

function buildPieces() {
  pieceGroup.clear(); pieceMeshes.clear();
  for (const p of state.pieces) {
    const m = mesh(GEO[p.type], pieceMat[p.player], 0, 0, 0, {});
    if (p.player === 2) m.rotation.y = Math.PI;
    m.castShadow = true;
    const edges = new THREE.LineSegments(pieceEdgeGeo[p.type], edgeMat);
    edges.raycast = () => { }; // le clic doit toucher la pièce, pas son liseré
    m.add(edges);
    pieceMeshes.set(p.id, m);
    pieceGroup.add(m);
  }
}

// ---------- Sons synthétisés (Web Audio, aucun fichier) ----------
let actx = null, muted = false;
try { muted = localStorage.getItem('traversal:muted') === '1'; } catch { }
// Le navigateur n'autorise l'audio qu'après une interaction : on le débloque au premier clic.
document.addEventListener('pointerdown', () => { actx ??= new AudioContext(); if (actx.state === 'suspended') actx.resume(); });

function tone(freq, dur, { type = 'sine', vol = 0.2, slide = 1, delay = 0 } = {}) {
  if (muted || !actx) return;
  const t = actx.currentTime + delay, o = actx.createOscillator(), g = actx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide !== 1) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(actx.destination);
  o.start(t); o.stop(t + dur);
}

function noise(dur, vol, cutoff = 1200) {
  if (muted || !actx) return;
  const buf = actx.createBuffer(1, actx.sampleRate * dur, actx.sampleRate), data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  const src = actx.createBufferSource(), f = actx.createBiquadFilter(), g = actx.createGain();
  src.buffer = buf; f.type = 'lowpass'; f.frequency.value = cutoff; g.gain.value = vol;
  src.connect(f).connect(g).connect(actx.destination);
  src.start();
}

const PITCH = { explorer: 1.4, vanguard: 1, sentinel: 0.7 }; // pièces lourdes = sons plus graves
const SFX = {
  select: () => tone(880, 0.05, { type: 'square', vol: 0.05 }),
  hop: type => tone(260 * PITCH[type], 0.18, { type: 'triangle', slide: 1.8, vol: 0.1 }),
  land: (type, h) => { tone((120 + h * 12) * PITCH[type], 0.15, { slide: 0.5, vol: 0.35 }); noise(0.06, 0.15, 600); },
  capture: () => { noise(0.3, 0.4, 1800); tone(150, 0.35, { type: 'sawtooth', slide: 0.3, vol: 0.12 }); },
  exit: () => [523, 659, 784].forEach((f, i) => tone(f, 0.25, { type: 'triangle', vol: 0.15, delay: i * 0.09 })),
  win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.35, { type: 'triangle', vol: 0.18, delay: i * 0.13 })),
  lose: () => [392, 330, 262].forEach((f, i) => tone(f, 0.4, { type: 'sine', vol: 0.2, delay: i * 0.18 })),
};

// ---------- Musique de fond générative (Am – F – C – G), programmée en avance ----------
const CHORDS = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
const BAR = 4;
let musicVol = 0.5; // 0..1, curseur « Volume musique »
const midi = n => 440 * 2 ** ((n - 69) / 12);
let musicOn = true, musicIn = null, musicOut = null, nextBar = 0, bar = 0;
try {
  musicOn = localStorage.getItem('traversal:music') !== '0';
  musicVol = Number(localStorage.getItem('traversal:musicVol') ?? 0.5);
} catch { }

function setupMusicBus() { // filtre doux -> volume -> sortie, avec un écho léger
  musicOut = actx.createGain();
  musicOut.gain.value = musicOn ? musicVol : 0;
  musicIn = actx.createBiquadFilter();
  musicIn.type = 'lowpass'; musicIn.frequency.value = 1800;
  const delay = actx.createDelay(), fb = actx.createGain();
  delay.delayTime.value = 0.375; fb.gain.value = 0.3;
  musicIn.connect(musicOut);
  musicIn.connect(delay).connect(fb).connect(delay);
  fb.connect(musicOut);
  musicOut.connect(actx.destination);
}

function musicNote(freq, t, dur, vol, type, attack) {
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(musicIn);
  o.start(t); o.stop(t + dur + 0.05);
}

function scheduleMusic() {
  if (!actx || !musicOn || actx.state !== 'running') return;
  if (!musicIn) setupMusicBus();
  if (nextBar < actx.currentTime) nextBar = actx.currentTime + 0.1;
  while (nextBar < actx.currentTime + 2) { // 2 s d'avance : tient même si l'onglet ralentit les timers
    const chord = CHORDS[bar % CHORDS.length];
    for (const n of chord) for (const cents of [-5, 5]) musicNote(midi(n) * 2 ** (cents / 1200), nextBar, BAR + 0.8, 0.035, 'triangle', 1.5);
    musicNote(midi(chord[0] - 12), nextBar, BAR, 0.07, 'sine', 0.3);
    for (let i = 0; i < 8; i++) if (Math.random() > 0.3)
      musicNote(midi(chord[Math.floor(Math.random() * 3)] + 12), nextBar + i * BAR / 8, 0.7, 0.03, 'sine', 0.01);
    nextBar += BAR; bar++;
  }
}
setInterval(scheduleMusic, 250);

function setMusic(on) {
  musicOn = on;
  try { localStorage.setItem('traversal:music', on ? '1' : '0'); } catch { }
  if (musicOut) musicOut.gain.setTargetAtTime(on ? musicVol : 0, actx.currentTime, 0.3);
  $('music').textContent = on ? '🎵 Musique' : '🎵 Musique coupée';
}

// Saut en arc vers la cible ; la pièce capturée tourne et rétrécit, la pièce arrivée sort et disparaît.
async function animateMove(m) {
  const type = state.pieces.find(p => p.id === m.id).type;
  let hit = false;
  SFX.hop(type);
  const pm = pieceMeshes.get(m.id), victim = m.capture && pieceMeshes.get(m.capture);
  const from = pm.position.clone();
  const to = m.exit ? new THREE.Vector3(X(m.c), 0.06, Z(m.r) + (m.r < 0 ? 0.2 : -0.2)) : new THREE.Vector3(X(m.c), top(m.r, m.c), Z(m.r));
  const dist = Math.hypot(to.x - from.x, to.z - from.z);
  const arc = 0.5 + Math.abs(to.y - from.y) / 2 + dist * 0.08;
  await tween(300 + 70 * dist, t => {
    const e = ease(t);
    pm.position.lerpVectors(from, to, e);
    pm.position.y += 4 * arc * e * (1 - e);
    if (victim && t > 0.6) {
      if (!hit) { hit = true; SFX.capture(); }
      victim.scale.setScalar(Math.max(0.001, 1 - (t - 0.6) / 0.4));
      victim.rotation.y += 0.25;
    }
  });
  if (!m.exit) SFX.land(type, state.board[m.r][m.c]);
  else SFX.exit();
  if (m.exit) await tween(350, t => { pm.position.z = to.z + (m.r < 0 ? -1 : 1) * t * 0.6; pm.scale.setScalar(Math.max(0.001, 1 - t)); });
}

// Feux d'artifice aux couleurs du gagnant : gerbes de particules (gravité + fondu), une par une au-dessus du plateau.
function burst(player) {
  const n = 90, o = new THREE.Vector3((Math.random() - 0.5) * 7, 4 + Math.random() * 2.5, (Math.random() - 0.5) * 7);
  const vel = Array.from({ length: n }, () => new THREE.Vector3().randomDirection().multiplyScalar(1.5 + Math.random()));
  const pos = new Float32Array(n * 3), geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ color: pieceMat[player].color.clone().offsetHSL(0, 0, Math.random() * 0.3), size: 0.14, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const pts = new THREE.Points(geo, mat);
  scene.add(pts);
  noise(0.5, 0.25, 3000);
  tween(1600, t => {
    const s = t * 1.6;
    vel.forEach((v, i) => pos.set([o.x + v.x * s, o.y + v.y * s - 1.5 * s * s, o.z + v.z * s], i * 3));
    geo.attributes.position.needsUpdate = true;
    mat.opacity = 1 - t * t;
  }).then(() => { scene.remove(pts); geo.dispose(); mat.dispose(); });
}
const fireworks = player => { for (let i = 0; i < 10; i++) setTimeout(burst, i * 300 + Math.random() * 200, player); };

// ---------- Partie ----------
function start({ board, terrain } = generateBoard($('terrain').value)) {
  viewEpoch++;
  localLocked = false; frozenSettings = null;
  human = onlineView() ? (seat || 1) : +$('side').value;
  state = newGame(board);
  $('terrainInfo').textContent = `Terrain : ${TERRAINS[terrain][0]}`;
  history = []; positions = [positionKey(state)]; selected = null; lastMove = null; animating = false; thinking = false;
  $('log').innerHTML = '';
  buildTerrain();
  buildPieces();
  recenter();
  if (!onlineView() && !localSetup) lockLocalSettings();
  render();
  maybeAI();
}

function log(msg) { $('log').insertAdjacentHTML('afterbegin', `<div>${msg}</div>`); }
const cellName = (r, c) => `${String.fromCharCode(65 + c)}${SIZE - r}`;

function describe(s, m) {
  const p = s.pieces.find(x => x.id === m.id);
  const who = `<span class="p${p.player}">${ICON[p.type]} ${NAME[p.type]}</span>`;
  if (m.exit) return `${who} franchit l'arrivée (+${p.str})`;
  if (m.capture) { const q = s.pieces.find(x => x.id === m.capture); return `${who} capture ${ICON[q.type]} en ${cellName(m.r, m.c)} (${m.a} ≥ ${m.d})`; }
  return `${who} → ${cellName(m.r, m.c)}`;
}

async function play(m) {
  lockLocalSettings();
  const game = state;
  animating = true; selected = null; render();
  await animateMove(m);
  if (state !== game) return; // nouvelle partie / annulation pendant l'animation
  log(`${state.moveCount + 1}. ${describe(state, m)}`);
  state = applyMove(state, m);
  lastMove = m; animating = false;
  afterMove();
}

function afterMove() {
  const remember = () => {
    const key = positionKey(state);
    positions.push(key);
    if (!state.gameOver && positions.filter(k => k === key).length >= 3)
      Object.assign(state, { gameOver: true, winner: 0, reason: 'Triple répétition' });
  };
  remember();
  while (!state.gameOver && !legalMoves(state).length) {
    log('Aucun coup possible, tour passé.'); state = passTurn(state); remember();
  }
  if (state.gameOver && state.winner) {
    const won = pvp || state.winner === human;
    (won ? SFX.win : SFX.lose)();
    fireworks(state.winner);
  }
  render();
  maybeAI();
}

// L'IA tourne dans un Worker ; repli sur le thread principal si necessaire.
let worker = null;
let aiRequest = 0;
try { worker = new Worker('ai-worker.js'); } catch { }
function think(s, depth, done) {
  const requestId = ++aiRequest;
  const local = () => setTimeout(() => done(bestMove(s, depth, 2500)), 50);
  if (!worker) return local();
  worker.onmessage = e => { if (e.data.requestId === requestId) done(e.data.move); };
  worker.onerror = () => { worker = null; local(); };
  worker.postMessage({ state: s, depth, timeMs: 2500, requestId });
}

function maybeAI() {
  if (pvp || onlineView() || localSetup || state.gameOver || state.turn === human) return;
  lockLocalSettings();
  thinking = true; render();
  const game = state;
  think(state, +$('level').value, m => {
    if (state !== game) return; // nouvelle partie lancée entre-temps
    thinking = false;
    if (!m) { state = passTurn(state); afterMove(); return; }
    play(m);
  });
}

const currentTargets = () => selected ? pieceMoves(state, state.pieces.find(p => p.id === selected)) : [];

function render() {
  if (pvp && !state.gameOver) human = state.turn; // 2 joueurs sur le même écran : la main suit le tour
  for (const p of state.pieces) { // synchronise les meshes avec l'état
    const m = pieceMeshes.get(p.id);
    m.visible = !p.captured && !p.finished;
    if (!m.visible || animating) continue;
    m.position.set(X(p.col), top(p.row, p.col), Z(p.row));
    m.scale.setScalar(1);
    m.rotation.y = p.player === 2 ? Math.PI : 0;
    m.material = (p.id === selected ? selMat : pieceMat)[p.player];
    m.userData = { r: p.row, c: p.col };
  }
  markerGroup.clear();
  for (const t of animating ? [] : currentTargets()) {
    if (t.exit) {
      const a = mesh(arrowGeo, moveMat, X(t.c), top(t.r < 0 ? 0 : SIZE - 1, t.c) + 0.25, Z(t.r) + (t.r < 0 ? 0.2 : -0.2), { r: t.r, c: t.c });
      a.rotation.x = t.r < 0 ? -Math.PI / 2 : Math.PI / 2; // pointe vers l'extérieur, flotte au niveau de la case voisine pour ne pas être cachée par le terrain
      markerGroup.add(a);
    } else markerGroup.add(mesh(t.capture ? attackGeo : moveGeo, t.capture ? attackMat : moveMat, X(t.c), top(t.r, t.c) + 0.02, Z(t.r), { r: t.r, c: t.c }));
  }
  if (lastMove && !lastMove.exit && !animating) markerGroup.add(mesh(lastGeo, lastMat, X(lastMove.c), top(lastMove.r, lastMove.c) + 0.015, Z(lastMove.r), { r: lastMove.r, c: lastMove.c }));

  $('s1').textContent = state.scores[0]; $('s2').textContent = state.scores[1]; $('mc').textContent = state.moveCount;
  $('undo').disabled = onlineView() || thinking || animating || !history.length;
  $('new').hidden = onlineView();
  $('new').textContent = localSetup ? 'Démarrer la partie' : (practice ? 'Nouvel entraînement' : 'Nouvelle partie');
  $('side').disabled = onlineView() || localParametersLocked();
  $('terrain').disabled = onlineView() ? (net.id !== hostId || latestRoom?.phase === 'playing') : localParametersLocked();
  $('level').disabled = onlineView() || pvp || localParametersLocked();
  $('pvp').disabled = !!net || localParametersLocked();
  $('pseudo').disabled = !!net;
  $('room').disabled = !!net;
  renderLobby();
  const col = pl => `<span class="p${pl}">${pl === 1 ? 'Rouge' : 'Bleu'}</span>`;
  $('status').innerHTML = state.gameOver
    ? (state.winner ? `${col(state.winner)} gagne ${state.winner === human && (!onlineView() || seat) ? '🎉' : ''}` : 'Match nul') + ` - ${state.reason}`
    : !onlineView() && localSetup ? 'Choisissez vos paramètres, puis démarrez la partie.'
    : onlineView() && latestRoom?.phase !== 'playing' ? 'En attente du lancement par l’admin.'
    : onlineView() && !seat ? `Spectateur : au tour de ${col(state.turn)}.`
    : thinking ? 'L’IA réfléchit…' : state.turn !== human ? `Au tour de l’adversaire (${col(state.turn)})…` : `À vous (${col(human)}) : choisissez une pièce.`;
}

function click(r, c) {
  if (!onlineView() && localSetup) return;
  if (state.gameOver || state.turn !== human || thinking || animating || pendingMove ||
    (onlineView() && (!seat || latestRoom?.phase !== 'playing' || !gameId))) return;
  const target = currentTargets().find(m => m.r === r && m.c === c);
  if (target) {
    if (onlineView()) {
      pendingMove = true;
      sendAction('game:move', { gameId, revision, id: target.id, r: target.r, c: target.c }, () => { pendingMove = false; });
      return;
    }
    history.push({ state, positions: [...positions], log: $('log').innerHTML });
    return busy = play(target);
  }
  const p = r >= 0 && r < SIZE && pieceAt(state, r, c);
  selected = p && p.player === human && p.id !== selected ? p.id : null;
  if (selected) SFX.select();
  render();
}

// ---------- Souris : clic (sans glisser) = sélection, survol = infos ----------
const raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2();
function pick(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  return raycaster.intersectObjects([...markerGroup.children, ...pieceGroup.children.filter(m => m.visible), ...terrainGroup.children])[0]?.object.userData;
}
let downAt = null;
renderer.domElement.addEventListener('pointerdown', e => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', e => {
  if (e.button !== 0 || !downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  const hit = pick(e);
  if (hit) click(hit.r, hit.c);
  if (e.pointerType !== 'mouse') hover(e); // pas de survol au doigt : le toucher affiche les infos
});
renderer.domElement.addEventListener('pointermove', hover);
function hover(e) {
  const hit = pick(e);
  let text = '', clickable = false;
  if (hit && hit.r >= 0 && hit.r < SIZE) {
    const p = pieceAt(state, hit.r, hit.c), t = currentTargets().find(m => m.r === hit.r && m.c === hit.c);
    text = `${cellName(hit.r, hit.c)} - hauteur ${state.board[hit.r][hit.c]}`;
    if (p) text += ` · ${NAME[p.type]} ${p.player === 1 ? 'rouge' : 'bleu'} (mvt ${p.mv}, force ${p.str})`;
    if (t?.capture) text += ` · attaque ${t.a} vs défense ${t.d}`;
    clickable = !!t || (p && p.player === human);
  } else if (hit) {
    text = 'Arrivée';
    clickable = currentTargets().some(m => m.exit && m.c === hit.c && m.r === hit.r);
  }
  $('hover').textContent = text;
  renderer.domElement.style.cursor = clickable ? 'pointer' : '';
}

$('undo').onclick = () => {
  if (onlineView() || thinking || animating || !history.length) return;
  const h = history.pop();
  ({ state, positions } = h);
  $('log').innerHTML = h.log;
  selected = null; lastMove = null; render();
};
for (const [k, [label]] of Object.entries(TERRAINS)) $('terrain').add(new Option(label, k));
$('recenter').onclick = recenter;
const muteLabel = () => { $('mute').textContent = muted ? '🔇 Son coupé' : '🔊 Son'; };
$('mute').onclick = () => {
  muted = !muted; muteLabel();
  try { localStorage.setItem('traversal:muted', muted ? '1' : '0'); } catch { }
};
muteLabel();
$('music').onclick = () => setMusic(!musicOn);
$('musicVol').value = Math.round(musicVol * 100);
$('musicVol').oninput = e => {
  musicVol = e.target.value / 100;
  try { localStorage.setItem('traversal:musicVol', musicVol); } catch { }
  if (musicOut && musicOn) musicOut.gain.setTargetAtTime(musicVol, actx.currentTime, 0.05);
};
setMusic(musicOn);
$('new').onclick = async () => {
  if (onlineView()) return;
  if (localSetup) { localSetup = false; start(); return; }
  const epoch = viewEpoch;
  if (localParametersLocked()) {
    const answer = await Swal.fire({
      titleText: 'Annuler cet entraînement ?', text: 'La partie en cours sera abandonnée. Vous pourrez ensuite modifier les paramètres.',
      icon: 'warning', showCancelButton: true, confirmButtonText: 'Oui, nouvelle partie', cancelButtonText: 'Continuer à jouer',
      focusCancel: true, reverseButtons: true, heightAuto: false
    });
    if (!answer.isConfirmed || epoch !== viewEpoch) return;
  }
  localSetup = true; start();
};
const pvpLabel = () => { $('pvp').textContent = pvp ? '🤖 Jouer contre l’IA' : '👥 Jouer à 2'; };
$('pvp').onclick = () => { if (net || localParametersLocked()) return; pvp = !pvp; pvpLabel(); start(); };
pvpLabel();

// ---------- Salle : duel reserve, spectateurs et entrainement independant ----------
const onlineLabel = () => { $('online').textContent = net ? 'Quitter la salle' : 'Rejoindre la salle'; };

function renderLobby() {
  $('lobby').hidden = !net;
  if (!net || !latestRoom) return;
  const room = latestRoom;
  const admin = room.players.find(p => p.id === room.hostId);
  const challenger = room.players.find(p => p.id === room.challengerId);
  const isAdmin = net.id === room.hostId;
  const inDuel = room.duelIds.includes(net.id);
  const chosen = room.challengerId === net.id;
  $('networkStatus').textContent = `Salle ${room.room}${practice ? ' - entraînement local contre le bot' : ''}`;
  const messages = {
    lobby: `Admin : ${admin?.pseudo || ''}. Le premier joueur prêt réserve la place adverse.`,
    ready: `${admin?.pseudo || ''} contre ${challenger?.pseudo || ''} : duel réservé. L’admin peut lancer. ${room.nextHostSeat === 1 ? admin?.pseudo : challenger?.pseudo} commencera.`,
    playing: `Match en cours : ${room.players.find(p => p.seat === 1)?.pseudo || ''} (Rouge) contre ${room.players.find(p => p.seat === 2)?.pseudo || ''} (Bleu).`,
    finished: `Match terminé. Revanche : ${room.rematchReady.length}/2 accords.${room.ranked ? ' Statistiques enregistrées.' : ''}`
  };
  $('lobbyStatus').textContent = messages[room.phase];
  $('members').replaceChildren(...room.players.map(player => {
    const li = document.createElement('li');
    const role = player.seat ? (player.seat === 1 ? 'Rouge' : 'Bleu') : (player.id === room.hostId ? 'En attente' : 'Spectateur');
    li.textContent = `${player.pseudo} : ${player.id === room.hostId ? 'Admin - ' : ''}${role}${room.rematchReady.includes(player.id) ? ' - revanche acceptée' : ''}`;
    return li;
  }));
  $('ready').hidden = isAdmin || !['lobby', 'ready'].includes(room.phase);
  $('ready').disabled = !!room.challengerId && !chosen;
  $('ready').textContent = chosen ? 'Annuler prêt' : 'Prêt';
  $('launch').hidden = !isAdmin;
  $('launch').disabled = room.phase !== 'ready';
  $('rematch').hidden = room.phase !== 'finished' || !inDuel;
  $('rematch').disabled = room.rematchReady.includes(net.id);
  $('rematch').textContent = room.rematchReady.includes(net.id) ? 'Revanche demandée' : 'Revanche';
  $('resetDuel').hidden = !isAdmin;
  $('practice').disabled = room.phase === 'playing' && inDuel;
  $('practice').textContent = practice ? 'Voir le match / la salle' : 'Jouer contre le bot en attendant';
}

function leaveRoom() {
  if (!net) return;
  const old = net;
  session++; viewEpoch++; net = null; latestRoom = null; practice = false;
  localSetup = true;
  opponent = false; gameId = null; pendingMove = false; seat = 0;
  old.disconnect(); onlineLabel();
  $('networkStatus').textContent = 'Entraînement local, hors classement.';
}

function sendAction(event, data, done = () => {}) {
  const connection = net;
  if (!connection) return done();
  connection.timeout(5000).emit(event, data, (error, response) => {
    if (net !== connection) return;
    if (error || response?.error) $('networkStatus').textContent = response?.error || 'Le serveur ne répond pas. Rejoignez la salle.';
    done(response);
  });
}

function showMatch() {
  if (!net) return;
  practice = false; viewEpoch++; gameId = null; selected = null;
  if (latestRoom) busy = busy.then(() => receiveState(latestRoom, session));
}

async function receiveState(msg, generation) {
  if (!net || generation !== session) return;
  hostId = msg.hostId;
  const me = msg.players.find(p => p.id === net.id);
  if (!me) return;
  seat = me.seat;
  if (practice && msg.phase === 'playing' && msg.duelIds.includes(net.id)) {
    // Un lancement par l'admin ramene automatiquement les deux joueurs au duel.
    practice = false; viewEpoch++; gameId = null;
  }
  renderLobby();
  if (practice) { render(); return; }
  human = seat || 1;
  $('room').value = msg.room;
  opponent = msg.duelIds.length === 2;
  if (!msg.state) {
    gameId = null;
    if (!state || state.moveCount || thinking || animating) start();
    else render();
    return;
  }
  const fresh = gameId !== msg.gameId;
  if (!fresh && revision === msg.revision) { render(); return; }
  $('side').value = human;
  $('terrain').value = msg.terrain;
  if (fresh) {
    start({ board: msg.state.board, terrain: msg.terrain });
    gameId = msg.gameId;
    for (const [index, move] of msg.history.entries()) log(`${move.ply || index + 1}. ${describe(msg.state, move)}`);
  }
  const wasOver = !fresh && state.gameOver;
  if (msg.move && !fresh) {
    const epoch = viewEpoch;
    animating = true; selected = null; render();
    const description = describe(state, msg.move);
    await animateMove(msg.move);
    if (!net || generation !== session || practice || epoch !== viewEpoch) return;
    log(`${msg.state.moveCount}. ${description}`);
  }
  state = msg.state;
  revision = msg.revision;
  lastMove = msg.move || (fresh ? null : lastMove);
  animating = false; thinking = false; selected = null;
  if (state.gameOver && !wasOver && state.winner) {
    (!seat || state.winner === seat ? SFX.win : SFX.lose)();
    fireworks(state.winner);
  }
  render();
}

$('ready').onclick = () => sendAction('room:ready', { ready: latestRoom?.challengerId !== net?.id }, response => {
  if (response?.ok && practice) showMatch();
});
$('launch').onclick = () => sendAction('game:start', { terrain: $('terrain').value });
$('rematch').onclick = () => sendAction('game:rematch', { gameId: latestRoom?.gameId });
$('resetDuel').onclick = async () => {
  if (!net || latestRoom?.hostId !== net.id) return;
  const connection = net, match = latestRoom.gameId;
  const active = latestRoom.phase === 'playing';
  const answer = await Swal.fire({
    titleText: active ? 'Annuler le match en cours ?' : 'Repartir sur une nouvelle partie ?',
    text: 'Le plateau et la sélection des joueurs seront réinitialisés. Le match en cours ne comptera pas dans les statistiques. Les records déjà enregistrés sont conservés.',
    icon: 'warning', showCancelButton: true, confirmButtonText: active ? 'Oui, annuler le match' : 'Oui, nouvelle partie',
    cancelButtonText: active ? 'Continuer le match' : 'Garder la salle', focusCancel: true, reverseButtons: true, heightAuto: false
  });
  if (!answer.isConfirmed || net !== connection) return;
  sendAction('room:reset', { confirmed: true, gameId: match }, response => {
    if (response?.ok && practice) showMatch();
  });
};
$('practice').onclick = () => {
  if (!net) return;
  if (practice) return showMatch();
  if (latestRoom?.phase === 'playing' && latestRoom.duelIds.includes(net.id)) return;
  practice = true; viewEpoch++; pvp = false; selected = null; localSetup = true;
  start();
};

$('online').onclick = () => {
  if (net) { leaveRoom(); return start(); }
  const pseudo = $('pseudo').value.trim();
  if (!pseudo) { $('networkStatus').textContent = 'Indiquez votre pseudo pour rejoindre la salle.'; $('pseudo').focus(); return; }
  try { localStorage.setItem('tragame:pseudo', pseudo); } catch { }
  pvp = false; pvpLabel(); practice = false; latestRoom = null;
  const generation = ++session;
  const connection = net = io(siteBase.pathname.replace(/\/$/, ''), { reconnection: false, autoConnect: false });
  opponent = false; gameId = null; thinking = false; pendingMove = false; seat = 0;
  viewEpoch++;
  start(); busy = Promise.resolve();
  connection.on('connect', () => {
    sendAction('room:join', { pseudo, room: $('room').value, terrain: $('terrain').value }, response => {
      if (!response || response.error) {
        const message = response?.error || 'Connexion impossible.';
        leaveRoom(); start(); $('networkStatus').textContent = message;
      }
    });
  });
  connection.on('game:state', msg => {
    if (net !== connection) return;
    latestRoom = msg;
    renderLobby();
    busy = busy.then(() => receiveState(msg, generation)).catch(error => {
      console.error(error); $('networkStatus').textContent = 'Affichage désynchronisé. Rejoignez la salle.';
    });
  });
  connection.on('game:error', msg => { $('networkStatus').textContent = msg.error; });
  connection.on('scores:updated', refreshScores);
  const lost = () => {
    if (net !== connection) return;
    leaveRoom(); start(); $('networkStatus').textContent = 'Connexion perdue. Rejoignez la salle pour commencer une nouvelle partie.';
  };
  connection.on('connect_error', lost);
  connection.on('disconnect', lost);
  connection.connect(); onlineLabel();
};
onlineLabel();
for (const id of ['side', 'terrain', 'level']) $(id).onchange = () => {
  if (onlineView()) {
    if (id === 'terrain' && latestRoom?.phase !== 'playing' && net.id === hostId) return;
    if (id === 'terrain' && latestRoom?.state) $('terrain').value = latestRoom.terrain;
    if (id === 'side') $('side').value = human;
    return;
  }
  if (localParametersLocked()) { $(id).value = frozenSettings[id]; return; }
  if (id !== 'level') start();
};

// Tableau local : aucune dependance a un CDN, memes tris apres actualisation.
let statsTable = null;
const rankSort = [{ column: 'rank', dir: 'asc' }];
const numeric = { sorter: 'number', hozAlign: 'right', headerSortStartingDir: 'desc' };
function buildStatsTable(rows) {
  statsTable = new Tabulator('#leaderboard', {
    data: rows, index: 'pseudo', layout: 'fitDataFill', height: 390,
    pagination: 'local', paginationSize: 20, columnHeaderSortMulti: true,
    locale: 'fr', langs: { fr: { pagination: {
      first: 'Début', first_title: 'Première page', last: 'Fin', last_title: 'Dernière page',
      prev: 'Précédent', prev_title: 'Page précédente', next: 'Suivant', next_title: 'Page suivante',
      all: 'Tout', page_title: 'Page', page_size: 'Lignes par page'
    }, headerFilters: { default: 'Rechercher…' } } },
    sortOrderReverse: true, initialSort: rankSort,
    placeholder: 'Aucune partie terminée enregistrée.',
    columns: [
      { title: 'Rang victoires', field: 'rank', ...numeric, headerSortStartingDir: 'asc',
        formatter: cell => `${['🥇', '🥈', '🥉'][cell.getValue() - 1] || ''} ${cell.getValue()}` },
      { title: 'Pseudo', field: 'pseudo', sorter: 'string', formatter: 'plaintext', headerFilter: 'input', minWidth: 180 },
      { title: 'Victoires', field: 'wins', ...numeric },
      { title: 'Parties jouées', field: 'played', ...numeric },
      { title: 'Cumul dépl. gagnants', field: 'winning_moves_total', ...numeric },
      { title: 'Minimum pour gagner', field: 'best_win_moves', hozAlign: 'right', headerSortStartingDir: 'asc',
        formatter: cell => cell.getValue() === null ? '-' : String(cell.getValue()),
        sorter: (a, b, aRow, bRow, column, dir) => {
          if (a === null && b === null) return 0;
          if (a === null) return dir === 'asc' ? 1 : -1;
          if (b === null) return dir === 'asc' ? -1 : 1;
          return a - b;
        } },
      { title: 'Pièces capturées', field: 'captures', ...numeric },
      { title: 'Pièces perdues', field: 'losses', ...numeric }
    ]
  });
}

async function refreshScores() {
  $('refreshScores').disabled = true;
  try {
    const response = await fetch(new URL('leaderboard', siteBase));
    if (!response.ok) throw new Error('Classement indisponible.');
    const rows = await response.json();
    if (statsTable) await statsTable.replaceData(rows);
    else buildStatsTable(rows);
    $('scoresStatus').textContent = `${rows.length} joueur(s) dans le classement.`;
  } catch { $('scoresStatus').textContent = 'Classement indisponible. Réessayez avec Actualiser.'; }
  finally { $('refreshScores').disabled = false; }
}
$('scoreSort').onchange = () => {
  if (!statsTable) return;
  const field = $('scoreSort').value;
  statsTable.setSort(field === 'wins' ? rankSort : [
    { column: field, dir: field === 'best_win_moves' ? 'asc' : 'desc' },
    { column: 'rank', dir: 'asc' }
  ]);
};
$('refreshScores').onclick = refreshScores;
$('networkStatus').textContent = 'Entraînement local, hors classement.';
refreshScores();
start();
