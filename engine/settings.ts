/** Player settings, localStorage-backed, read by the input layer. */

export interface Settings {
  sensitivity: number;
  invertY: boolean;
  /** 0 = radio off, 1..N = station index. */
  radioStation: number;
}

const KEY = "worldwalk-settings";
let cached: Settings | null = null;

export function getSettings(): Settings {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      cached = { sensitivity: 1, invertY: false, radioStation: 0, ...JSON.parse(raw) } as Settings;
      return cached;
    }
  } catch {
    // fall through to defaults
  }
  cached = { sensitivity: 1, invertY: false, radioStation: 0 };
  return cached;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch };
  cached = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // storage full/blocked: keep in-memory
  }
  return next;
}
