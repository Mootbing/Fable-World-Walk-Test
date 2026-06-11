//! Deterministic seeded RNG: SplitMix64 for stream derivation, PCG32 for
//! generation. No external deps so output is stable across crate versions.

/// SplitMix64 step — used to hash seeds and derive per-system streams.
pub fn splitmix64(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// Derive a child seed from (world seed, system tag, tile coords). Same
/// inputs always yield the same stream, so tile unload/reload reproduces.
pub fn derive_seed(world_seed: u64, tag: &str, a: i32, b: i32) -> u64 {
    let mut s = world_seed;
    for byte in tag.bytes() {
        s = splitmix64(&mut s) ^ (byte as u64);
    }
    s ^= (a as u32 as u64) << 32 | (b as u32 as u64);
    splitmix64(&mut s)
}

pub struct Pcg32 {
    state: u64,
    inc: u64,
}

impl Pcg32 {
    pub fn new(seed: u64) -> Self {
        let mut sm = seed;
        let state = splitmix64(&mut sm);
        let inc = splitmix64(&mut sm) | 1;
        Pcg32 { state, inc }
    }

    pub fn next_u32(&mut self) -> u32 {
        let old = self.state;
        self.state = old
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(self.inc);
        let xorshifted = (((old >> 18) ^ old) >> 27) as u32;
        let rot = (old >> 59) as u32;
        xorshifted.rotate_right(rot)
    }

    /// Uniform in [0, 1).
    pub fn next_f32(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 * (1.0 / (1 << 24) as f32)
    }

    /// Uniform in [0, n).
    pub fn next_below(&mut self, n: u32) -> u32 {
        ((self.next_u32() as u64 * n as u64) >> 32) as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_across_runs() {
        let mut a = Pcg32::new(1337);
        let mut b = Pcg32::new(1337);
        for _ in 0..100 {
            assert_eq!(a.next_u32(), b.next_u32());
        }
    }

    #[test]
    fn streams_differ_by_tile() {
        let s1 = derive_seed(1337, "traffic", 9648, 12320);
        let s2 = derive_seed(1337, "traffic", 9649, 12320);
        let s3 = derive_seed(1337, "peds", 9648, 12320);
        assert_ne!(s1, s2);
        assert_ne!(s1, s3);
        // and reproduces
        assert_eq!(s1, derive_seed(1337, "traffic", 9648, 12320));
    }

    #[test]
    fn next_f32_in_range_and_centered() {
        let mut rng = Pcg32::new(42);
        let mut sum = 0.0f64;
        for _ in 0..10_000 {
            let v = rng.next_f32();
            assert!((0.0..1.0).contains(&v));
            sum += v as f64;
        }
        let mean = sum / 10_000.0;
        assert!((0.45..0.55).contains(&mean), "mean {mean}");
    }
}
