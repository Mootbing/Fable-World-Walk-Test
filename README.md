# World Walk

A first-person, open-world explorer of the **real world**, built with Next.js +
TypeScript + Three.js. Spawn at a real location (default: Times Square) and
walk the actual streets: satellite imagery is draped over real terrain
elevation, and buildings are extruded at their true heights from OpenStreetMap
data. Everything streams in live around you as you walk — no preprocessing, no
API keys.

## Quickstart

```bash
npm install
npm run dev
```

Open http://localhost:3000, wait for the spawn area to stream in, then click
**Click to walk**.

**Controls:** WASD to move, Shift to sprint, mouse to look, Esc to release the
pointer.

## How it works

| Layer | Source | Mechanism |
| --- | --- | --- |
| Ground texture | Esri World Imagery (keyless XYZ tiles) | 4×4 z17 tiles composited per chunk into one 1024² texture |
| Elevation | AWS Open Data terrarium tiles (Mapzen/Tilezen) | z15 PNG → `h = R·256 + G + B/256 − 32768` → displaced 128×128 grid |
| Buildings | OpenFreeMap z14 vector tiles (OpenMapTiles/OSM) | MVT footprints extruded by `render_height`, merged to one mesh per tile |

The world is a local tangent frame anchored at spawn (1 unit = 1 true meter;
Web Mercator inflation corrected by cos(lat)). A 5×5 ring of ~926 m chunks
streams around the player with full GPU-resource disposal on unload. Walking
uses a custom 2.5D kinematic controller: bilinear ground clamping (falling
through the world is impossible by construction) plus circle-vs-footprint
push-out against a spatial hash of building walls — no physics engine.

## Configuration

Copy `.env.local.example` to `.env.local`. Highlights:

- `NEXT_PUBLIC_SPAWN_LAT` / `NEXT_PUBLIC_SPAWN_LON` — spawn anywhere on Earth
- `NEXT_PUBLIC_IMAGERY_ZOOM` — ground sharpness (17 ≈ 0.9 m/px, 18/19 cost 4×/16× the tiles)
- `NEXT_PUBLIC_MAPBOX_TOKEN` — switches imagery to Mapbox Satellite
- `NEXT_PUBLIC_TERRAIN_TEMPLATE` — alternate terrarium source (e.g. Mapterhorn)

## Known limitations

- Building height quality follows OSM coverage: ~90% real heights in Manhattan,
  far fewer elsewhere (unmapped buildings get a 10 m default).
- 2.5D world: no bridges, underpasses, or walkable roofs.
- Bare-earth DEM + flat building bases means slight float/sink on steep slopes.
- Tile sources are third-party free services — be a good citizen (the app
  fetches on demand only and never bulk-caches; required attribution is shown
  in the HUD).
