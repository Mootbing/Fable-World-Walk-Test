//! Outbound event queue: flat [type, a, b, c] u32 records, cleared at the
//! start of every step() and drained by JS afterwards (audio/FX/HUD kicks).
//! f32 payloads travel via to_bits and are decoded with from_bits in TS.

pub const EV_JUMP: u32 = 1;
/// a = impact speed (f32 bits).
pub const EV_LAND: u32 = 2;
/// a = vehicle id.
pub const EV_VEHICLE_ENTER: u32 = 3;
/// a = vehicle id.
pub const EV_VEHICLE_EXIT: u32 = 4;
/// a = impact speed (f32 bits), b = vehicle id.
pub const EV_CRASH: u32 = 5;
/// a = vehicle id.
pub const EV_HORN: u32 = 6;
/// a = impact speed (f32 bits).
pub const EV_PED_HIT: u32 = 7;
/// a = new vehicle id.
pub const EV_CARJACK: u32 = 8;
pub const EV_PLAYER_DIED: u32 = 9;
pub const EV_RESPAWN: u32 = 10;
/// a = pickup kind, b = value (f32 bits).
pub const EV_PICKUP: u32 = 11;
/// a = 1 hit / 0 whiff.
pub const EV_PUNCH: u32 = 12;
/// a = ped id.
pub const EV_PED_KILLED: u32 = 13;
/// a = hit kind (0 air, 1 building, 2 ped, 3 vehicle), b/c = hit x/z (f32).
pub const EV_GUNSHOT: u32 = 14;
pub const EV_RELOAD: u32 = 15;
pub const EV_DRYFIRE: u32 = 16;
/// a/b/c = x/y/z of the blast (f32 bits).
pub const EV_EXPLOSION: u32 = 17;
/// a = new level.
pub const EV_WANTED_CHANGED: u32 = 18;
pub const EV_BUSTED: u32 = 19;

pub const EVENT_WORDS: usize = 4;
const MAX_EVENTS: usize = 256;

pub struct Events {
    buf: Vec<u32>,
}

impl Events {
    pub fn new() -> Self {
        Events {
            buf: Vec::with_capacity(MAX_EVENTS * EVENT_WORDS),
        }
    }

    pub fn clear(&mut self) {
        self.buf.clear();
    }

    pub fn push(&mut self, kind: u32, a: u32, b: u32, c: u32) {
        if self.buf.len() >= MAX_EVENTS * EVENT_WORDS {
            return; // drop excess rather than grow unboundedly mid-frame
        }
        self.buf.extend_from_slice(&[kind, a, b, c]);
    }

    pub fn as_ptr(&self) -> *const u32 {
        self.buf.as_ptr()
    }

    pub fn count(&self) -> u32 {
        (self.buf.len() / EVENT_WORDS) as u32
    }
}
