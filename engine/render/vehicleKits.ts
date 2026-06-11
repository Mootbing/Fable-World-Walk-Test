/**
 * Per-kind render dimensions + liveries. Handling lives in Rust
 * (sim/src/vehicle.rs SPECS); only the wheelbase/track here must stay
 * visually consistent with it.
 */
export interface VehicleKit {
  name: string;
  width: number;
  length: number;
  bodyH: number;
  cabinW: number;
  cabinH: number;
  cabinLen: number;
  /** Cabin center offset along +Z (rear is +Z; forward is -Z). */
  cabinZ: number;
  wheelbase: number;
  track: number;
  /** Fixed paint (liveried kinds); null = per-instance palette color. */
  paint: number | null;
  /** Roof sign/lightbar color, or null. */
  topper: number | null;
}

export const WHEEL_RADIUS = 0.33;

export const PAINT_PALETTE = [
  0xb33a2f, 0x2f56b3, 0x3b3f46, 0xd8d5cf, 0x276b43, 0x7b3fa0, 0xc7872b, 0x1d2a3a,
];

export const KITS: VehicleKit[] = [
  { name: "Sedan", width: 1.85, length: 4.4, bodyH: 0.55, cabinW: 1.65, cabinH: 0.5, cabinLen: 2.1, cabinZ: 0.25, wheelbase: 2.7, track: 1.56, paint: null, topper: null },
  { name: "Hatchback", width: 1.75, length: 3.9, bodyH: 0.55, cabinW: 1.6, cabinH: 0.52, cabinLen: 2.0, cabinZ: 0.55, wheelbase: 2.45, track: 1.5, paint: null, topper: null },
  { name: "Van", width: 1.95, length: 5.2, bodyH: 0.85, cabinW: 1.85, cabinH: 0.75, cabinLen: 3.6, cabinZ: 0.5, wheelbase: 3.2, track: 1.66, paint: null, topper: null },
  { name: "Taxi", width: 1.85, length: 4.4, bodyH: 0.55, cabinW: 1.65, cabinH: 0.5, cabinLen: 2.1, cabinZ: 0.25, wheelbase: 2.7, track: 1.56, paint: 0xf7c531, topper: 0xf7c531 },
  { name: "Police Cruiser", width: 1.85, length: 4.5, bodyH: 0.55, cabinW: 1.65, cabinH: 0.5, cabinLen: 2.1, cabinZ: 0.25, wheelbase: 2.75, track: 1.56, paint: 0xf2f2f2, topper: 0xd2222a },
  { name: "Sport", width: 1.85, length: 4.2, bodyH: 0.45, cabinW: 1.6, cabinH: 0.42, cabinLen: 1.7, cabinZ: 0.35, wheelbase: 2.5, track: 1.58, paint: null, topper: null },
];
