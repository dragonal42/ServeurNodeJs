// ============================================================
//  ATTRAPE-ÉTOILES — mini-jeu multijoueur de démonstration
//  p5.js (dessin) + Socket.IO (réseau) + server.js générique
// ------------------------------------------------------------
//  Principe :
//   • Toute personne qui ouvre la page est un joueur de la room
//     commune. On se déplace (flèches / ZQSD / WASD, ou clic /
//     doigt maintenu) pour attraper les étoiles.
//   • Premier à SCORE_VICTOIRE gagne la manche, puis tout repart à 0.
//
//  Qui décide quoi ? (le serveur ne connaît pas les règles)
//   • Chaque joueur est maître de SA position : il la diffuse
//     aux autres (game:broadcast), environ 15 fois par seconde.
//   • L'HÔTE (joueur le plus ancien, élu par le serveur) est
//     l'arbitre : il fait apparaître les étoiles, valide les
//     prises et tient les scores. Ses décisions sont envoyées à
//     tous avec game:event (reçu en game:update, lui compris).
//   • Un nouveau venu reçoit l'état complet de l'hôte en privé
//     (game:to → game:direct).
//   • Si l'hôte part, le serveur en élit un autre ; comme chaque
//     joueur a une copie des étoiles et des scores, le nouveau
//     arbitre continue la partie sans coupure.
// ============================================================
'use strict';

// ---------- Réglages du jeu ----------
const MONDE          = { w: 800, h: 500 };  // taille logique du terrain
const RAYON_JOUEUR   = 16;
const RAYON_ETOILE   = 12;
const VITESSE        = 230;   // pixels logiques / seconde
const NB_ETOILES     = 4;     // étoiles présentes en même temps
const SCORE_VICTOIRE = 10;
const ENVOI_MS       = 66;    // fréquence d'envoi de ma position (~15/s)
const BATTEMENT_MS   = 1000;  // renvoi même immobile (pour les nouveaux)
const TOLERANCE_PRISE = 40;   // marge de l'arbitre (latence réseau)

// ---------- État local ----------
let socket;
let moi = null;               // { id, name, color } — fourni par le serveur
let hoteId = null;            // id du joueur arbitre
const joueurs  = new Map();   // id → { id, name, color, x, y, ax, ay, score, vu }
const etoiles  = new Map();   // id → { id, x, y }
const demandes = new Map();   // id étoile → horodatage (évite de spammer l'hôte)
let cible = null;             // destination au clic / doigt
let dernierEnvoi = 0, dernierX = -1, dernierY = -1;
let echelle = 1;
let particules = [];
let banniere = null;          // { texte, couleur, fin }
let compteurEtoiles = 0;

const suisHote = () => moi !== null && hoteId === moi.id;


// ============================================================
//  1. RÉSEAU
// ============================================================
function connecter() {
  // io() sans URL = même domaine que la page (multi.billiar.info).
  // Pas de « room » dans la query → le serveur nous met dans la
  // room commune. Le pseudo mémorisé est envoyé dès la connexion.
  socket = io({
    transports: ['websocket', 'polling'],
    query: { name: localStorage.getItem('pseudo') || '' },
  });

  socket.on('connect', () => majStatut());
  socket.on('disconnect', () => majStatut());
  socket.io.engine?.on?.('upgrade', () => majStatut());

  // --- Accueil : le serveur nous dit qui on est et qui est là ---
  socket.on('room:welcome', ({ you, players, hostId }) => {
    moi = you;
    joueurs.clear();
    etoiles.clear();              // l'hôte va nous envoyer l'état à jour
    for (const p of players) ajouterJoueur(p);

    // Ma position de départ : au hasard sur le terrain
    const j = joueurs.get(moi.id);
    j.x = j.ax = random(60, MONDE.w - 60);
    j.y = j.ay = random(60, MONDE.h - 60);
    j.vu = true;

    document.getElementById('pseudo').value = moi.name;
    changerHote(hostId);
    envoyerPosition(true);
    majHUD();
  });

  // --- Présence ---
  socket.on('room:player-joined', ({ player }) => {
    ajouterJoueur(player);
    envoyerPosition(true);        // qu'il nous voie tout de suite
    if (suisHote()) {             // l'arbitre lui envoie l'état complet, en privé
      socket.emit('game:to', player.id, {
        t: 'etat', etoiles: [...etoiles.values()], scores: lireScores(),
      });
    }
    majHUD();
  });

  socket.on('room:player-left', ({ id }) => {
    joueurs.delete(id);
    majHUD();
  });

  socket.on('room:player-updated', ({ player }) => {
    const j = joueurs.get(player.id);
    if (j) { j.name = player.name; j.color = player.color; }
    majHUD();
  });

  socket.on('room:host', ({ hostId }) => changerHote(hostId));

  // --- Messages des autres joueurs (positions) ---
  socket.on('game:broadcast', ({ from, data }) => {
    const j = joueurs.get(from);
    if (!j || !data) return;
    if (data.t === 'pos') {
      j.x = data.x; j.y = data.y;   // position « cible » ; l'affichage
      if (!j.vu) { j.ax = j.x; j.ay = j.y; j.vu = true; }  // glisse vers elle
    }
  });

  // --- Messages privés ---
  socket.on('game:direct', ({ from, data }) => {
    if (!data) return;
    // État complet envoyé par l'arbitre à un nouveau venu
    if (data.t === 'etat' && from === hoteId) {
      etoiles.clear();
      for (const e of data.etoiles) etoiles.set(e.id, e);
      appliquerScores(data.scores);
      majHUD();
    }
    // Demande de prise envoyée à l'arbitre
    if (data.t === 'attrape' && suisHote()) arbitrerPrise(from, data.etoile);
  });

  // --- Décisions de l'arbitre (reçues par tous, arbitre compris) ---
  socket.on('game:update', ({ from, data }) => {
    if (!data || from !== hoteId) return;   // seul l'arbitre fait foi

    if (data.t === 'etoiles') {             // liste complète d'étoiles
      etoiles.clear();
      for (const e of data.liste) etoiles.set(e.id, e);
    }

    if (data.t === 'prise') {               // une étoile a été attrapée
      // x/y fournis par l'arbitre : l'effet s'affiche même chez lui
      // (il a déjà retiré l'étoile de sa liste au moment de décider)
      explosion(data.x, data.y, joueurs.get(data.par)?.color || '#fff');
      etoiles.delete(data.etoile);
      if (data.nouvelle) etoiles.set(data.nouvelle.id, data.nouvelle);
      const j = joueurs.get(data.par);
      if (j) j.score = data.score;
      demandes.delete(data.etoile);
      majHUD();
    }

    if (data.t === 'victoire') {            // fin de manche
      const j = joueurs.get(data.par);
      banniere = {
        texte: `${j ? j.name : 'Un joueur'} gagne la manche ! 🏆`,
        couleur: j ? j.color : '#fff',
        fin: millis() + 3500,
      };
      for (const p of joueurs.values()) p.score = 0;
      majHUD();
    }
  });
}

function ajouterJoueur(p) {
  if (!joueurs.has(p.id)) {
    joueurs.set(p.id, { ...p, x: 0, y: 0, ax: 0, ay: 0, score: 0, vu: false });
  }
}

function changerHote(id) {
  hoteId = id;
  if (suisHote()) garantirEtoiles();   // je deviens arbitre : je complète le terrain
  majHUD();
}

// Diffuse ma position aux autres (seulement si elle a changé,
// ou régulièrement pour les nouveaux arrivants).
function envoyerPosition(forcer = false) {
  const j = moi && joueurs.get(moi.id);
  if (!j || !socket.connected) return;
  const x = Math.round(j.x), y = Math.round(j.y);
  const maintenant = millis();
  const bouge = x !== dernierX || y !== dernierY;
  if (forcer || (bouge && maintenant - dernierEnvoi > ENVOI_MS) ||
      maintenant - dernierEnvoi > BATTEMENT_MS) {
    socket.emit('game:broadcast', { t: 'pos', x, y });
    dernierEnvoi = maintenant; dernierX = x; dernierY = y;
  }
}

function lireScores() {
  const s = {};
  for (const j of joueurs.values()) s[j.id] = j.score;
  return s;
}

function appliquerScores(scores) {
  for (const [id, sc] of Object.entries(scores || {})) {
    const j = joueurs.get(id);
    if (j) j.score = sc;
  }
}


// ============================================================
//  2. ARBITRAGE (exécuté uniquement par l'hôte)
// ============================================================
function nouvelleEtoile() {
  return {
    id: `${moi.id.slice(0, 4)}-${++compteurEtoiles}`,
    x: Math.round(random(40, MONDE.w - 40)),
    y: Math.round(random(40, MONDE.h - 40)),
  };
}

// Complète le terrain jusqu'à NB_ETOILES et publie la liste
function garantirEtoiles() {
  if (!suisHote()) return;
  while (etoiles.size < NB_ETOILES) {
    const e = nouvelleEtoile();
    etoiles.set(e.id, e);
  }
  socket.emit('game:event', { t: 'etoiles', liste: [...etoiles.values()] });
}

// Un joueur dit « j'ai attrapé l'étoile X » : l'arbitre vérifie
function arbitrerPrise(joueurId, etoileId) {
  const e = etoiles.get(etoileId);
  const j = joueurs.get(joueurId);
  if (!e || !j) return;                          // déjà prise, ou joueur parti

  const distance = dist(j.x, j.y, e.x, e.y);     // dernière position connue
  if (distance > RAYON_JOUEUR + RAYON_ETOILE + TOLERANCE_PRISE) return;

  // Retrait immédiat chez l'arbitre → impossible de la compter deux fois
  etoiles.delete(etoileId);
  j.score += 1;
  const nouvelle = nouvelleEtoile();
  etoiles.set(nouvelle.id, nouvelle);

  socket.emit('game:event', {
    t: 'prise', etoile: etoileId, x: e.x, y: e.y, par: joueurId, score: j.score, nouvelle,
  });

  if (j.score >= SCORE_VICTOIRE) {
    socket.emit('game:event', { t: 'victoire', par: joueurId });
    for (const p of joueurs.values()) p.score = 0;
  }
}


// ============================================================
//  3. p5.js — boucle de jeu
// ============================================================
function setup() {
  const canvas = createCanvas(10, 10);
  canvas.parent('terrain');
  ajusterTaille();
  textFont('sans-serif');   // un seul nom : p5 ne gère pas les listes CSS
  connecter();

  // Changement de pseudo (mémorisé dans le navigateur)
  document.getElementById('pseudo').addEventListener('change', (ev) => {
    const nom = ev.target.value.trim().slice(0, 20);
    if (!nom) return;
    localStorage.setItem('pseudo', nom);
    socket.emit('player:update', { name: nom });
    ev.target.blur();
  });
}

function windowResized() { ajusterTaille(); }

function ajusterTaille() {
  const largeur = Math.min(windowWidth - 24, 1000);
  echelle = Math.max(0.3, Math.min(largeur / MONDE.w, (windowHeight - 170) / MONDE.h));
  resizeCanvas(Math.floor(MONDE.w * echelle), Math.floor(MONDE.h * echelle));
}

function draw() {
  const dt = Math.min(deltaTime / 1000, 0.05);   // secondes, bornées

  deplacerMoi(dt);
  verifierPrises();
  envoyerPosition();

  // Les autres joueurs glissent vers leur dernière position reçue
  // (interpolation : mouvement fluide malgré ~15 messages/s)
  for (const j of joueurs.values()) {
    if (moi && j.id === moi.id) { j.ax = j.x; j.ay = j.y; continue; }
    j.ax = lerp(j.ax, j.x, 0.25);
    j.ay = lerp(j.ay, j.y, 0.25);
  }

  push();
  scale(echelle);
  dessinerFond();
  for (const e of etoiles.values()) dessinerEtoile(e);
  dessinerParticules(dt);
  for (const j of joueurs.values()) if (j.vu) dessinerJoueur(j);
  pop();

  dessinerBanniere();
  if (!socket?.connected) dessinerMessage('Connexion au serveur…');
}

// ---------- Déplacement de mon joueur ----------
function deplacerMoi(dt) {
  const j = moi && joueurs.get(moi.id);
  if (!j) return;

  // Clavier (sauf si on tape dans le champ pseudo)
  let dx = 0, dy = 0;
  if (document.activeElement?.tagName !== 'INPUT') {
    if (keyIsDown(LEFT_ARROW)  || keyIsDown(81) || keyIsDown(65)) dx -= 1; // ← Q A
    if (keyIsDown(RIGHT_ARROW) || keyIsDown(68))                  dx += 1; // → D
    if (keyIsDown(UP_ARROW)    || keyIsDown(90) || keyIsDown(87)) dy -= 1; // ↑ Z W
    if (keyIsDown(DOWN_ARROW)  || keyIsDown(83))                  dy += 1; // ↓ S
  }

  if (dx || dy) {
    cible = null;                                 // le clavier annule le clic
  } else {
    // Souris / doigt maintenu sur le terrain = aller vers ce point
    if (mouseIsPressed && mouseX >= 0 && mouseY >= 0 && mouseX <= width && mouseY <= height) {
      cible = { x: mouseX / echelle, y: mouseY / echelle };
    }
    if (cible) {
      const d = dist(j.x, j.y, cible.x, cible.y);
      if (d < 4) cible = null;
      else { dx = (cible.x - j.x) / d; dy = (cible.y - j.y) / d; }
    }
  }

  const n = Math.hypot(dx, dy);
  if (n > 0) {
    j.x = constrain(j.x + (dx / n) * VITESSE * dt, RAYON_JOUEUR, MONDE.w - RAYON_JOUEUR);
    j.y = constrain(j.y + (dy / n) * VITESSE * dt, RAYON_JOUEUR, MONDE.h - RAYON_JOUEUR);
  }
}

// ---------- Je touche une étoile ? → je demande à l'arbitre ----------
function verifierPrises() {
  const j = moi && joueurs.get(moi.id);
  if (!j || !hoteId) return;
  for (const e of etoiles.values()) {
    if (dist(j.x, j.y, e.x, e.y) > RAYON_JOUEUR + RAYON_ETOILE) continue;
    const derniere = demandes.get(e.id);
    if (derniere && millis() - derniere < 800) continue;  // déjà demandé
    demandes.set(e.id, millis());
    if (suisHote()) {
      arbitrerPrise(moi.id, e.id);                         // je suis l'arbitre
    } else {
      // Position envoyée JUSTE AVANT la demande : Socket.IO garantit
      // l'ordre des messages, donc l'arbitre juge sur ma position à jour.
      envoyerPosition(true);
      socket.emit('game:to', hoteId, { t: 'attrape', etoile: e.id });
    }
  }
}


// ============================================================
//  4. DESSIN
// ============================================================
function dessinerFond() {
  background(11, 16, 32);
  stroke(255, 255, 255, 14);
  strokeWeight(1);
  for (let x = 0; x <= MONDE.w; x += 40) line(x, 0, x, MONDE.h);
  for (let y = 0; y <= MONDE.h; y += 40) line(0, y, MONDE.w, y);
}

function dessinerEtoile(e) {
  const t = millis() / 1000;
  const pulse = 1 + 0.12 * sin(t * 4 + e.x);
  push();
  translate(e.x, e.y);
  rotate(t * 0.8);
  noStroke();
  fill(255, 210, 63, 40);                    // halo
  circle(0, 0, RAYON_ETOILE * 3.2 * pulse);
  fill(255, 210, 63);
  beginShape();                              // étoile à 5 branches
  for (let i = 0; i < 10; i++) {
    const r = (i % 2 === 0 ? RAYON_ETOILE : RAYON_ETOILE * 0.45) * pulse;
    const a = -HALF_PI + i * PI / 5;
    vertex(cos(a) * r, sin(a) * r);
  }
  endShape(CLOSE);
  pop();
}

function dessinerJoueur(j) {
  const estMoi = moi && j.id === moi.id;
  push();
  translate(j.ax, j.ay);
  noStroke();
  fill(color(j.color + '40'));               // ombre colorée
  circle(0, 0, RAYON_JOUEUR * 2.8);
  fill(j.color);
  stroke(estMoi ? 255 : 0, estMoi ? 255 : 90);
  strokeWeight(estMoi ? 3 : 1.5);
  circle(0, 0, RAYON_JOUEUR * 2);

  noStroke();
  fill(255);
  textSize(13);
  // Pseudo au-dessus du joueur, ou en dessous s'il est collé au bord haut
  const enHaut = j.ay > RAYON_JOUEUR + 24;
  textAlign(CENTER, enHaut ? BOTTOM : TOP);
  text((j.id === hoteId ? '👑 ' : '') + j.name + (estMoi ? ' (moi)' : ''),
       0, enHaut ? -RAYON_JOUEUR - 6 : RAYON_JOUEUR + 6);
  fill(11, 16, 32);
  textAlign(CENTER, CENTER);
  textStyle(BOLD);
  text(j.score, 0, 1);
  pop();
}

function explosion(x, y, couleur) {
  for (let i = 0; i < 18; i++) {
    const a = random(TWO_PI), v = random(60, 180);
    particules.push({ x, y, vx: cos(a) * v, vy: sin(a) * v, vie: 1, couleur });
  }
}

function dessinerParticules(dt) {
  noStroke();
  for (const p of particules) {
    p.x += p.vx * dt; p.y += p.vy * dt; p.vie -= dt * 1.6;
    const c = color(p.couleur);
    c.setAlpha(255 * Math.max(p.vie, 0));
    fill(c);
    circle(p.x, p.y, 6 * p.vie + 1);
  }
  particules = particules.filter(p => p.vie > 0);
}

function dessinerBanniere() {
  if (!banniere) return;
  if (millis() > banniere.fin) { banniere = null; return; }
  push();
  fill(0, 0, 0, 170);
  noStroke();
  rect(0, height / 2 - 40, width, 80);
  fill(banniere.couleur);
  textAlign(CENTER, CENTER);
  textSize(Math.max(16, 30 * echelle));
  textStyle(BOLD);
  text(banniere.texte, width / 2, height / 2);
  pop();
}

function dessinerMessage(msg) {
  push();
  fill(0, 0, 0, 150);
  noStroke();
  rect(0, 0, width, height);
  fill(255);
  textAlign(CENTER, CENTER);
  textSize(18);
  text(msg, width / 2, height / 2);
  pop();
}


// ============================================================
//  5. INTERFACE HTML (tableau des scores, statut)
// ============================================================
function majStatut() {
  const el = document.getElementById('statut');
  if (!socket?.connected) { el.textContent = '🔴 déconnecté'; return; }
  const transport = socket.io.engine?.transport?.name || '?';
  el.textContent = `🟢 connecté (${transport})`;
}

function majHUD() {
  majStatut();
  const liste = document.getElementById('scores');
  liste.replaceChildren();
  const tries = [...joueurs.values()].sort((a, b) => b.score - a.score);
  for (const j of tries) {
    const li = document.createElement('li');
    const pastille = document.createElement('span');
    pastille.className = 'pastille';
    pastille.style.background = j.color;
    li.append(pastille);
    // textContent (et pas innerHTML) : un pseudo ne peut pas injecter de HTML
    li.append(document.createTextNode(
      `${j.id === hoteId ? '👑 ' : ''}${j.name}${moi && j.id === moi.id ? ' (moi)' : ''} — ${j.score}`));
    liste.append(li);
  }
  document.getElementById('nb').textContent = joueurs.size;
  document.getElementById('role').textContent = suisHote()
    ? 'Vous êtes l\'arbitre 👑 (vous gérez les étoiles)'
    : '';
}

// Empêche la page de défiler quand on joue au doigt sur le terrain
document.addEventListener('touchmove', (e) => {
  if (e.target.tagName === 'CANVAS') e.preventDefault();
}, { passive: false });
