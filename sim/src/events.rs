//! Outbound event queue: flat [type, a, b, c] u32 records, cleared at the
//! start of every step() and drained by JS afterwards (audio/FX/HUD kicks).
//! f32 payloads travel via to_bits and are decoded with from_bits in TS.

pub const EV_JUMP: u32 = 1;
/// a = impact speed (f32 bits).
pub const EV_LAND: u32 = 2;

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
