import { CONFIG } from "./config";

export interface TileSource {
  url(z: number, x: number, y: number): string;
  /** Pixel size of one tile as served. */
  tileSize: number;
  maxZoom: number;
  /**
   * Some servers (Esri) return HTTP 200 with a constant blank image past
   * coverage; a response of exactly this many bytes is treated as "no data".
   */
  blankBytes?: number;
}

function fill(template: string, z: number, x: number, y: number): string {
  return template
    .replace("{z}", String(z))
    .replace("{x}", String(x))
    .replace("{y}", String(y));
}

export function imagerySource(): TileSource {
  if (CONFIG.imageryTemplate) {
    return { url: (z, x, y) => fill(CONFIG.imageryTemplate, z, x, y), tileSize: 256, maxZoom: 19 };
  }
  if (CONFIG.mapboxToken) {
    return {
      url: (z, x, y) =>
        `https://api.mapbox.com/v4/mapbox.satellite/${z}/${x}/${y}@2x.jpg90?access_token=${CONFIG.mapboxToken}`,
      tileSize: 512,
      maxZoom: 19,
    };
  }
  // Esri World Imagery. NOTE: ArcGIS REST path order is {z}/{y}/{x}.
  return {
    url: (z, x, y) =>
      `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    tileSize: 256,
    maxZoom: 19,
    blankBytes: 2521,
  };
}

export function terrainSource(): TileSource {
  if (CONFIG.terrainTemplate) {
    return { url: (z, x, y) => fill(CONFIG.terrainTemplate, z, x, y), tileSize: 256, maxZoom: 15 };
  }
  return {
    url: (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
    tileSize: 256,
    maxZoom: 15,
  };
}

const OPENFREEMAP_TILEJSON = "https://tiles.openfreemap.org/planet";

let buildingTemplate: string | null = null;

/**
 * OpenFreeMap serves tiles from a dated snapshot path that rotates weekly;
 * the current template must be resolved from TileJSON at runtime (and
 * re-resolved with force=true if tiles start 404ing mid-session).
 */
export async function resolveBuildingTemplate(force = false): Promise<string> {
  if (buildingTemplate && !force) return buildingTemplate;
  const res = await fetch(OPENFREEMAP_TILEJSON);
  if (!res.ok) throw new Error(`OpenFreeMap TileJSON failed: HTTP ${res.status}`);
  const tilejson = (await res.json()) as { tiles?: string[] };
  const template = tilejson.tiles?.[0];
  if (!template) throw new Error("OpenFreeMap TileJSON has no tiles entry");
  buildingTemplate = template;
  return template;
}

export function buildingTileUrl(template: string, z: number, x: number, y: number): string {
  return fill(template, z, x, y);
}
