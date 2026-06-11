import * as THREE from "three";
import { sampleBilinear } from "./heightField";

/** Grid segments per chunk edge (129x129 vertices, ~7.2 m spacing at z15/NYC). */
const SEGS = 128;
/** Skirt drop in meters; hides cracks between independently-sampled chunks. */
const SKIRT = 12;

/**
 * Build a chunk mesh: a displaced grid in chunk-local coordinates
 * (x east 0..size, z south 0..size, y = elevation) plus skirt strips on all
 * four edges. Chunk-local values stay < ~1 km so fp32 vertices are safe.
 */
export function buildTerrainGeometry(field: Float32Array, size: number): THREE.BufferGeometry {
  const n = SEGS + 1;
  const gridVerts = n * n;
  const skirtVerts = 4 * n;
  const positions = new Float32Array((gridVerts + skirtVerts) * 3);
  const uvs = new Float32Array((gridVerts + skirtVerts) * 2);

  let p = 0;
  let q = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u = i / SEGS;
      const v = j / SEGS;
      positions[p++] = u * size;
      positions[p++] = sampleBilinear(field, u, v);
      positions[p++] = v * size;
      uvs[q++] = u;
      uvs[q++] = 1 - v; // texture row 0 is the north edge
    }
  }

  const indices = new Uint32Array(SEGS * SEGS * 6 + 4 * SEGS * 6);
  let t = 0;
  for (let j = 0; j < SEGS; j++) {
    for (let i = 0; i < SEGS; i++) {
      const a = j * n + i;
      const b = (j + 1) * n + i;
      const c = (j + 1) * n + i + 1;
      const d = j * n + i + 1;
      indices[t++] = a;
      indices[t++] = b;
      indices[t++] = d;
      indices[t++] = b;
      indices[t++] = c;
      indices[t++] = d;
    }
  }

  // Skirts: duplicate each border vertex SKIRT meters down, quad per segment.
  // Material is double-sided, so winding doesn't matter here.
  const edges: number[][] = [[], [], [], []];
  for (let i = 0; i < n; i++) {
    edges[0].push(i); // north (j=0)
    edges[1].push(SEGS * n + i); // south
    edges[2].push(i * n); // west
    edges[3].push(i * n + SEGS); // east
  }
  let vert = gridVerts;
  for (const edge of edges) {
    const firstSkirt = vert;
    for (const src of edge) {
      positions[vert * 3] = positions[src * 3];
      positions[vert * 3 + 1] = positions[src * 3 + 1] - SKIRT;
      positions[vert * 3 + 2] = positions[src * 3 + 2];
      uvs[vert * 2] = uvs[src * 2];
      uvs[vert * 2 + 1] = uvs[src * 2 + 1];
      vert++;
    }
    for (let i = 0; i < SEGS; i++) {
      const topA = edge[i];
      const topB = edge[i + 1];
      const botA = firstSkirt + i;
      const botB = firstSkirt + i + 1;
      indices[t++] = topA;
      indices[t++] = botA;
      indices[t++] = topB;
      indices[t++] = topB;
      indices[t++] = botA;
      indices[t++] = botB;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Composite a factor x factor grid of imagery tiles into one texture for a
 * chunk. Bitmaps are in row-major order (north row first) and are closed
 * here. Missing tiles leave a neutral ground color.
 */
export function compositeImagery(
  bitmaps: (ImageBitmap | null)[],
  factor: number,
  tileSize: number,
): THREE.Texture {
  const px = factor * tileSize;
  const canvas = new OffscreenCanvas(px, px);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  ctx.fillStyle = "#4a4f48";
  ctx.fillRect(0, 0, px, px);
  for (let j = 0; j < factor; j++) {
    for (let i = 0; i < factor; i++) {
      const bm = bitmaps[j * factor + i];
      if (!bm) continue;
      ctx.drawImage(bm, i * tileSize, j * tileSize, tileSize, tileSize);
      bm.close();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}
