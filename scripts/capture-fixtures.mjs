// One-time capture of real tiles around the default spawn (Times Square)
// into public/fixtures/, so the game can boot fully offline in fixture mode
// (NEXT_PUBLIC_FIXTURE=1) for deterministic smoke tests.
//
// Layout mirrors the live URL schemes (see engine/sources.ts):
//   terrain/15/{x}/{y}.png      AWS terrarium     (z/x/y)
//   imagery/15/{y}/{x}.jpg      Esri World Imagery (z/y/x!)
//   buildings/14/{x}/{y}.pbf    OpenFreeMap MVT    (z/x/y)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SPAWN_LAT = 40.758;
const SPAWN_LON = -73.9855;
const RADIUS = 1; // 3x3 ring at each zoom

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public/fixtures");

function tileXY(lat, lon, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );
  return { x, y };
}

async function save(url, path) {
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`skip ${url}: HTTP ${res.status}`);
    return false;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buf);
  console.log(`${path.replace(out + "/", "")} (${(buf.length / 1024).toFixed(0)} KB)`);
  return true;
}

async function ring(z, fn) {
  const { x: cx, y: cy } = tileXY(SPAWN_LAT, SPAWN_LON, z);
  const jobs = [];
  for (let dx = -RADIUS; dx <= RADIUS; dx++) {
    for (let dy = -RADIUS; dy <= RADIUS; dy++) {
      jobs.push(fn(cx + dx, cy + dy));
    }
  }
  await Promise.all(jobs);
}

// terrain z15
await ring(15, (x, y) =>
  save(
    `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/15/${x}/${y}.png`,
    join(out, `terrain/15/${x}/${y}.png`),
  ),
);

// imagery z15 (fixture mode forces imageryZoom=15 so one tile per chunk)
await ring(15, (x, y) =>
  save(
    `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/15/${y}/${x}`,
    join(out, `imagery/15/${y}/${x}.jpg`),
  ),
);

// buildings z14 via the live TileJSON-resolved template
const tilejson = await (await fetch("https://tiles.openfreemap.org/planet")).json();
const template = tilejson.tiles[0];
console.log("building template:", template);
await ring(14, (x, y) =>
  save(
    template.replace("{z}", "14").replace("{x}", String(x)).replace("{y}", String(y)),
    join(out, `buildings/14/${x}/${y}.pbf`),
  ),
);

console.log("fixture capture complete");
