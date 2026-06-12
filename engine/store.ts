import { create } from "zustand";

/** Window event dispatched by the DOM overlay to request pointer lock. */
export const LOCK_EVENT = "worldwalk:lock";

interface HudState {
  /** Spawn area loaded enough to walk. */
  ready: boolean;
  locked: boolean;
  lat: number;
  lon: number;
  elev: number;
  fps: number;
  tilesInFlight: number;
  chunks: number;
  buildingsNote: string;
  /** Wasm sim heartbeat: substep counter and last step() cost. */
  simTick: number;
  simMs: number;
  /** Non-null while driving. */
  vehicle: { speedKmh: number; name: string } | null;
  /** Interaction prompt ("Press E…"); empty when none. */
  toast: string;
  /** Full-screen map overlay open. */
  mapOpen: boolean;
  /** Weapon wheel held open (Tab). */
  wheelOpen: boolean;
  /** Owned-weapon bitmask + equipped id for the wheel. */
  weaponsOwned: number;
  weaponEquipped: number;
  /** Area-name toast (set on neighborhood change; component fades it). */
  areaToast: string;
  health: number;
  armor: number;
  money: number;
  dead: boolean;
  weapon: { name: string; clip: number; reserve: number; reloading: boolean } | null;
  wanted: number;
  busted: boolean;
  /** Game clock HH:MM. */
  clock: string;
}

/**
 * DOM HUD state. The engine writes via useHud.setState() at a few Hz from
 * outside React; nothing here is touched in the frame loop.
 */
export const useHud = create<HudState>(() => ({
  ready: false,
  locked: false,
  lat: 0,
  lon: 0,
  elev: 0,
  fps: 0,
  tilesInFlight: 0,
  chunks: 0,
  buildingsNote: "",
  simTick: 0,
  simMs: 0,
  vehicle: null,
  toast: "",
  mapOpen: false,
  wheelOpen: false,
  weaponsOwned: 1,
  weaponEquipped: 0,
  areaToast: "",
  clock: "12:00",
  health: 100,
  armor: 0,
  money: 0,
  dead: false,
  weapon: null,
  wanted: 0,
  busted: false,
}));
