import * as THREE from "three";
import Protobuf from "pbf";
import { VectorTile, VectorTileLayer } from "@mapbox/vector-tile";
import {
  WorldAnchor,
  tileToMercX,
  tileToMercY,
  mercXToLon,
  mercYToLat,
  tileMercSize,
} from "./geo";
import { HeightFieldRegistry } from "./heightField";

/** One extrudable building: rings in world XZ (first ring = exterior). */
export interface BuildingFeature {
  rings: [number, number][][];
  height: number;
  minHeight: number;
}

interface PolygonGeoJSON {
  geometry: {
    type: string;
    coordinates: number[][][] | number[][][][];
  };
}

export function parseBuildingLayer(buf: ArrayBuffer): VectorTileLayer | null {
  const tile = new VectorTile(new Protobuf(new Uint8Array(buf)));
  return tile.layers["building"] ?? null;
}

/**
 * Convert one MVT feature to world-space footprint(s). Returns [] for
 * non-buildings, hidden features, and features owned by a neighboring tile
 * (MVT buffers duplicate edge-crossing features into both tiles; the tile
 * containing the first vertex owns it).
 */
export function featureToBuildings(
  layer: VectorTileLayer,
  index: number,
  tx: number,
  ty: number,
  zoom: number,
  anchor: WorldAnchor,
): BuildingFeature[] {
  const feature = layer.feature(index);
  const props = feature.properties as Record<string, unknown>;
  if (props.hide_3d === true) return [];

  const gj = feature.toGeoJSON(tx, ty, zoom) as unknown as PolygonGeoJSON;
  const polygons: number[][][][] =
    gj.geometry.type === "Polygon"
      ? [gj.geometry.coordinates as number[][][]]
      : gj.geometry.type === "MultiPolygon"
        ? (gj.geometry.coordinates as number[][][][])
        : [];
  if (polygons.length === 0) return [];

  // Ownership test in lon/lat against this tile's bounds.
  const west = mercXToLon(tileToMercX(tx, zoom));
  const east = mercXToLon(tileToMercX(tx, zoom) + tileMercSize(zoom));
  const north = mercYToLat(tileToMercY(ty, zoom));
  const south = mercYToLat(tileToMercY(ty, zoom) - tileMercSize(zoom));
  const first = polygons[0]?.[0]?.[0];
  if (!first) return [];
  const [flon, flat] = first;
  if (flon < west || flon >= east || flat > north || flat <= south) return [];

  const height = toNumber(props.render_height, 10);
  const minHeight = toNumber(props.render_min_height, 0);

  const out: BuildingFeature[] = [];
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
    if (rings.length > 0) out.push({ rings, height, minHeight });
  }
  return out;
}

function toNumber(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Extrude one building into geometry local to `origin` (its tile's NW
 * corner). Base sits at the lowest sampled ground under the footprint,
 * sunk 1.5 m to bury the seam on slopes.
 */
export function extrudeBuilding(
  building: BuildingFeature,
  origin: { x: number; z: number },
  heights: HeightFieldRegistry,
): THREE.BufferGeometry | null {
  const exterior = building.rings[0];
  const shape = new THREE.Shape();
  shape.moveTo(exterior[0][0] - origin.x, -(exterior[0][1] - origin.z));
  for (let i = 1; i < exterior.length; i++) {
    shape.lineTo(exterior[i][0] - origin.x, -(exterior[i][1] - origin.z));
  }
  for (let r = 1; r < building.rings.length; r++) {
    const hole = building.rings[r];
    const path = new THREE.Path();
    path.moveTo(hole[0][0] - origin.x, -(hole[0][1] - origin.z));
    for (let i = 1; i < hole.length; i++) {
      path.lineTo(hole[i][0] - origin.x, -(hole[i][1] - origin.z));
    }
    shape.holes.push(path);
  }

  let ground = Infinity;
  for (const [wx, wz] of exterior) {
    const h = heights.sample(wx, wz);
    if (h !== null && h < ground) ground = h;
  }
  if (!Number.isFinite(ground)) ground = 0;

  const depth = Math.max(building.height - building.minHeight, 3);
  let geometry: THREE.BufferGeometry;
  try {
    geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  } catch {
    return null; // degenerate footprint
  }
  // Shape plane (x, y=north) -> world (x, y up, z south): z_world = -shape.y.
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, ground - 1.5 + building.minHeight, 0);
  // Drop the extrude UVs so tiles can merge with positions+normals only.
  geometry.deleteAttribute("uv");

  // Subtle per-building tint (hash of the footprint anchor) so blocks
  // read as separate structures instead of one gray mass.
  let h = (Math.round(exterior[0][0] * 7) ^ (Math.round(exterior[0][1] * 13) << 11)) >>> 0;
  h = ((h * 2654435761) ^ (h >>> 15)) >>> 0;
  const warm = 0.9 + ((h & 0xff) / 255) * 0.1; // 0.90..1.00
  const cool = 0.9 + (((h >>> 8) & 0xff) / 255) * 0.1;
  const r = warm;
  const g = (warm + cool) / 2;
  const b = cool;
  const n = geometry.getAttribute("position").count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colors[i * 3] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}
