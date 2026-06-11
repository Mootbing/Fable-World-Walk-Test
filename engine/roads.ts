import Protobuf from "pbf";
import { VectorTile } from "@mapbox/vector-tile";
import { WorldAnchor } from "./geo";

/**
 * Road extraction from the OpenFreeMap z14 `transportation` layer — the
 * same MVT bytes BuildingManager already fetches, so roads cost zero extra
 * network. Output is the flat upload format consumed by sim/src/roads.rs
 * (and later the minimap): world-space polylines clipped to exact tile
 * bounds, so neighboring tiles meet precisely at the border and the Rust
 * graph stitches them by quantized position.
 */

export const ROAD_CLASSES = [
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "minor",
  "service",
] as const;

const CLASS_INDEX = new Map<string, number>(ROAD_CLASSES.map((c, i) => [c, i]));

export const ROAD_FLAG = {
  onewayFwd: 1,
  onewayRev: 2,
  bridge: 4,
  tunnel: 8,
  ramp: 16,
} as const;

export interface RoadTile {
  /** World XZ pairs for all polylines. */
  coords: Float32Array;
  /** Start vertex index per line + end sentinel. */
  lineOffsets: Uint32Array;
  /** Per line: class | flags<<8 | (layer+8)<<16. */
  lineAttrs: Uint32Array;
}

export function extractRoadTile(
  buf: ArrayBuffer,
  tx: number,
  ty: number,
  zoom: number,
  anchor: WorldAnchor,
): RoadTile | null {
  let layer;
  try {
    const tile = new VectorTile(new Protobuf(new Uint8Array(buf)));
    layer = tile.layers["transportation"];
  } catch {
    return null;
  }
  if (!layer) return null;

  const nw = anchor.tileNWWorld(tx, ty, zoom);
  const size = anchor.tileWorldSize(zoom);
  const maxX = nw.x + size;
  const maxZ = nw.z + size;

  const coords: number[] = [];
  const lineOffsets: number[] = [];
  const lineAttrs: number[] = [];
  let vertex = 0;

  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    const props = feature.properties as Record<string, unknown>;
    const cls = CLASS_INDEX.get(String(props.class));
    if (cls === undefined) continue;

    let flags = 0;
    if (props.oneway === 1 || props.oneway === "1") flags |= ROAD_FLAG.onewayFwd;
    else if (props.oneway === -1 || props.oneway === "-1") flags |= ROAD_FLAG.onewayRev;
    if (props.brunnel === "bridge") flags |= ROAD_FLAG.bridge;
    else if (props.brunnel === "tunnel") flags |= ROAD_FLAG.tunnel;
    if (props.ramp === 1 || props.ramp === "1") flags |= ROAD_FLAG.ramp;
    const layerVal = Math.max(-8, Math.min(7, Number(props.layer ?? 0) || 0));
    const attr = cls | (flags << 8) | (((layerVal + 8) & 0xff) << 16);

    // Raw tile-space geometry; tile→world is affine in Web Mercator.
    const extent = layer.extent;
    const geom = feature.loadGeometry();
    for (const line of geom) {
      if (line.length < 2) continue;
      const pts: [number, number][] = [];
      for (const p of line) {
        const wx = nw.x + (p.x / extent) * size;
        const wz = nw.z + (p.y / extent) * size;
        const last = pts[pts.length - 1];
        if (!last || Math.abs(last[0] - wx) > 1e-9 || Math.abs(last[1] - wz) > 1e-9) {
          pts.push([wx, wz]);
        }
      }
      // MVT buffers duplicate border-crossing lines into both tiles; clip
      // each to its exact tile rect so both contribute up to the shared
      // border and the graph fuses the endpoints.
      for (const piece of clipPolyline(pts, nw.x, nw.z, maxX, maxZ)) {
        if (piece.length < 2) continue;
        lineOffsets.push(vertex);
        lineAttrs.push(attr);
        for (const [x, z] of piece) {
          coords.push(x, z);
          vertex++;
        }
      }
    }
  }
  if (lineAttrs.length === 0) return null;
  lineOffsets.push(vertex);

  return {
    coords: new Float32Array(coords),
    lineOffsets: new Uint32Array(lineOffsets),
    lineAttrs: new Uint32Array(lineAttrs),
  };
}

/** Clip a polyline to an axis-aligned rect; may emit several pieces. */
export function clipPolyline(
  pts: [number, number][],
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
): [number, number][][] {
  const pieces: [number, number][][] = [];
  let cur: [number, number][] = [];

  const flush = () => {
    if (cur.length >= 2) pieces.push(cur);
    cur = [];
  };

  for (let i = 0; i < pts.length - 1; i++) {
    const clipped = clipSegment(pts[i], pts[i + 1], minX, minZ, maxX, maxZ);
    if (!clipped) {
      flush();
      continue;
    }
    const [p0, p1, exitClipped] = clipped;
    if (cur.length === 0) {
      cur.push(p0);
    } else {
      const last = cur[cur.length - 1];
      if (Math.abs(last[0] - p0[0]) > 1e-6 || Math.abs(last[1] - p0[1]) > 1e-6) {
        flush();
        cur.push(p0);
      }
    }
    cur.push(p1);
    if (exitClipped) flush();
  }
  flush();
  return pieces;
}

/** Liang–Barsky; returns [entry, exit, exitWasClipped] or null. */
function clipSegment(
  a: [number, number],
  b: [number, number],
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
): [[number, number], [number, number], boolean] | null {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [
    [-dx, a[0] - minX],
    [dx, maxX - a[0]],
    [-dz, a[1] - minZ],
    [dz, maxZ - a[1]],
  ] as [number, number][]) {
    if (p === 0) {
      if (q < 0) return null; // parallel and outside
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }
  return [
    [a[0] + dx * t0, a[1] + dz * t0],
    [a[0] + dx * t1, a[1] + dz * t1],
    t1 < 1,
  ];
}
