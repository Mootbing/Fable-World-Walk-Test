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
- [ ] **PR5 `feat: third-person camera + visible player character`** —
  `engine/input.ts` (pointer-lock + InputFrame, replaces drei
  PointerLockControls), `engine/render/cameraRig.ts` (fp/tp-foot modes, V
  toggle), procedural ped meshes + rigid-limb gait animation
  (`engine/render/{pedMeshes,pedAnimator,entityPools}.ts`), analytic boom
  occlusion vs building prisms. *Accept:* see yourself walk/jump from behind;
  camera never enters buildings; fp unchanged.

## Phase 2 — Driving

- [ ] **PR6 `feat: arcade vehicle physics + first drivable car`** — bicycle
  model w/ grip circle + handbrake (`sim/src/vehicle.rs`), E enter/exit with
  exit-position validation, tp-drive chase cam (speed FOV), one procedural
  sedan near spawn. *Accept:* drive a block, handbrake turn, crash into a
  building and stop, exit.
- [ ] **PR7 `feat: vehicle variety + instanced entity renderer kit`** —
  archetype pools (sedan/hatch/van/taxi/police + shared wheel pool, palette
  via instanceColor, liveries); debug spawn row. *Accept:* 50 parked cars at
  steady fps; each class feels distinct.
- [ ] **PR8 `feat: road graph extraction from MVT transportation layer`** —
  parse `transportation` from the already-fetched z14 MVTs in JS
  (`engine/roads.ts`, clip to tile bounds), upload polylines+attrs; Rust graph
  build: 0.5 m quantized node merge gated on `brunnel`/`layer`, border
  stitching, directed lane edges (RHT offsets), class speeds; F3 debug
  overlay (LineSegments). *Accept:* overlay hugs real streets; fixture tests
  (Manhattan/London/LA) ≥90 % connectivity.
- [ ] **PR9 `feat: ambient traffic v1`** — spawn annulus 150–400 m (seeded
  per tile), lane following, IDM car-following, despawn rules incl. tile
  unload (player vehicle pinned). *Accept:* 20–40 cars driving on the right,
  queuing cleanly; 5-min soak no NaN/teleport.
- [ ] **PR10 `feat: intersection arbitration + traffic polish`** — class
  priority, gap acceptance, all-way tie-break, deadlock timeout→creep,
  virtual signal phases at major×major nodes, brake lights. *Accept:* busy
  intersection flows for 5 min, no gridlock; Rust 10k-tick deadlock test.

## Phase 3 — Living city

- [ ] **PR11 `feat: pedestrians v1`** — sidewalk offsets from road graph,
  wander + separation, building collision, traffic brakes for crossing peds.
- [ ] **PR12 `feat: ped/vehicle interactions + carjacking + horn`** — traffic
  drivers, E yanks driver (flee), horn (H) scatters, vehicle-vs-ped knockdown.
- [ ] **PR13 `feat: radar minimap`** — canvas radar from road polylines,
  rotates with heading, blip API, cached per-tile backdrops.
- [ ] **PR14 `feat: full map + waypoint + GPS routing`** — M pannable map,
  click waypoint, A* in Rust over road graph, magenta GPS polyline, reroute.
- [ ] **PR15 `feat: area-name toasts + clock HUD`** — `place` layer →
  neighborhood fade-toasts; game clock on HUD.

## Phase 4 — Crime & combat

- [ ] **PR16 `feat: health/armor/money/pickups/death+respawn`** — stats in
  sim, fall damage, pickups (spin/bob), death fade → respawn + fee.
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
