//! Player survival stats: health/armor/money, death and respawn.

use crate::events::{Events, EV_PLAYER_DIED, EV_RESPAWN};

pub const MAX_HEALTH: f64 = 100.0;
pub const MAX_ARMOR: f64 = 100.0;
pub const START_MONEY: i64 = 250;
/// Hospital bill, classic.
pub const DEATH_FEE: i64 = 100;
const RESPAWN_DELAY: f64 = 3.5;
/// Landing impacts above this speed (m/s) start hurting.
pub const SAFE_FALL_SPEED: f64 = 9.0;
pub const FALL_DAMAGE_PER_MS: f64 = 7.0;

pub struct PlayerStats {
    pub health: f64,
    pub armor: f64,
    pub money: i64,
    pub dead: bool,
    respawn_timer: f64,
}

impl PlayerStats {
    pub fn new() -> Self {
        PlayerStats {
            health: MAX_HEALTH,
            armor: 0.0,
            money: START_MONEY,
            dead: false,
            respawn_timer: 0.0,
        }
    }

    /// Apply damage (armor absorbs half until it breaks). Returns true if
    /// this kill just happened.
    pub fn damage(&mut self, amount: f64, events: &mut Events) -> bool {
        if self.dead || amount <= 0.0 {
            return false;
        }
        let absorbed = (amount * 0.5).min(self.armor);
        self.armor -= absorbed;
        self.health -= amount - absorbed;
        if self.health <= 0.0 {
            self.health = 0.0;
            self.dead = true;
            self.respawn_timer = RESPAWN_DELAY;
            events.push(EV_PLAYER_DIED, 0, 0, 0);
            return true;
        }
        false
    }

    pub fn heal(&mut self, amount: f64) {
        self.health = (self.health + amount).min(MAX_HEALTH);
    }

    pub fn add_armor(&mut self, amount: f64) {
        self.armor = (self.armor + amount).min(MAX_ARMOR);
    }

    pub fn add_money(&mut self, amount: i64) {
        self.money = (self.money + amount).max(0);
    }

    /// Ticks the respawn delay while dead; true when it's time to respawn.
    pub fn tick_respawn(&mut self, dt: f64, events: &mut Events) -> bool {
        if !self.dead {
            return false;
        }
        self.respawn_timer -= dt;
        if self.respawn_timer <= 0.0 {
            self.dead = false;
            self.health = MAX_HEALTH;
            self.armor = 0.0;
            self.money = (self.money - DEATH_FEE).max(0);
            events.push(EV_RESPAWN, 0, 0, 0);
            return true;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn armor_absorbs_half_until_broken() {
        let mut s = PlayerStats::new();
        let mut ev = Events::new();
        s.add_armor(20.0);
        s.damage(30.0, &mut ev); // 15 absorbed (capped at 20), 15 to health
        assert!((s.armor - 5.0).abs() < 1e-9);
        assert!((s.health - 85.0).abs() < 1e-9);
        s.damage(30.0, &mut ev); // only 5 armor left to absorb
        assert!((s.armor - 0.0).abs() < 1e-9);
        assert!((s.health - 60.0).abs() < 1e-9);
    }

    #[test]
    fn death_and_respawn_cycle() {
        let mut s = PlayerStats::new();
        let mut ev = Events::new();
        assert!(s.damage(150.0, &mut ev));
        assert!(s.dead);
        assert_eq!(s.health, 0.0);
        let mut respawned = false;
        for _ in 0..300 {
            if s.tick_respawn(1.0 / 60.0, &mut ev) {
                respawned = true;
                break;
            }
        }
        assert!(respawned);
        assert!(!s.dead);
        assert_eq!(s.health, MAX_HEALTH);
        assert_eq!(s.money, START_MONEY - DEATH_FEE);
    }
}
