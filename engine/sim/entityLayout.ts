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
  pickup: 5,
} as const;

export const STATE_FLAG = {
  grounded: 1,
  inVehicle: 2,
  /** IDM decelerating hard (brake lights, PR29 visuals). */
  braking: 4,
  fleeing: 8,
  down: 16,
  smoking: 32,
  burning: 64,
  husk: 128,
} as const;

/** Input button bitfield (mirrors sim/src/input.rs). */
export const BTN = {
  sprint: 1 << 4,
  /** On foot: jump. Driving: handbrake. */
  jump: 1 << 5,
  enter: 1 << 6,
  /** Horn while driving. */
  horn: 1 << 7,
  fire: 1 << 8,
  aim: 1 << 9,
  reload: 1 << 10,
  switchWeapon: 1 << 11,
} as const;

/** Sim event types (mirrors sim/src/events.rs). Records are 4 u32 words. */
export const EVENT = {
  jump: 1,
  land: 2,
  vehicleEnter: 3,
  vehicleExit: 4,
  crash: 5,
  horn: 6,
  pedHit: 7,
  carjack: 8,
  playerDied: 9,
  respawn: 10,
  pickup: 11,
  punch: 12,
  pedKilled: 13,
  gunshot: 14,
  reload: 15,
  dryfire: 16,
  explosion: 17,
} as const;
export const EVENT_WORDS = 4;
