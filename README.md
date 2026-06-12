# World Walk

An open-world, GTA-style game set in the **real world**, running entirely in
the browser. The city streams live from public map data — satellite imagery
draped over real elevation, buildings extruded at their true heights, the
actual OSM road network — and all gameplay simulation runs in a Rust →
WebAssembly core at a fixed 60Hz. No preprocessing, no API keys, no assets:
every vehicle, character, sound and radio station is procedural.

Spawn at a real location (default: Midtown Manhattan), steal a car, pick up
taxi fares, outrun a six-star response, fly a helicopter over the actual
skyline, or swim the Hudson.

## Quickstart

```bash
npm install        # one-time: also needs rustup target wasm32-unknown-unknown + wasm-pack
npm run dev        # http://localhost:3001
```

Wait for the spawn area to stream in, then click **Click to play**.

| Key | Action |
| --- | --- |
| WASD | move / drive |
| Shift | sprint · helicopter descend |
| Space | jump · handbrake · helicopter climb |
| E | enter / exit vehicles (cars, bikes, boats, helis) |
| LMB / RMB | attack / aim |
| Tab · 1–5 · Q | weapon wheel · slots · cycle |
| R | reload · radio stations (in a vehicle) |
| T | start taxi / vigilante / paramedic work (in the right vehicle) |
| V | first / third person |
| M · G · H | full map · road debug · horn |
| Esc | pause (save/load slots, settings, stats) |

## What's in the game

- **Driving**: 9 vehicle kinds (sedan→sport, taxi, police, motorcycle with
  corner lean, boat, helicopter) on arcade bicycle-model physics with
  handbrake drift; ambient traffic follows the real one-way street graph with
  IDM car-following and intersection arbitration.
- **Crime & combat**: melee + 4 firearms, wanted levels 1–6 (cops on foot,
  pursuit cruisers, roadblocks, police air support), busted/wasted with real
  hospital and precinct respawns from OSM POIs.
- **Missions & jobs**: a scripted mission arc plus chaining taxi fares,
  vigilante bounties and paramedic runs; pay'n'spray and weapon shops at real
  `car_repair` / hardware POIs; 6 hidden packages seeded per road tile.
- **A living world**: pedestrians with panic, day/night cycle with headlights
  and lit windows, Markov weather with wet handling and lightning, swimmable
  water from the MVT water layer, bridges that hold their decks, procedural
  audio (engines, sirens, gunfire) and three generative radio stations.
- **Persistence**: three save slots (position, money, arsenal, wanted,
  packages, lifetime stats) in localStorage.

## Architecture

```
TS / Three.js (render + streaming)        Rust → wasm (sim, 60Hz substeps)
┌──────────────────────────────┐          ┌──────────────────────────────┐
│ tile streaming: imagery,     │  flat    │ player physics · vehicles    │
│ terrain, buildings, roads,   │  arrays  │ traffic (IDM) · peds · cops  │
│ water, POIs                  │ ───────► │ weapons · wanted · weather   │
│ instanced pools: vehicles,   │          │ water · bridges · packages   │
│ peds, pickups (const draw    │ ◄─────── │ collision (prism + roofs)    │
│ calls) · HUD/minimap (React) │  entity  │ road graph + A* routing      │
└──────────────────────────────┘  buffer  └──────────────────────────────┘
```

- **One frame**: TS pushes an input bitfield; the sim runs fixed substeps and
  writes a stride-16 entity buffer (zero-copy `Float32Array` view) plus an
  event ring (gunshots, crashes, wanted changes) that drives FX, HUD and the
  audio engine.
- **The world is the map**: roads, buildings, water and POIs are parsed from
  OpenFreeMap z14 MVT tiles in TS and uploaded to the sim as flat arrays;
  revisited areas reproduce exactly (seeded per-tile RNG streams). The world
  is a local tangent frame anchored at spawn (1 unit = 1 true meter).
- **Data sources**: Esri World Imagery (ground), AWS Terrarium tiles
  (elevation), OpenFreeMap / OpenMapTiles / © OpenStreetMap contributors
  (buildings, roads, water, POIs, place names).

## Configuration

Copy `.env.local.example` to `.env.local`. Highlights:

- `NEXT_PUBLIC_SPAWN_LAT` / `NEXT_PUBLIC_SPAWN_LON` — spawn anywhere on Earth
- `NEXT_PUBLIC_IMAGERY_ZOOM` — ground sharpness (17 ≈ 0.9 m/px, 18/19 cost 4×/16× the tiles)
- `NEXT_PUBLIC_MAPBOX_TOKEN` — switches imagery to Mapbox Satellite
- `NEXT_PUBLIC_TERRAIN_TEMPLATE` — alternate terrarium source (e.g. Mapterhorn)
- `NEXT_PUBLIC_FIXTURE=1` — offline mode against the committed Midtown fixture tiles

## Development

```bash
npm run sim:dev     # debug wasm build (fast iteration)
npm run sim:test    # cargo test — 82 deterministic sim tests
npm run typecheck   # tsc --noEmit
npm run smoke       # Playwright end-to-end against offline fixture tiles
npm run build       # production build (chains a release wasm build)
```

- The smoke suite (`tests/smoke.spec.ts`) boots the game headlessly in fixture
  mode and plays every feature end-to-end — one assertion block per merged PR,
  driven through the `window.__ww` test hook.
- `ROADMAP.md` documents the full 38-PR build history with per-PR scope and
  verification notes, plus environment workarounds (no-sudo Chromium deps,
  `zig cc` as a host linker when no C toolchain is present).

## Known limitations

- Building height quality follows OSM coverage: ~90% real heights in
  Manhattan, far fewer elsewhere (unmapped buildings get a 10 m default).
- Bare-earth DEM + flat building bases means slight float/sink on steep
  slopes; tunnels aren't modeled (tunnel roads drape at grade).
- Tile sources are third-party free services — be a good citizen (the app
  fetches on demand only and never bulk-caches; required attribution is shown
  in the HUD).

## License notes

Map data © OpenStreetMap contributors (ODbL) via OpenFreeMap/OpenMapTiles.
Imagery © Esri and partners — see the in-game attribution footer. Terrain
from Mapzen/Tilezen terrarium tiles on AWS Open Data (USGS, NASA SRTM).
