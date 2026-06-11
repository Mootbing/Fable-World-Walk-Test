/** Web Mercator (EPSG:3857) world width in meters at the equator. */
export const EARTH_CIRCUMFERENCE = 40075016.686;
const ORIGIN_SHIFT = EARTH_CIRCUMFERENCE / 2;
const R = EARTH_CIRCUMFERENCE / (2 * Math.PI);

export function lonToMercX(lon: number): number {
  return (lon / 360) * EARTH_CIRCUMFERENCE;
}

export function latToMercY(lat: number): number {
  const rad = (lat * Math.PI) / 180;
  return R * Math.log(Math.tan(Math.PI / 4 + rad / 2));
}

export function mercXToLon(x: number): number {
  return (x / EARTH_CIRCUMFERENCE) * 360;
}

export function mercYToLat(y: number): number {
  return ((2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180) / Math.PI;
}

/** Web-Mercator X of the west edge of tile column x at zoom z. */
export function tileToMercX(x: number, z: number): number {
  return (x / 2 ** z) * EARTH_CIRCUMFERENCE - ORIGIN_SHIFT;
}

/** Web-Mercator Y of the NORTH edge of tile row y at zoom z. */
export function tileToMercY(y: number, z: number): number {
  return ORIGIN_SHIFT - (y / 2 ** z) * EARTH_CIRCUMFERENCE;
}

export function tileMercSize(z: number): number {
  return EARTH_CIRCUMFERENCE / 2 ** z;
}

/**
 * Local game frame anchored at the spawn point: +X east, -Z north, +Y up,
 * 1 unit = 1 true ground meter. Mercator distances are multiplied by
 * k = cos(spawnLat) to undo the projection's inflation, so walking speeds,
 * building heights and terrain slopes are all metrically correct near spawn
 * (error < 0.02% per km of latitude moved).
 *
 * All math here is plain f64; geometry handed to the GPU is built tile-local
 * elsewhere so fp32 never sees a large coordinate.
 */
export class WorldAnchor {
  readonly k: number;
  readonly originMercX: number;
  readonly originMercY: number;

  constructor(lat: number, lon: number) {
    this.k = Math.cos((lat * Math.PI) / 180);
    this.originMercX = lonToMercX(lon);
    this.originMercY = latToMercY(lat);
  }

  mercToWorld(mx: number, my: number): { x: number; z: number } {
    return { x: (mx - this.originMercX) * this.k, z: (this.originMercY - my) * this.k };
  }

  worldToMerc(x: number, z: number): { mx: number; my: number } {
    return { mx: x / this.k + this.originMercX, my: this.originMercY - z / this.k };
  }

  lonLatToWorld(lon: number, lat: number): { x: number; z: number } {
    return this.mercToWorld(lonToMercX(lon), latToMercY(lat));
  }

  worldToLonLat(x: number, z: number): { lon: number; lat: number } {
    const { mx, my } = this.worldToMerc(x, z);
    return { lon: mercXToLon(mx), lat: mercYToLat(my) };
  }

  /** Side length in world meters of a zoom-z tile. */
  tileWorldSize(z: number): number {
    return tileMercSize(z) * this.k;
  }

  /** World-space position of tile (tx,ty)'s NW corner at zoom z. */
  tileNWWorld(tx: number, ty: number, z: number): { x: number; z: number } {
    return this.mercToWorld(tileToMercX(tx, z), tileToMercY(ty, z));
  }

  /** Tile coordinates containing a world position. */
  worldToTile(x: number, z: number, zoom: number): { tx: number; ty: number } {
    const { mx, my } = this.worldToMerc(x, z);
    const n = 2 ** zoom;
    return {
      tx: Math.floor(((mx + ORIGIN_SHIFT) / EARTH_CIRCUMFERENCE) * n),
      ty: Math.floor(((ORIGIN_SHIFT - my) / EARTH_CIRCUMFERENCE) * n),
    };
  }
}
