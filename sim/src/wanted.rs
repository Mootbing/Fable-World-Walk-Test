//! Wanted level state machine: crime heat → stars, line-of-sight evasion,
//! busted detection. v1 covers stars 1–3 (4★ roadblocks land in PR22,
//! 5–6★ helicopters in PR36).

use crate::events::{Events, EV_BUSTED, EV_WANTED_CHANGED};

/// Heat thresholds for stars 1..=3.
const THRESHOLDS: [f64; 3] = [10.0, 40.0, 90.0];
/// Unseen this long → all stars clear (classic flash-then-clear).
const EVADE_T: f64 = 15.0;
/// Cop adjacent + player still this long → arrest.
const BUSTED_T: f64 = 1.5;
pub const BUSTED_FINE: i64 = 150;

pub struct Wanted {
    pub heat: f64,
    pub level: u32,
    /// True while no cop has eyes on the player.
    pub evading: bool,
    evade_timer: f64,
    busted_timer: f64,
    pub busted: bool,
    /// Freeze frames after the arrest before respawn.
    pub busted_hold: f64,
}

impl Wanted {
    pub fn new() -> Self {
        Wanted {
            heat: 0.0,
            level: 0,
            evading: false,
            evade_timer: 0.0,
            busted_timer: 0.0,
            busted: false,
            busted_hold: 0.0,
        }
    }

    pub fn add_heat(&mut self, amount: f64, events: &mut Events) {
        if self.busted {
            return;
        }
        self.heat += amount;
        let new_level = THRESHOLDS.iter().filter(|t| self.heat >= **t).count() as u32;
        if new_level != self.level {
            self.level = new_level;
            events.push(EV_WANTED_CHANGED, new_level, 0, 0);
        }
        // Fresh crimes reset the evasion clock.
        self.evade_timer = 0.0;
    }

    /// Per-substep: track evasion (seen = any cop LOS/proximity) and the
    /// arrest window (adjacent = cop in grab range while player is still).
    /// Returns true the instant the player gets busted.
    pub fn tick(&mut self, seen: bool, adjacent: bool, dt: f64, events: &mut Events) -> bool {
        if self.level == 0 || self.busted {
            return false;
        }
        if seen {
            self.evading = false;
            self.evade_timer = 0.0;
        } else {
            self.evading = true;
            self.evade_timer += dt;
            if self.evade_timer >= EVADE_T {
                self.clear(events);
                return false;
            }
        }
        if adjacent {
            self.busted_timer += dt;
            if self.busted_timer >= BUSTED_T {
                self.busted = true;
                self.busted_hold = 3.0;
                events.push(EV_BUSTED, 0, 0, 0);
                return true;
            }
        } else {
            self.busted_timer = 0.0;
        }
        false
    }

    pub fn clear(&mut self, events: &mut Events) {
        if self.level != 0 {
            events.push(EV_WANTED_CHANGED, 0, 0, 0);
        }
        self.heat = 0.0;
        self.level = 0;
        self.evading = false;
        self.evade_timer = 0.0;
        self.busted_timer = 0.0;
    }

    /// Cop headcount targets per star: (unarmed, armed, pursuit cars).
    pub fn force_for_level(&self) -> (u32, u32, u32) {
        match self.level {
            0 => (0, 0, 0),
            1 => (2, 0, 0),
            2 => (0, 4, 0),
            _ => (0, 5, 2),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heat_maps_to_stars_and_evasion_clears() {
        let mut w = Wanted::new();
        let mut ev = Events::new();
        w.add_heat(12.0, &mut ev);
        assert_eq!(w.level, 1);
        w.add_heat(35.0, &mut ev);
        assert_eq!(w.level, 2);
        w.add_heat(50.0, &mut ev);
        assert_eq!(w.level, 3);
        // Unseen long enough: everything clears.
        for _ in 0..(16 * 60) {
            w.tick(false, false, 1.0 / 60.0, &mut ev);
        }
        assert_eq!(w.level, 0);
        assert_eq!(w.heat, 0.0);
    }

    #[test]
    fn arrest_requires_sustained_adjacency() {
        let mut w = Wanted::new();
        let mut ev = Events::new();
        w.add_heat(12.0, &mut ev);
        // Brushing past a cop isn't an arrest.
        for _ in 0..30 {
            assert!(!w.tick(true, true, 1.0 / 60.0, &mut ev));
        }
        for _ in 0..30 {
            w.tick(true, false, 1.0 / 60.0, &mut ev);
        }
        assert!(!w.busted);
        // Standing in the grab for 1.5s is.
        let mut busted = false;
        for _ in 0..120 {
            if w.tick(true, true, 1.0 / 60.0, &mut ev) {
                busted = true;
                break;
            }
        }
        assert!(busted);
    }
}
