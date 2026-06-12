import { VectorTile, VectorTileLayer } from "@mapbox/vector-tile";
import Protobuf from "pbf";
import { WorldAnchor } from "./geo";
import {
  mercXToLon,
  mercYToLat,
  tileMercSize,
  tileToMercX,
  tileToMercY,
} from "./geo";

/** One water body: exterior ring + holes, world coordinates. */
export interface WaterPoly {
  rings: [number, number][][];
}

interface PolygonGeoJSON {
  geometry: {
    type: string;
    coordinates: number[][][] | number[][][][];
  };
}

/**
 * Water polygons from the MVT `water` layer (ocean/river/lake/pond —
 * pools too; swimming is swimming). Same ownership rule as buildings:
 * the tile containing the first vertex owns an edge-crossing feature.
 */
export function extractWater(
  buf: ArrayBuffer,
  tx: number,
  ty: number,
  zoom: number,
  anchor: WorldAnchor,
): WaterPoly[] {
  let layer: VectorTileLayer | undefined;
  try {
    const tile = new VectorTile(new Protobuf(new Uint8Array(buf)));
    layer = tile.layers["water"];
  } catch {
    return [];
  }
  if (!layer) return [];

  const west = mercXToLon(tileToMercX(tx, zoom));
  const east = mercXToLon(tileToMercX(tx, zoom) + tileMercSize(zoom));
  const north = mercYToLat(tileToMercY(ty, zoom));
  const south = mercYToLat(tileToMercY(ty, zoom) - tileMercSize(zoom));

  const out: WaterPoly[] = [];
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    const gj = feature.toGeoJSON(tx, ty, zoom) as unknown as PolygonGeoJSON;
    const polygons: number[][][][] =
      gj.geometry.type === "Polygon"
        ? [gj.geometry.coordinates as number[][][]]
        : gj.geometry.type === "MultiPolygon"
          ? (gj.geometry.coordinates as number[][][][])
          : [];
    const first = polygons[0]?.[0]?.[0];
    if (!first) continue;
    const [flon, flat] = first;
    if (flon < west || flon >= east || flat > north || flat <= south) continue;

    for (const polygon of polygons) {
      const rings: [number, number][][] = [];
      for (const ring of polygon) {
        const worldRing: [number, number][] = [];
        for (const [lon, lat] of ring) {
          const w = anchor.lonLatToWorld(lon, lat);
          worldRing.push([w.x, w.z]);
        }
        if (worldRing.length >= 4) rings.push(worldRing);
      }
      if (rings.length > 0) out.push({ rings });
    }
  }
  return out;
}

/** Flatten polys for the wasm upload: coords, ring sizes, rings/poly. */
export function flattenWater(polys: WaterPoly[]): {
  coords: Float32Array;
  ringSizes: Uint32Array;
  polyRingCounts: Uint32Array;
} {
  const coords: number[] = [];
  const ringSizes: number[] = [];
  const polyRingCounts: number[] = [];
  for (const p of polys) {
    polyRingCounts.push(p.rings.length);
    for (const ring of p.rings) {
      ringSizes.push(ring.length);
      for (const [x, z] of ring) coords.push(x, z);
    }
  }
  return {
    coords: new Float32Array(coords),
    ringSizes: new Uint32Array(ringSizes),
    polyRingCounts: new Uint32Array(polyRingCounts),
  };
}
