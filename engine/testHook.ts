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
        case "camMode":
          return engine.camMode;
        case "camera":
          return { ...engine.camPos };
        case "avatarVisible":
          return engine.avatar.visible;
        case "driving":
          return engine.sim ? engine.sim.driving() : false;
        case "weapon":
          return engine.sim ? engine.sim.weaponState() : null;
        case "stats":
          return engine.sim ? engine.sim.playerStats() : null;
        case "gps":
          return {
            waypoint: engine.waypoint ? { ...engine.waypoint } : null,
            routePoints: engine.gpsRoute ? engine.gpsRoute.length / 2 : 0,
          };
        case "roads":
          return engine.sim ? engine.sim.roadStats() : null;
        case "traffic":
          return engine.sim ? engine.sim.trafficCount() : 0;
        case "peds":
          return engine.sim ? engine.sim.pedCount() : 0;
        case "anyBraking": {
          if (!engine.sim) return false;
          const u32 = engine.sim.entityViewU32();
          for (let base = 0; base < u32.length; base += 16) {
            if (u32[base + 13] >>> 16 === 2 && (u32[base + 14] & 4) !== 0) return true;
          }
          return false;
        }
        case "roadDebugInfo":
          return { visible: engine.roadDebug.visible, vertices: engine.roadDebug.vertexCount };
        case "vehicles": {
          if (!engine.sim) return [];
          const f32 = engine.sim.entityView();
          const u32 = engine.sim.entityViewU32();
          const out: { id: number; x: number; z: number }[] = [];
          for (let base = 0; base < f32.length; base += 16) {
            if (u32[base + 13] >>> 16 === 2) {
              out.push({ id: u32[base + 12], x: f32[base], z: f32[base + 2] });
            }
          }
          return out;
        }
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
    cmd: (name, ...args) => {
      switch (name) {
        // Resolve a circle against the wasm collision world; returns the
        // pushed-out position so tests can prove walls exist as data.
        case "probeCollision": {
          const [x, z] = args as [number, number];
          if (!engine.sim) return null;
          const out = engine.sim.resolveProbe(x, z, 0.35);
          return { ...out, moved: Math.hypot(out.x - x, out.z - z) > 1e-6 };
        }
        // Store-level lock: enables movement input without real pointer
        // lock (headless browsers can't gesture). Camera stays put, which
        // is exactly what a deterministic test wants.
        case "lock":
          useHud.setState({ locked: true });
          return true;
        case "warpPlayer": {
          const [x, z] = args as [number, number];
          engine.sim?.setPlayerPos(x, z);
          return true;
        }
        case "setWaypoint": {
          const [x, z] = args as [number, number];
          engine.setWaypoint(x, z);
          return engine.gpsRoute ? engine.gpsRoute.length / 2 : 0;
        }
        case "clearWaypoint":
          engine.clearWaypoint();
          return true;
        case "roadDebug":
          engine.roadDebug.toggle();
          return engine.roadDebug.visible;
        case "damage": {
          const [n] = args as [number];
          engine.sim?.damagePlayer(n);
          return true;
        }
        case "spawnPickup": {
          const [x, z, kind, value] = args as [number, number, number, number];
          return engine.sim ? engine.sim.spawnPickupAt(x, z, kind, value) : 0;
        }
        case "spawnPed": {
          const [x, z] = args as [number, number];
          return engine.sim ? engine.sim.debugSpawnPed(x, z) : 0;
        }
        case "spawnTraffic": {
          const [x, z, kind] = args as [number, number, number];
          return engine.sim ? engine.sim.debugSpawnTraffic(x, z, 0, kind ?? 0) : 0;
        }
        // Debug: spawn a grid of vehicles cycling through all kinds.
        case "spawnRow": {
          const [n] = args as [number];
          if (!engine.sim) return 0;
          for (let i = 0; i < n; i++) {
            engine.sim.spawnVehicle(
              engine.playerX + 6 + (i % 6) * 4.5,
              engine.playerZ - 10 - Math.floor(i / 6) * 8,
              0,
              i % 6,
            );
          }
          return n;
        }
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
