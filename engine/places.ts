import Protobuf from "pbf";
import { VectorTile } from "@mapbox/vector-tile";
import { WorldAnchor } from "./geo";

/**
 * Neighborhood/area names from the OpenFreeMap `place` layer (same z14 MVT
 * bytes as buildings/roads). Drives the classic GTA area-name toast.
 */

export interface Place {
  name: string;
  /** Smaller class = more local (matched first). */
  tier: number;
  x: number;
  z: number;
}

const TIERS: Record<string, number> = { neighbourhood: 0, quarter: 1, suburb: 2 };
/** Match radius per tier (m). */
export const TIER_RADIUS = [700, 1300, 2600];

export function extractPlaces(
  buf: ArrayBuffer,
  tx: number,
  ty: number,
  zoom: number,
  anchor: WorldAnchor,
): Place[] {
  let layer;
  try {
    const tile = new VectorTile(new Protobuf(new Uint8Array(buf)));
    layer = tile.layers["place"];
  } catch {
    return [];
  }
  if (!layer) return [];

  const nw = anchor.tileNWWorld(tx, ty, zoom);
  const size = anchor.tileWorldSize(zoom);
  const out: Place[] = [];
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    const props = feature.properties as Record<string, unknown>;
    const tier = TIERS[String(props.class)];
    if (tier === undefined) continue;
    const name = String(props["name:latin"] ?? props.name ?? "");
    if (!name) continue;
    const geom = feature.loadGeometry();
    const p = geom[0]?.[0];
    if (!p) continue;
    out.push({
      name,
      tier,
      x: nw.x + (p.x / layer.extent) * size,
      z: nw.z + (p.y / layer.extent) * size,
    });
  }
  return out;
}

/** Most local place containing the position, by tier-banded nearest. */
export function resolveArea(places: Iterable<Place[]>, x: number, z: number): string {
  let best: { name: string; tier: number; d: number } | null = null;
  for (const tilePlaces of places) {
    for (const p of tilePlaces) {
      const d = Math.hypot(p.x - x, p.z - z);
      if (d > TIER_RADIUS[p.tier]) continue;
      if (!best || p.tier < best.tier || (p.tier === best.tier && d < best.d)) {
        best = { name: p.name, tier: p.tier, d };
      }
    }
  }
  return best?.name ?? "";
}
