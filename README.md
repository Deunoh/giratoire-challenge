# 🔄 Giratoire Challenge

Un jeu web style borne d'arcade où les joueurs s'affrontent pour trouver l'itinéraire entre deux villes françaises comportant le plus de ronds-points.

## 🎮 Comment jouer

1. Appuie sur **START**
2. Entre ton **pseudo**
3. Choisis une **ville de départ** et une **ville d'arrivée** en France
4. Le jeu calcule l'itinéraire et compte les ronds-points traversés
5. Ton score est enregistré au **classement** — essaie de battre les autres joueurs !

## 📁 Structure du projet

```
├── server.js          # Serveur Express (géocodage, routage, comptage des ronds-points)
├── leaderboard.json   # Persistance du classement
├── package.json       # Dépendances et scripts npm
└── public/
    ├── index.html     # Interface arcade (écrans titre, jeu, résultat, classement)
    ├── app.js         # Logique frontend
    └── style.css      # Style rétro arcade (CRT, scanlines, pixel font)
```

## 🚀 Installation

```sh
git clone <url-du-repo>
cd giratoire-challenge
npm install
```

## ▶️ Lancer le jeu

```sh
npm start
```

Ouvre ensuite [http://localhost:3000](http://localhost:3000) dans ton navigateur.

## 🛠️ Technologies & APIs

| Composant | Technologie |
|---|---|
| Backend | **Node.js** / **Express** |
| Frontend | HTML, CSS, JavaScript vanilla |
| Police | Press Start 2P (Google Fonts) |
| Géocodage | [Nominatim](https://nominatim.openstreetmap.org/) (OpenStreetMap) |
| Itinéraire | [OSRM](https://router.project-osrm.org/) |
| Ronds-points | [Overpass API](https://overpass-api.de/) |
| Sécurité | Helmet, CORS, express-rate-limit |

## 📄 Licence

ISC
