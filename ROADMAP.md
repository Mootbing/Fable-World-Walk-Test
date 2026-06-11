# World Walk → GTA: Roadmap

Pivot of World Walk (first-person real-world walker) into a GTA-like open-world
game **on the real-world map**: real OSM buildings/terrain/imagery stay; a
Rust→WASM sim core (`sim/`) owns all gameplay (player, vehicles, traffic, peds,
combat, police); Three.js stays as the renderer reading entity buffers from
wasm memory. Full architecture: see the PR descriptions and `sim/src/lib.rs`.

Executed one PR at a time, in order. Every PR passes the gate before merge:

1. `npm run typecheck`
2. `npm run sim:test` (cargo test)
3. `npm run build`
4. `npm run smoke` (from PR2 on — Playwright, offline fixtures, port-safe)

Dev server runs on **port 3001** (3000 belongs to another app on this machine).

## Phase 1 — WASM foundation & embodiment

- [x] **PR1 `chore: Rust sim crate + wasm-pack pipeline wired into Next.js`** —
  `sim/` crate (wasm-bindgen, fixed 60 Hz substep accumulator, seeded
  SplitMix64/PCG32 rng), `engine/sim/simBridge.ts` (explicit
  `init({module_or_path:"/sim_bg.wasm"})`, zero-copy view helpers),
  entity-buffer ABI in `engine/sim/entityLayout.ts`, npm scripts
  (`sim:build`/`sim:dev`/`sim:test`, build chaining), HUD sim heartbeat,
  1k-entity readback benchmark logged at boot.
  *Accept:* HUD shows rising `sim #tick`; bench < 0.2 ms/pass; game plays
  exactly as before.
- [x] **PR2 `test: offline tile fixtures + Playwright smoke harness + window.__ww test API`** —
  fixture tiles (terrain/imagery/buildings, 3×3 rings, 4.7 MB) around spawn
  under `public/fixtures/`, `NEXT_PUBLIC_FIXTURE=1` short-circuits
  `sources.ts` (+ forces radius 1 / imagery z15); Playwright `npm run smoke`
  boots offline on its own port, `window.__ww` (`ready/query/cmd/press`)
  drives it; asserts ready, sim ticking, W walks north, world meshed
  (≥9 meshes, >100k tris), zero page errors, screenshot artifact.
- [x] **PR3 `feat: player physics in Rust`** — heightfield upload on tile
  load/unload (registry mirror hooks + pre-init queue), gravity + jump
  (Space) + ledge falls in `sim/src/player.rs` (ports the TS step clamp and
  ground low-pass), input bitfield + event ring protocol (JUMP/LAND), player
  written as entity 0; `engine/player.ts` deleted; TS building collision kept
  via per-frame correction writeback until PR4. *Verified:* 15 Rust tests
  (jump arc apex ≈1 m, cliff detach, determinism), smoke asserts jump+events
  in-browser.
- [x] **PR4 `feat: building collision in Rust`** — spatial hash + circle
  pushout (incl. rowhouse rescue + courtyard even-odd) ported verbatim to
  `sim/src/collision.rs`; walk-blocking footprints (minHeight ≤ 2.5) flat-
  uploaded per z14 tile via BuildingManager hooks (+ pre-init queue); the
  PR3 setPlayerPos correction writeback removed — one physics world; TS
  CollisionWorld stays populated as the future camera-occlusion oracle
  (PR5). *Verified:* 21 Rust tests (rowhouse, courtyard, wall-block), smoke
  probes a real Times Square wall via `resolve_probe`.
- [x] **PR5 `feat: third-person camera + visible player character`** —
  `engine/input.ts` (pointer-lock + InputFrame, drei PointerLockControls
  removed), `engine/render/cameraRig.ts` (fp/tp modes, V toggle, snap-in/
  relax-out boom, speed-ready shoulder offset), `engine/render/
  playerAvatar.ts` (rigid-limb gait body from entity-0 lanes — the ped
  archetype prototype for PR7 pools), analytic boom occlusion: TS
  CollisionWorld became the prism oracle (`segmentHits` + height span over
  sampled ground; dead resolve path deleted). Also: postcss override
  (dependabot alert cleared). *Verified:* smoke toggles tp (camera >1.5m
  back, avatar visible, screenshot), fp restored; walk/jump unchanged.

## Phase 2 — Driving

- [x] **PR6 `feat: arcade vehicle physics + first drivable car`** — bicycle
  model with lateral-slip channel + handbrake drift (`sim/src/vehicle.rs`),
  3-circle body collision with crash events, E enter/exit (door offsets
  validated against collision), starter sedan spawns at world-open, chase
  cam with auto-recenter + speed FOV, procedural sedan render (steering/
  spinning wheels), speedometer + "Press E" toast. *Verified:* 26 Rust
  tests (accel/brake/reverse, curve, handbrake slide, wall crash+stop,
  enter/drive/exit round trip), smoke drives the car in-browser.
- [x] **PR7 `feat: vehicle variety + instanced entity renderer kit`** —
  six kinds (sedan/hatch/van/taxi/police/sport) with per-class handling
  specs in Rust (`VehicleSpec` table) + render kits in TS; InstancedMesh
  pools (per-kind body+cabin, shared wheel pool, livery topper pool) with
  per-instance palette paint — constant draw calls at any fleet size;
  `spawnRow` debug cmd; HUD shows vehicle name. *Verified:* 27 Rust tests
  (class envelopes ordered van<sedan<sport), smoke spawns 24-car fleet with
  ≤2 new scene meshes + screenshot.
- [x] **PR8 `feat: road graph extraction from MVT transportation layer`** —
  `engine/roads.ts` parses `transportation` from the already-fetched z14
  MVTs (affine tile→world, Liang-Barsky clip to exact tile bounds, flat
  upload); Rust `roads.rs` builds the directed graph incrementally: 0.5 m
  quantized node merge (interiors fuse only same `brunnel`/`layer` level;
  endpoints by position so bridges connect), cross-tile stitching falls out
  of clip+quantize, oneway → single directed edge, class speeds; G-key /
  cmd debug overlay (LineSegments draped on terrain); connectivity metric
  is **edge-length weighted** (real tiles have many genuinely-isolated
  service fragments — midtown probe: 113 components, main grid 78.6 km vs
  0.6 km runner-up). *Verified:* 7 graph unit tests (4-way, overpass
  isolation, bridge continuity, T-junction order-independence, stitch,
  unload/reload, oneway); smoke on real midtown: 1126 edges, 0.895
  connectivity, overlay 3542 verts.
- [x] **PR9 `feat: ambient traffic v1`** — `sim/src/traffic.rs`: kinematic
  path-followers on the directed graph (same entity records → instanced
  pools render them for free): spawn annulus 120–350 m with class-weighted
  edge selection + kind mix (taxis!), RHT lane offset 1.7 m, IDM
  car-following (same edge chain + the player's car as a corridor leader),
  seeded straight-preferring turns (no U-turns unless dead end), despawn
  on distance/edge-unload (graph unload returns removed edge ids), player
  car can't drive through traffic (circle pushout + crash events).
  *Verified:* 38 Rust tests (no rear-end over 30 s, brakes for parked
  player car, motion through nodes, despawn), smoke: ≥8 cars on real
  midtown streets, moving, finite, sim 1.5 ms.
- [x] **PR10 `feat: intersection arbitration + traffic polish`** — stop
  lines as virtual IDM leaders; unsignaled: class priority (minor yields
  to primary) → arrival order → id tie-break, single crossing-group
  occupant holds the box; signaled (two major flows crossing): stateless
  position-hashed phase clock (8 s, survives reloads); deadlock breaker:
  5 s stopped → creep through at 2.5 m/s; FLAG_BRAKING lane bit (visuals
  in PR29); RoadGraph nodes gained in-edge indexing. *Verified:* 41 Rust
  tests — minor brakes 8→2.4 m/s while primary holds speed, signal passes
  both flows, **10k-tick contention: every car keeps moving**; smoke
  observes live braking in midtown traffic.

## Phase 3 — Living city

- [x] **PR11 `feat: pedestrians v1`** — `sim/src/peds.rs`: rail-walkers on
  class-based sidewalk offsets (no motorway/trunk), personal lateral
  jitter + walk speeds, speed-matching personal space, corner crossings as
  straight segments between rails (traffic hard-brakes for crossers in the
  lane corridor — never closer than 1.5 m in tests), building pushout,
  spawn annulus 60–200 m / despawn 250 m; rendered via 4 instanced pools
  (torso/head/arm/leg, shirt palette via instanceColor, gait swing from
  the animPhase lane). *Verified:* 45 Rust tests; smoke: ≥5 peds strolling
  real sidewalks.
- [x] **PR12 `feat: ped/vehicle interactions + carjacking + horn`** — ped
  state machine (Walking/Fleeing/Down): E on a traffic car carjacks it
  (car converts to owned Vehicle, driver bails the far door and flees,
  EV_CARJACK), H horn scatters peds within 14 m (EV_HORN), car body
  contact ≥1.5 m/s knocks peds down (tip-flat render pose, EV_PED_HIT,
  get up → flee); off-grid parked traffic (debug_spawn_traffic) for
  setups/tests; "Press E" toast now includes traffic cars. *Verified:*
  47 Rust tests (carjack consumes traffic + spawns fleeing driver,
  knockdown), smoke carjacks a spawned taxi + honks in-browser.
- [x] **PR13 `feat: radar minimap`** — `components/Minimap.tsx`: 2D canvas
  radar outside the R3F tree on its own 15 Hz clock; real streets stroked
  from `engine.roadTiles` (class-based widths), rotate-with-heading
  (`engine.camYaw`), circular clip, speed-based zoom, player chevron,
  vehicle/police blips from the entity buffer, generic `engine.blips` API
  for future systems, N rim marker; `engineRef` module handle for
  DOM-side components; HUD stats moved top-left. *Verified:* smoke counts
  >800 street-stroke pixels on the painted radar.
- [x] **PR14 `feat: full map + waypoint + GPS routing`** — multi-seed A*
  in Rust (both directed twins seeded at start AND goal — single-snap
  routing backtracked 100 m; oneway-respecting, same-edge slice
  shortcut); M toggles a pannable/zoomable full map (click = waypoint,
  pointer lock handed off both ways), magenta route on radar + map,
  engine GPS state (2 s arrival check <18 m, deviation >35 m → reroute).
  *Verified:* 50 Rust tests (grid route ≈500 m through the corner,
  oneway refusal, same-edge slice), smoke routes 250 m north on real
  streets + counts magenta radar pixels + M round-trip.
- [x] **PR15 `feat: area-name toasts + clock HUD`** — `engine/places.ts`
  extracts the `place` layer (neighbourhood/quarter/suburb, tier-banded
  nearest match: Hell's Kitchen beats Midtown beats Manhattan); on area
  change the classic serif fade-toast appears lower-right; game clock
  (1 real s = 1 game min, drives day/night in PR29) top-right.
  *Verified:* smoke resolves a real neighborhood name at spawn + clock
  format. **Phase 3 complete.**

## Phase 4 — Crime & combat

- [x] **PR16 `feat: health/armor/money/pickups/death+respawn`** —
  `sim/src/stats.rs` (armor absorbs half, $250 start, $100 hospital fee,
  3.5 s respawn at spawn), `pickups.rs` (health/armor/money, radius
  collect, 3 starter pickups, spinning octahedra pool), fall damage above
  9 m/s landings, death gates all input, WASTED overlay + health/armor
  bars + money HUD. **Found & fixed: the boot drop (y=40 → ground) would
  have killed the player at spawn** — first-ever ground contact now snaps
  instead of falling. *Verified:* 55 Rust tests; smoke collects a pickup,
  dies (screenshot), respawns minus the fee.
- [ ] **PR17 `feat: melee combat + ped panic`** — punch combo, soft lock-on,
  knockdown/death + money drop, witness flee broadcast.
- [ ] **PR18 `feat: ranged combat v1 — pistol`** — weapon slots/ammo, RMB aim
  cam + crosshair, hitscan raycast in Rust (buildings 2.5D + capsules),
  tracer/muzzle/impact FX, reload, pickups.
- [ ] **PR19 `feat: weapon wheel + arsenal (bat, SMG, shotgun)`** — hold-Tab
  radial wheel, spread/recoil/pellets per weapon.
- [ ] **PR20 `feat: vehicle damage, fire, explosions`** — collision+bullet HP,
  smoke→fire→explosion staging, 8 m radius damage + chain reactions, husks.
- [ ] **PR21 `feat: wanted system v1 — stars 1–3, pursuit, busted`** — crime
  heat, cop spawns (foot→armed→cars w/ siren + A* pursuit), busted/evasion
  state machine, police-station respawn.
- [ ] **PR22 `feat: wanted v2 — 4★ roadblocks, spikes, hospital/police POI respawn`** —
  roadblocks ahead on graph, spike strips, PIT; `poi` layer registry.

## Phase 5 — Missions & progression

- [ ] **PR23 `feat: save/load + pause menu + settings`** — localStorage slots
  (position/money/weapons/flags/clock), Esc pause menu, settings.
- [ ] **PR24 `feat: mission framework + first mission`** — data-driven
  objective graphs, marker coronas, fail/reward, sim command API.
- [ ] **PR25 `feat: mission pack v1 — five-mission arc`** — courier, chase,
  escort, assassination, checkpoint race vs AI on graph routes.
- [ ] **PR26 `feat: taxi + vigilante side activities`** — routed fares with
  timer/payout chains; criminal-vehicle takedowns in police cars.
- [ ] **PR27 `feat: pay'n'spray + weapon shop + stats screen`** — `car_repair`
  POIs clear wanted ≤2★ + repair; buy menu; pause stats page.
- [ ] **PR28 `feat: hidden packages + ambulance activity`** — 50 seeded
  packages at POI-dense spots; timed patient delivery to hospitals.

## Phase 6 — Atmosphere & polish

- [ ] **PR29 `feat: day/night cycle + headlights + lit windows`** — clock-driven
  sun/sky/fog, emissive window cells, head/taillights, player spotlight cones.
- [ ] **PR30 `feat: weather system`** — Markov states, rain particles + grip
  multiplier, fog, lightning.
- [ ] **PR31 `feat: audio engine`** — WebAudio mixer, procedural engine loops
  (RPM-pitched), gunshots/sirens/impacts from the sim event ring, panner pool.
- [ ] **PR32 `feat: vehicle radio stations`** — 3 CC0 station loops, R cycles.
- [ ] **PR33 `feat: character models + animation pass`** — low-poly rigged
  GLBs or hero-LOD skinned ring; OSM building vertex colors.

## Phase 7 — Parity gap-fill & stretch

- [ ] **PR34 `feat: motorcycles`** — lean visuals, fall-off on impact.
- [ ] **PR35 `feat: water, swimming, boats`** — `water` layer planes, swim
  mode, boat class at coastlines.
- [ ] **PR36 `feat: helicopters + wanted 5–6★`** — simplified heli flight,
  police heli + spotlight, heavy response.
- [ ] **PR37 `feat: bridge decks + grade separation v2`** — elevated deck
  ribbons from `brunnel=bridge` + `layer`, drivable height overrides.
- [ ] **PR38 `chore: performance audit + title screen + docs`** — soak/profile
  budgets (sim <4 ms), title screen, README as game manual, parity audit.

Out of scope: planes, multiplayer, gangs/territory.

## Environment notes

- This machine has no system C toolchain and no sudo: host-side Rust linking
  (build scripts/proc-macros/`cargo test`) goes through portable `zig cc` via
  the gitignored `.cargo/config.toml`. Installing `build-essential` makes that
  workaround removable.
- Never kill processes by pattern (`pkill -f "next dev"`) — port 3000 hosts an
  unrelated app. Always target port 3001 / specific PIDs.
