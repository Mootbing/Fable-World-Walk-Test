//! Floating pickups: health, armor, money. Spun/bobbed by the renderer;
//! collected by walking through them.

use crate::events::{Events, EV_PICKUP};
use crate::stats::PlayerStats;

pub const KIND_HEALTH: u32 = 0;
pub const KIND_ARMOR: u32 = 1;
pub const KIND_MONEY: u32 = 2;

const COLLECT_RADIUS: f64 = 1.3;

pub struct Pickup {
    pub id: u32,
    pub kind: u32,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub value: f64,
}

pub struct Pickups {
    pub items: Vec<Pickup>,
    next_id: u32,
}

impl Pickups {
    pub fn new() -> Self {
        Pickups { items: Vec::new(), next_id: 3_000_000 }
    }

    pub fn spawn(&mut self, x: f64, y: f64, z: f64, kind: u32, value: f64) -> u32 {
        let id = self.next_id;
        self.next_id += 1;
        self.items.push(Pickup { id, kind, x, y, z, value });
        id
    }

    pub fn count(&self) -> u32 {
        self.items.len() as u32
    }

    /// Collect anything in range of the (alive) player.
    pub fn collect(&mut self, px: f64, pz: f64, stats: &mut PlayerStats, events: &mut Events) {
        if stats.dead {
            return;
        }
        let mut i = 0;
        while i < self.items.len() {
            let p = &self.items[i];
            let d = ((p.x - px).powi(2) + (p.z - pz).powi(2)).sqrt();
            if d <= COLLECT_RADIUS {
                match p.kind {
                    KIND_HEALTH => stats.heal(p.value),
                    KIND_ARMOR => stats.add_armor(p.value),
                    _ => stats.add_money(p.value as i64),
                }
                events.push(EV_PICKUP, p.kind, (p.value as f32).to_bits(), 0);
                self.items.swap_remove(i);
            } else {
                i += 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collects_in_range_and_applies() {
        let mut pk = Pickups::new();
        let mut st = PlayerStats::new();
        let mut ev = Events::new();
        st.health = 50.0;
        pk.spawn(0.0, 0.0, 0.0, KIND_HEALTH, 25.0);
        pk.spawn(0.5, 0.0, 0.5, KIND_MONEY, 80.0);
        pk.spawn(50.0, 0.0, 0.0, KIND_ARMOR, 50.0); // out of range
        pk.collect(0.0, 0.0, &mut st, &mut ev);
        assert_eq!(pk.count(), 1);
        assert!((st.health - 75.0).abs() < 1e-9);
        assert_eq!(st.money, crate::stats::START_MONEY + 80);
        assert_eq!(ev.count(), 2);
    }
}
