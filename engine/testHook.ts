import { useHud } from "./store";
import type { WorldEngine } from "./engine";

/**
 * window.__ww — the automation surface the Playwright smoke harness drives.
 * Deliberately tiny and string-keyed so tests never import app code: they
 * page.evaluate against whatever build is running.
 */
export interface TestApi {
  ready(): boolean;
  query(path: string): unknown;
  cmd(name: string, ...args: unknown[]): unknown;
  /** Synthetic keydown now, keyup after ms (listeners live on window). */
  press(code: string, ms?: number): Promise<void>;
}

declare global {
  interface Window {
    __ww?: TestApi;
  }
}

export function installTestHook(engine: WorldEngine): () => void {
  const api: TestApi = {
    ready: () => useHud.getState().ready,
    query: (path) => {
      switch (path) {
        case "ready":
          return useHud.getState().ready;
        case "player":
          return { x: engine.playerX, y: engine.playerY, z: engine.playerZ };
        case "simTick":
          return engine.sim ? engine.sim.tick : 0;
        case "eventLog":
          // flat 4-word records [type, a, b, c], newest last
          return [...engine.eventLog];
        case "hud":
          return useHud.getState();
        case "render": {
          // Structural "did anything actually mesh" probe for smoke tests.
          let meshes = 0;
          let triangles = 0;
          engine.group.traverse((obj) => {
            const mesh = obj as { isMesh?: boolean; geometry?: unknown };
            if (!mesh.isMesh) return;
            meshes++;
            const geo = mesh.geometry as {
              index: { count: number } | null;
              attributes: { position?: { count: number } };
            };
            const verts = geo.index?.count ?? geo.attributes.position?.count ?? 0;
            triangles += verts / 3;
          });
          return { meshes, triangles: Math.round(triangles) };
        }
        default:
          return undefined;
      }
    },
    cmd: (name) => {
      switch (name) {
        // Store-level lock: enables movement input without real pointer
        // lock (headless browsers can't gesture). Camera stays put, which
        // is exactly what a deterministic test wants.
        case "lock":
          useHud.setState({ locked: true });
          return true;
        case "unlock":
          useHud.setState({ locked: false });
          return true;
        default:
          return undefined;
      }
    },
    press: (code, ms = 100) => {
      window.dispatchEvent(new KeyboardEvent("keydown", { code }));
      return new Promise((resolve) =>
        setTimeout(() => {
          window.dispatchEvent(new KeyboardEvent("keyup", { code }));
          resolve();
        }, ms),
      );
    },
  };
  window.__ww = api;
  return () => {
    if (window.__ww === api) delete window.__ww;
  };
}
