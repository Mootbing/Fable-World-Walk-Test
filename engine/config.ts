function num(v: string | undefined, fallback: number): number {
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const CONFIG = {
  spawnLat: num(process.env.NEXT_PUBLIC_SPAWN_LAT, 40.758),
  spawnLon: num(process.env.NEXT_PUBLIC_SPAWN_LON, -73.9855),

  /** World seed for all deterministic sim randomness (traffic, peds, ...). */
  seed: num(process.env.NEXT_PUBLIC_SEED, 1337),

  /** Chunk unit. Fixed: AWS terrarium tiles top out at z15. */
  terrainZoom: 15,
  /** Ground texture zoom; each chunk composites a 2^(iz-15) square of tiles. */
  imageryZoom: Math.min(19, Math.max(15, num(process.env.NEXT_PUBLIC_IMAGERY_ZOOM, 17))),
  /** Fixed: OpenFreeMap vector tiles top out at z14. */
  buildingZoom: 14,

  loadRadius: Math.min(4, Math.max(1, num(process.env.NEXT_PUBLIC_LOAD_RADIUS, 2))),
  fetchConcurrency: Math.min(12, Math.max(2, num(process.env.NEXT_PUBLIC_FETCH_CONCURRENCY, 6))),

  mapboxToken: process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "",
  imageryTemplate: process.env.NEXT_PUBLIC_IMAGERY_TEMPLATE ?? "",
  terrainTemplate: process.env.NEXT_PUBLIC_TERRAIN_TEMPLATE ?? "",

  walkSpeed: 1.6,
  sprintSpeed: 5.5,
  eyeHeight: 1.7,
  playerRadius: 0.35,

  fogNear: 250,
  fogFar: 1250,
  skyColor: "#aec8e0",
};
