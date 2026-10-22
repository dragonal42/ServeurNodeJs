// Calcule le coup de l'IA hors du thread d'affichage (la vue 3D reste fluide).
importScripts('engine.js');
onmessage = e => postMessage({ requestId: e.data.requestId, move: bestMove(e.data.state, e.data.depth, e.data.timeMs) });
