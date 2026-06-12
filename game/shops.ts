import type { WorldEngine } from "@/engine/engine";
import { useHud } from "@/engine/store";

/**
 * Map-driven shops on real OSM POIs: car_repair (kind 2) is the
 * pay'n'spray — roll in while driving and the heat (≤2★) and dents
 * disappear for $100; hardware stores (kind 3) sell "tools" on foot via
 * the Digit1-5 keys while the menu is up.
 */

export interface ShopItem {
  name: string;
  price: number;
  weapon?: number;
  ammo?: number;
  armor?: number;
}

export const SHOP_CATALOG: ShopItem[] = [
  { name: "Baseball Bat", price: 100, weapon: 1, ammo: 0 },
  { name: "Pistol", price: 400, weapon: 2, ammo: 34 },
  { name: "SMG", price: 1200, weapon: 3, ammo: 90 },
  { name: "Shotgun", price: 800, weapon: 4, ammo: 24 },
  { name: "Body Armor", price: 200, armor: 100 },
];

const SPRAY_RADIUS = 12;
const SPRAY_REARM = 25;
const SHOP_RADIUS = 7;

const SPRAY_LINES: Record<number, string> = {
  0: "Resprayed · -$100",
  2: "Too hot — shake a star first",
  3: "Respray costs $100",
};

export class Shops {
  shopOpen = false;
  /** One spray per visit; leaving the lot re-arms it. */
  private sprayArmed = true;

  update(engine: WorldEngine): void {
    const sim = engine.sim;
    if (!sim) return;

    const spray = engine.nearestPoi(2, engine.playerX, engine.playerZ);
    if (spray) {
      if (spray.d > SPRAY_REARM) {
        this.sprayArmed = true;
      } else if (
        this.sprayArmed &&
        spray.d <= SPRAY_RADIUS &&
        sim.driving() &&
        Math.abs(sim.drivingSpeed()) < 2
      ) {
        this.sprayArmed = false;
        const line = SPRAY_LINES[sim.sprayVehicle()];
        if (line) useHud.setState({ missionFlash: line });
      }
    }

    const shop = engine.nearestPoi(3, engine.playerX, engine.playerZ);
    const open = !!shop && shop.d <= SHOP_RADIUS && !sim.driving();
    if (open !== this.shopOpen) {
      this.shopOpen = open;
      useHud.setState({ shopOpen: open });
    }
  }

  /** Digit1-5 while the menu is open routes here instead of equipping. */
  buy(engine: WorldEngine, slot: number): void {
    const item = SHOP_CATALOG[slot];
    const sim = engine.sim;
    if (!item || !sim) return;
    if (!sim.tryCharge(item.price)) {
      useHud.setState({ missionFlash: "Not enough cash" });
      return;
    }
    if (item.weapon !== undefined) {
      sim.giveWeapon(item.weapon, item.ammo ?? 0);
      sim.equipWeapon(item.weapon);
    }
    if (item.armor !== undefined) sim.giveArmor(item.armor);
    useHud.setState({ missionFlash: `${item.name} · -$${item.price}` });
  }
}
