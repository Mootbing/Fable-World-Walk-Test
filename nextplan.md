# Plan: Building Textures

Research-backed plan for texturing the extruded buildings (currently flat
gray). All data claims below were live-verified (tile decodes, license pages,
three.js 0.184 source) on 2026-06-11. Constraints preserved throughout: free +
keyless data, ~1 draw call per z14 tile, frame-sliced streaming builds.

## Phase 1 — Real per-building color (smallest step, big payoff)

The OpenFreeMap `building` layer already includes a `colour` field on **87.2%
of Times Square-tile buildings** (1291/1481, measured live): OSM
`building:colour`, or a material-derived fallback (glass `#5a81a0`, brick
`#bd8161`, concrete `#d3c2b0`, …). Values mix hex and CSS names ("beige",
"darkgray") — parse with `THREE.Color().setStyle()` in try/catch +
`convertSRGBToLinear()`.

- `engine/buildings.ts`: capture `props.colour`; before merge, write a
  per-vertex `color` attribute per building. Untagged buildings get a
  deterministic 4–6 tone palette pick keyed on a feature hash (variety instead
  of uniform gray). Darken roof-cap vertices ~15% for wall/roof separation.
- `engine/buildingManager.ts`: `vertexColors: true` on the shared material.
- Cost: zero new fetches, keeps 1 draw call/tile. Coverage varies by city
  (NYC FiDi 91%, London 76%, Paris 26%, SF 13%) — the palette fallback covers
  the gaps.

## Phase 2 — Procedural facade shader (windows, floors)

Extend the one shared `MeshLambertMaterial` with `onBeforeCompile` (verified
viable in r184: hook runs before include-resolution, so replacing
`#include <map_fragment>` works; also set `customProgramCacheKey`). Do **not**
migrate to TSL/NodeMaterial — that requires WebGPURenderer.

- Vertex: emit `vWPos = (modelMatrix * vec4(transformed,1)).xyz` and
  `vWNormal = objectNormal` (tile matrices are translation-only, so object
  normal == world normal).
- Fragment: wall vs roof via `abs(N.y) < 0.5`. Horizontal facade coordinate
  via the per-face tangent `u = dot(vWPos.xz, normalize(cross(up, N)).xz)` —
  constant meters-per-window on walls of any orientation (dominant-axis
  selection would stretch ~14% on Manhattan's rotated grid). Vertical from
  world Y. Grid: ~3.3 m floors, ~4 m window bays (Streets GL convention);
  window cells inset/darkened, per-cell `hash(cell, buildingSeed)` variation.
- Anti-aliasing: fade the pattern to plain wall when `fwidth(u)` approaches a
  cell — procedural grids moiré at distance without this.
- Per-building seed (and optionally base elevation, to anchor floor 0 at the
  building base) ride along as a float vertex attribute written at merge time.
- Night mode later gets free wins here: emissive lit-window hash per cell.

## Phase 3 — Texture-atlas facades (optional realism upgrade)

Swap the procedural grid for real facade textures, same shader slot:

- Start with a runtime canvas-generated atlas (mrdoob-city style window grids,
  4–16 variants, nearest-neighbor upscale) — zero assets, zero licenses.
- For photo realism: assemble a committed atlas from **ambientCG Facade001–020
  (CC0, redistribution OK)**; no ready-made small atlas exists anywhere, but a
  one-off script (download 1K JPGs → 256px cells → 1024px atlas) is trivial.
- Tiling inside an atlas breaks hardware wrap + mips: either `fract()` per
  cell in-shader or a `THREE.DataArrayTexture` (WebGL2, supported in r184) with
  a per-vertex layer-index attribute.
- Real UVs (u = perimeter meters): keep ExtrudeGeometry and pass a custom
  `UVGenerator` — `generateSideWallUV` is called per side quad in contour
  order (verified in r184 source), so a closure accumulator yields perimeter
  distance; snap to an integer window count per wall (Streets GL trick:
  `windowCount = round(wallLen/4); u /= wallLen/windowCount`) so no
  half-windows at corners. (If extrusion is ever rewritten: a hand-rolled
  wall-strip builder measured ~2.4× faster than ExtrudeGeometry and can skip
  the useless bottom caps.)

## Phase 4 — Real satellite rooftops

Roof caps can show their actual appearance: one z14 building tile spans
exactly 2×2 z15 terrain chunks = the same 8×8 z17 Esri tiles the terrain
already fetched (browser HTTP cache makes re-requests ~free). Composite them
per building tile into a 1024² roof texture (z16-equivalent detail; 2048² is
sharper but ~22 MB/tile GPU — not worth it), rewrite cap UVs to tile-space
(cap UVs are already tile-local meters in shape space — verified, the mapping
is exact), and sample it in the shader's roof branch. Known limitation:
off-nadir lean in Esri imagery slightly offsets tall-tower roofs.

## Phase 5 (future) — Overture buildings + night

The official Overture `buildings.pmtiles` (keyless S3, range-requests verified
working, 179 GB remote/queried per-tile) carries `facade_material`,
`facade_color`, `roof_color`, `roof_shape`, `num_floors` globally — a
secondary source where OSM colour coverage is thin, and the input for
material-aware facade variants (glass towers vs brick walkups). Plus night
mode: sky/fog swap + emissive window cells from Phase 2's hash.

## Suggested order

Phase 1 alone is one small PR and transforms midtown immediately. Phase 2
gives street-level depth; 1+2 together are "textured city" for most eyes.
Phases 3/4 are independent polish tracks; 5 is a separate data project.
