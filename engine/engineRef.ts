import type { WorldEngine } from "./engine";

/**
 * Module-level handle to the live engine for DOM-side components that live
 * outside the R3F tree (Minimap, future PauseMap). Set by World on mount.
 */
export const engineRef: { current: WorldEngine | null } = { current: null };
