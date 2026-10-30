# Plus Court — Paris

Trouve le trajet porte-à-porte **le plus rapide** à Paris, tous modes confondus :
marche, vélo perso, Vélib' (mécanique/électrique en temps réel), métro/RER/tram/bus,
et combinaisons Vélib' + transports.

## Pourquoi

Google Maps ne compare jamais tous les modes en même temps — et fait prendre des
détours à vélo. Ici, tout est classé par **durée réelle porte-à-porte** :

- 🚶 marche (itinéraire piéton OSM)
- 🚲 vélo perso (itinéraire vélo "le plus court", temps de cadenas inclus, parking vélo sécurisé proche)
- 🚲⚡ Vélib' mécanique et électrique : stations en service, nombre de verts/bleus
  en temps réel, places libres à l'arrivée, stations à ≥ 2 vélos seulement
- 🚇 transports en commun (Navitia temps réel : correspondances, marche souterraine,
  attente, perturbations)
- 🚲+🚇 combo Vélib' pour le premier/dernier kilomètre quand ça gagne du temps

Carte **3D relief** (OpenFreeMap + terrain) avec bâtiments en volume — sans image satellite.

## Stack

100 % statique, aucun serveur : TypeScript + Vite + MapLibre GL (PWA).

- **Navitia IDFM** (`prim.iledefrance-mobilites.fr`, clé requise) : itinéraires, lieux, perturbations
- **Vélib' GBFS via PRIM** : disponibilité temps réel
- **Valhalla public** (OSM) : itinéraires piéton/vélo avec dénivelé
- **Open-Meteo** : alerte pluie quand le vélo gagne
- **Overpass/OSM** : stationnement vélo (arceaux, parkings sécurisés)

## Dev

```bash
cp .env.example .env   # remplis VITE_PRIM_API_KEY (clé gratuite sur prim.iledefrance-mobilites.fr)
npm install
npm run dev
```

La clé n'est jamais commitée (`.env` est gitignoré).

## Limites connues

- La batterie par vélo n'est pas publiée dans les données publiques → on évite
  les stations à moins de 2 vélos (souvent des vélos en panne).
