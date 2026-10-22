# TraGame - Traversal

Adaptation des sources locales `C:/Users/alain/Documents/JS/traversal` dans le
framework Fastify + Socket.IO de ServeurNodeJs, branche `feature/tragame`.

## Installation

Le dossier `TraGame/` se place a la racine du serveur, a cote de `server.js`.
Le chargeur existant decouvre `api.js`, sert `public/` sur `/TraGame/` et fournit
le namespace Socket.IO `/TraGame`. La page d'accueil liste automatiquement le jeu.
Aucune modification du serveur generique ni aucun sous-module ne sont necessaires.

Dans Docker, le dossier `seed/TraGame/` entre dans l'image et l'amorcage copie
les fichiers absents dans `/opt/nodejs/TraGame/`. Comme pour les autres fichiers
du depot, les fichiers deja presents sur le serveur ne sont jamais ecrases.
Pour une mise a jour d'une installation existante, copier le contenu complet de
`seed/TraGame/` par SFTP dans `/opt/nodejs/TraGame/`, puis toucher
`/opt/nodejs/tmp/restart.txt`. Ne pas remplacer le dossier `data/`.

La base `/opt/nodejs/data/tragame-scores.db` est creee automatiquement, hors de
`public/`. Elle reste dans le volume persistant. Sauvegarder ce fichier avec les
autres bases lorsque le serveur est arrete, ou utiliser une sauvegarde SQLite.
L'URL apres installation est `https://multi.billiar.info/TraGame/`.

En local : `npm ci`, puis `npm start` et ouvrir `http://localhost:3000/TraGame/`.
Le Dockerfile conserve son demarrage habituel avec `/app/server.js`.

## Jeu

Le plateau Three.js, les terrains, les pieces, les combats, les animations,
les sons synthetiques, la musique et les preferences d'affichage proviennent
des sources locales. Les modes contre l'IA et a deux sur le meme ecran restent
des entrainements locaux, hors statistiques. L'IA utilise un Web Worker.

En ligne, saisir un pseudo et creer une salle en laissant son code vide, ou
rejoindre une salle avec son code. La salle accueille jusqu'a 50 participants,
avec exactement deux joueurs par match et les autres comme spectateurs.
Le createur de la salle est l'admin et participe au duel.

Le premier autre participant qui clique sur **Pret** reserve la place adverse.
Le serveur traite les demandes dans leur ordre d'arrivee : une seule place peut
etre reservee, meme avec plusieurs demandes simultanees. Les autres regardent.
L'adversaire peut annuler son accord avant le lancement, ce qui libere la place.
L'admin choisit le terrain et clique sur **Lancer le match**. Ni une arrivee dans
la salle ni un clic d'un spectateur ne lancent ou ne remplacent un duel.

Les spectateurs voient le plateau courant, les mouvements animes et l'historique,
y compris en rejoignant un match deja commence. Ils peuvent cliquer sur
**Jouer contre le bot en attendant**, sans quitter la salle. Leur entrainement
local ne modifie ni le duel ni ses statistiques. **Voir le match / la salle**
revient au dernier etat public. Si un joueur du duel s'entrainait avant le
lancement, il revient automatiquement au match lorsque l'admin le lance.

Apres une partie, **Revanche** demande l'accord des deux joueurs du duel.
Quand les deux ont accepte, l'admin peut lancer la revanche. L'admin commence
la premiere partie ; ensuite les camps s'inversent apres chaque partie terminee,
match nul compris. Rouge commence toujours dans le moteur, mais le joueur Rouge
change : admin, adversaire, admin, etc. Une partie interrompue ne change pas
cette alternance. L'admin peut aussi choisir **Choisir un autre adversaire**
avant un lancement ou apres une fin de partie pour rouvrir la selection.

Le serveur genere le plateau, attribue les camps, valide chaque coup et calcule
le resultat. Les messages indiquent l'identifiant de partie et sa revision pour
refuser les coups doubles ou anciens. Le client ne peut pas envoyer de score.
Le depart d'un spectateur n'interrompt jamais le duel. Si un joueur du duel
quitte la salle, le match est interrompu et la selection revient au salon,
sans statistiques pour le match inacheve. Au depart de l'admin, le plus ancien
participant restant devient admin et une nouvelle selection est necessaire.
Les salles vivent en memoire.

## Statistiques et classement global

Les statistiques regroupent toutes les salles par pseudo exact, espaces externes
retires et Unicode normalise NFC. Il n'y a pas de compte ni de mot de passe :
le pseudo est une identite declarative, comme dans les autres jeux.

Seules les parties en ligne terminees selon les regles sont comptees :

| Champ | Definition |
|---|---|
| `wins` | Nombre de matchs gagnes |
| `played` | Nombre de parties terminees, victoires, defaites et nuls compris |
| `winning_moves_total` | Cumul des deplacements du joueur dans ses victoires |
| `best_win_moves` | Minimum de deplacements du joueur pour gagner, null sans victoire |
| `captures` | Pieces adverses capturees par une attaque legale, sur toutes les parties terminees |
| `losses` | Pieces du joueur capturees par l'adversaire, sur toutes les parties terminees |

Un deplacement correspond a un coup legal d'une piece, sortie comprise, quelle
que soit la distance parcourue. Les tours passes et les coups adverses ne sont
pas ajoutes au compteur du joueur. Une piece sortie n'est pas une piece perdue.
Les abandons, relances et deconnexions avant la fin ne modifient pas les compteurs.

Une transaction SQLite inscrit les deux joueurs et memorise l'identifiant de
partie dans `completed_games` : une meme partie ne peut pas compter deux fois.
Seuls les deux joueurs du duel sont inscrits : les spectateurs ne recoivent
aucune victoire, partie jouee, capture ou perte pour ce match.
Les mises a jour de plusieurs salles sont serialisees et un echec est annule.

`GET /TraGame/leaderboard` retourne tous les joueurs, classes par victoires
decroissantes, minimum gagnant croissant (null en dernier), captures
decroissantes, puis pseudo. Le champ `rank` represente ce classement permanent.

Tabulator propose une recherche par pseudo, une pagination et des tris sur
toutes les colonnes. Le menu propose les principaux tris. Maj + clic combine
plusieurs colonnes. Les medailles des rangs 1, 2 et 3 restent associees au
classement en victoires, meme lorsque l'affichage est trie selon un autre critere.

## Sources et dependances

Il n'y avait pas de PHP dans les sources locales. Le serveur Bun et le relais
WebSocket brut sont remplaces par `api.js` et Socket.IO. Aucun besoin de Bun,
de PHP, de base de questions ou d'un autre depot de jeu.

Three.js r170 et OrbitControls sont copies du dossier local `vendor/` et gardent
leurs mentions de licence. Tabulator 6.7.1 (MIT) est fourni dans `public/vendor/`,
avec sa licence. Aucun CDN n'est necessaire. La dependance de developpement
`tabulator-tables` permet de retrouver ces fichiers. Documentation des tris :
https://www.tabulator.info/docs/6.x/sort/.

Le moteur fourni est partage entre navigateur et serveur. Deux corrections
concernent les cas limites locaux : appliquer la limite des 200 coups aux tours
passes, et associer les reponses IA a la bonne demande apres une nouvelle partie.
La triple repetition est aussi controlee par le serveur.

## Verification

`npm test` execute les tests du moteur fourni et les tests d'integration.
Ces derniers lancent le vrai `seed/server.js` sur un port local temporaire avec
une copie isolee des fichiers et une base de test sous `tmp/`. Ils utilisent de
vrais clients Socket.IO et SQLite : routes, salles, camps, coups refuses,
injection de score ignoree, trois participants, course aux boutons Pret,
reservation annulee, lancement admin, spectateurs presents ou arrives en cours
de partie, revanche a deux accords, alternance sur trois matchs, partie gagnante,
match nul, deconnexion, succession du createur, isolation et conservation des
statistiques. Les tests SQLite couvrent
les cumuls, le minimum, les captures/pertes, les doubles enregistrements, les
transactions concurrentes, le rollback et la reouverture de la base.

Les tests locaux ne constituent pas une verification du serveur distant ni de
la construction de l'image Docker.
