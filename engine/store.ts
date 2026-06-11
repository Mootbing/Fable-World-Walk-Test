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
}));
