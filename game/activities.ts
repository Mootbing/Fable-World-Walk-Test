import type { WorldEngine } from "@/engine/engine";
import { useHud } from "@/engine/store";

/**
 * Vehicle side activities, toggled with T while driving the right ride:
 * taxi fares in a cab, vigilante bounties in a cruiser. Shares the
 * mission HUD line; cancelled by leaving the vehicle or pressing T again.
 */

type TaxiStage = "pickup" | "dropoff";

interface TaxiState {
  type: "taxi";
  stage: TaxiStage;
  target: { x: number; z: number };
  fareId: number;
  fares: number;
  tripStart: { x: number; z: number };
}

interface VigilanteState {
  type: "vigilante";
  targetId: number;
  bounties: number;
}

export type ActivityState = TaxiState | VigilanteState | null;

const FARE_BASE = 20;
const FARE_PER_M = 1.2;
const BOUNTY = 300;

export class Activities {
  active: ActivityState = null;

  /** T pressed: start the matching activity or cancel the current one. */
  toggle(engine: WorldEngine): void {
    if (this.active) {
      this.cancel(engine, "Activity cancelled");
      return;
    }
    if (!engine.sim || !engine.sim.driving() || engine.missions.activeMissionId) return;
    const kind = engine.sim.drivingKind();
    if (kind === 3) this.startTaxi(engine);
    else if (kind === 4) this.startVigilante(engine);
  }

  update(engine: WorldEngine): void {
    const act = this.active;
    if (!act || !engine.sim) return;
    if (!engine.sim.driving()) {
      this.cancel(engine, act.type === "taxi" ? "Fare abandoned" : "Patrol over");
      return;
    }

    if (act.type === "taxi") {
      const d = Math.hypot(engine.playerX - act.target.x, engine.playerZ - act.target.z);
      const stopped = Math.abs(engine.sim.drivingSpeed()) < 1.5;
      if (d <= 7 && stopped) {
        if (act.stage === "pickup") {
          engine.sim.removePed(act.fareId);
          const dest = this.routedPoint(engine, 120, 220);
          if (!dest) {
            this.cancel(engine, "Fare gave up");
            return;
          }
          act.stage = "dropoff";
          act.tripStart = { x: engine.playerX, z: engine.playerZ };
          act.target = dest;
          this.aim(engine, dest, "Take the fare to the destination");
        } else {
          const trip = Math.hypot(
            engine.playerX - act.tripStart.x,
            engine.playerZ - act.tripStart.z,
          );
          const reward = Math.round(FARE_BASE + FARE_PER_M * trip);
          engine.sim.giveMoney(reward);
          act.fares++;
          engine.totalFares++;
          useHud.setState({ missionFlash: `Fare delivered · $${reward}` });
          const next = this.spawnFare(engine);
          if (!next) {
            this.cancel(engine, "No more fares around");
            return;
          }
        }
      }
    } else {
      // Vigilante: keep the blip on the runner; bounty on destruction.
      if (!engine.sim) return;
      const pos = this.vehiclePos(engine, act.targetId);
      if (pos) engine.upsertBlip("bounty", pos.x, pos.z, "#e23c3c");
      if (engine.isVehicleDestroyed(act.targetId)) {
        engine.sim.giveMoney(BOUNTY);
        act.bounties++;
        engine.totalBounties++;
        useHud.setState({ missionFlash: `Target down · $${BOUNTY}` });
        const next = engine.sim.spawnMarkedCar();
        if (!next) {
          this.cancel(engine, "All quiet");
          return;
        }
        act.targetId = next;
        this.banner(engine, `Vigilante · take out the marked car (${act.bounties} down)`);
      }
    }
  }

  private startTaxi(engine: WorldEngine): void {
    const fare = this.spawnFareState(engine);
    if (!fare) {
      useHud.setState({ missionFlash: "No fares nearby" });
      return;
    }
    this.active = fare;
  }

  private spawnFareState(engine: WorldEngine): TaxiState | null {
    const state: TaxiState = {
      type: "taxi",
      stage: "pickup",
      target: { x: 0, z: 0 },
      fareId: 0,
      fares: 0,
      tripStart: { x: 0, z: 0 },
    };
    this.active = state;
    if (!this.spawnFare(engine)) return null;
    return state;
  }

  /** New pickup: routed curbside point ahead-ish; ped waits there. */
  private spawnFare(engine: WorldEngine): boolean {
    const pickup = this.routedPoint(engine, 70, 130);
    if (!pickup || !engine.sim || this.active?.type !== "taxi") return false;
    const act = this.active;
    act.stage = "pickup";
    act.target = pickup;
    act.fareId = engine.sim.debugSpawnPed(pickup.x, pickup.z);
    this.aim(engine, pickup, "Pick up the fare");
    return true;
  }

  /**
   * A point on the road network roughly ahead of the vehicle: random
   * bearing biased to the current heading, snapped by routing to it and
   * taking the route's end (guaranteed curbside).
   */
  private routedPoint(
    engine: WorldEngine,
    min: number,
    max: number,
  ): { x: number; z: number } | null {
    if (!engine.sim) return null;
    const heading = engine.camYaw;
    for (let attempt = 0; attempt < 6; attempt++) {
      const bearing = heading + (Math.random() - 0.5) * 1.2;
      const dist = min + Math.random() * (max - min);
      const tx = engine.playerX - Math.sin(bearing) * dist;
      const tz = engine.playerZ - Math.cos(bearing) * dist;
      const route = engine.sim.routeTo(tx, tz);
      if (route.length >= 4) {
        return { x: route[route.length - 2], z: route[route.length - 1] };
      }
    }
    return null;
  }

  private startVigilante(engine: WorldEngine): void {
    const id = engine.sim!.spawnMarkedCar();
    if (!id) {
      useHud.setState({ missionFlash: "No targets on the scanner" });
      return;
    }
    this.active = { type: "vigilante", targetId: id, bounties: 0 };
    this.banner(engine, "Vigilante · take out the marked car");
  }

  private aim(engine: WorldEngine, p: { x: number; z: number }, text: string): void {
    engine.setWaypoint(p.x, p.z);
    engine.setMissionMarker(p.x, p.z);
    this.banner(engine, text);
  }

  private banner(engine: WorldEngine, objective: string): void {
    void engine;
    const title = this.active?.type === "taxi" ? "Taxi Driver" : "Vigilante";
    useHud.setState({ mission: { title, objective } });
  }

  private vehiclePos(engine: WorldEngine, id: number): { x: number; z: number } | null {
    if (!engine.sim) return null;
    const f32 = engine.sim.entityView();
    const u32 = engine.sim.entityViewU32();
    for (let base = 0; base < u32.length; base += 16) {
      if (u32[base + 13] >>> 16 === 2 && u32[base + 12] === id) {
        return { x: f32[base], z: f32[base + 2] };
      }
    }
    return null;
  }

  private cancel(engine: WorldEngine, note: string): void {
    this.active = null;
    engine.clearWaypoint();
    engine.setMissionMarker(null, null);
    engine.removeBlip("bounty");
    useHud.setState({ mission: null, missionFlash: note });
  }
}
