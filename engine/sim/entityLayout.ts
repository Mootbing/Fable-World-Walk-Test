/**
 * Buffer ABI shared with the Rust sim (sim/src/lib.rs). One entity record is
 * ENTITY_STRIDE f32 lanes; integer lanes are u32s written via to_bits and
 * must be read through a Uint32Array view over the same bytes.
 */
export const ENTITY_STRIDE = 16;
export const MAX_ENTITIES = 1024;

export const LANE = {
  posX: 0,
  posY: 1,
  posZ: 2,
  quatX: 3,
  quatY: 4,
  quatZ: 5,
  quatW: 6,
  speed: 7,
  animPhase: 8,
  aux0: 9,
  aux1: 10,
  health: 11,
  /** u32 */ id: 12,
  /** u32: type << 16 | variant */ typeVariant: 13,
  /** u32 bitmask */ stateFlags: 14,
  reserved: 15,
} as const;

export const ENTITY_TYPE = {
  player: 0,
  ped: 1,
  vehicle: 2,
  police: 3,
  policePed: 4,
} as const;
