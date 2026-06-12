import type { WorldEngine } from "./engine";

/**
 * Versioned save slots in localStorage. The sim contributes its flat
 * snapshot (position/stats/arsenal); the engine adds clock + waypoint.
 */

export interface SaveMeta {
  slot: number;
  savedAt: string;
  money: number;
}

interface SaveData {
  version: 1;
  savedAt: string;
  sim: number[];
  clockMinutes: number;
  waypoint: { x: number; z: number } | null;
}

const key = (slot: number) => `worldwalk-save-${slot}`;

export function saveGame(engine: WorldEngine, slot: number): boolean {
  if (!engine.sim) return false;
  const data: SaveData = {
    version: 1,
    savedAt: new Date().toISOString(),
    sim: Array.from(engine.sim.snapshot()),
    clockMinutes: engine.clockMinutes,
    waypoint: engine.waypoint ? { ...engine.waypoint } : null,
  };
  try {
    localStorage.setItem(key(slot), JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

export function loadGame(engine: WorldEngine, slot: number): boolean {
  if (!engine.sim) return false;
  const raw = localStorage.getItem(key(slot));
  if (!raw) return false;
  try {
    const data = JSON.parse(raw) as SaveData;
    if (data.version !== 1) return false;
    if (!engine.sim.restore(new Float64Array(data.sim))) return false;
    engine.clockMinutes = data.clockMinutes;
    engine.clearWaypoint();
    if (data.waypoint) engine.setWaypoint(data.waypoint.x, data.waypoint.z);
    return true;
  } catch {
    return false;
  }
}

export function listSaves(): SaveMeta[] {
  const out: SaveMeta[] = [];
  for (let slot = 1; slot <= 3; slot++) {
    const raw = localStorage.getItem(key(slot));
    if (!raw) continue;
    try {
      const data = JSON.parse(raw) as SaveData;
      out.push({ slot, savedAt: data.savedAt, money: data.sim[5] ?? 0 });
    } catch {
      // corrupted slot: skip
    }
  }
  return out;
}
