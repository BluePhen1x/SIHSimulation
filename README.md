# SIHSimulation

A real OpenStreetMap-backed 3D city simulation built with React, Vite, and Three.js.

The app fetches real building and road data for an area of Bangalore, India from the
OpenStreetMap [Overpass API](https://overpass-api.de/), and renders it as a dark,
"digital twin" style 3D scene you can orbit, pan, and zoom around with the mouse.

Current features:
- Real OSM building footprints extruded into 3D blocks (height taken from
  `height`/`building:levels` tags, ~3m per floor, else 15m default)
- Buildings colored by OSM building type (amber for commercial/retail, blue for
  residential/apartments, with deterministic per-ID variation where untyped)
- Roads drawn as bright contrasting lines along their real OSM paths
- A high-altitude blimp marker (1,000m) with 5 camera coverage footprints that
  form one continuous combined ~3km ground coverage zone
- OrbitControls for camera navigation; drag to orbit, scroll to zoom
- Data cached locally in `src/data/bangalore-cache.json` (with localStorage
  fallback) so the app works offline without hammering the API

## Getting started

```sh
npm install
npm run dev
```

Open the local URL Vite prints (default http://localhost:5173/).

## Tech stack

- React + Vite
- Three.js (`three`) with OrbitControls
- `osmtogeojson` to convert raw Overpass API responses into GeoJSON
- OpenStreetMap / Overpass API only — no API keys or billing accounts

## Data

The bounding box covers roughly a 3.5km x 3.5km area centered on MG Road,
Bangalore (12.9720, 77.5945). To re-fetch fresh data, delete
`src/data/bangalore-cache.json` (and clear the page's localStorage) — the app
will then re-query the Overpass API on next load.