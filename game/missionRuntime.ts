import type { WorldEngine } from "@/engine/engine";
import { useHud } from "@/engine/store";

/**
 * Data-driven mission runtime: a mission is a list of objective steps the
 * engine ticks each frame. Sim verbs (spawning, money, wanted) go through
 * the bridge; presentation (markers, GPS, HUD text) through the engine.
 */

export type MissionStep =
  | { kind: "goTo"; x: number; z: number; radius: number; text: string }
  | { kind: "enterVehicle"; vehicleKey?: string; text: string }
  | { kind: "driveTo"; x: number; z: number; radius: number; text: string }
  | { kind: "loseWanted"; text: string };

export interface MissionDef {
  id: string;
  title: string;
  reward: number;
  /** Spawn props/targets; returned ids are referenced by vehicleKey. */
  setup(engine: WorldEngine): Record<string, number>;
  steps: MissionStep[];
}

const DONE_KEY = "worldwalk-missions";

function loadDone(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(DONE_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

export class MissionRuntime {
  private active: { def: MissionDef; step: number; ctx: Record<string, number> } | null = null;
  private done = loadDone();
  private flashTimer = 0;

  get activeMissionId(): string | null {
    return this.active?.def.id ?? null;
  }

  get currentStep(): number {
    return this.active?.step ?? -1;
  }

  isDone(id: string): boolean {
    return this.done.has(id);
  }

  start(def: MissionDef, engine: WorldEngine): boolean {
    if (this.active || this.done.has(def.id) || !engine.sim) return false;
    const ctx = def.setup(engine);
    this.active = { def, step: 0, ctx };
    this.applyStep(engine);
    return true;
  }

  /** Ticked from the engine each frame. */
  update(engine: WorldEngine, dt: number): void {
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) useHud.setState({ missionFlash: "" });
    }
    const act = this.active;
    if (!act || !engine.sim) return;

    // Death or arrest fails the mission.
    const stats = engine.sim.playerStats();
    if (stats.dead || engine.sim.isBusted()) {
      this.finish(engine, false);
      return;
    }

    const step = act.def.steps[act.step];
    let complete = false;
    switch (step.kind) {
      case "goTo": {
        complete =
          Math.hypot(engine.playerX - step.x, engine.playerZ - step.z) <= step.radius &&
          !engine.sim.driving();
        break;
      }
      case "enterVehicle": {
        const want = step.vehicleKey ? act.ctx[step.vehicleKey] : undefined;
        const drivingId = engine.sim.drivingVehicleId();
        complete = drivingId !== 0 && (want === undefined || drivingId === want);
        break;
      }
      case "driveTo": {
        complete =
          engine.sim.driving() &&
          Math.hypot(engine.playerX - step.x, engine.playerZ - step.z) <= step.radius;
        break;
      }
      case "loseWanted": {
        complete = engine.sim.wantedLevel() === 0;
        break;
      }
    }

    if (complete) {
      act.step++;
      if (act.step >= act.def.steps.length) {
        this.finish(engine, true);
      } else {
        this.applyStep(engine);
      }
    }
  }

  private applyStep(engine: WorldEngine): void {
    const act = this.active!;
    const step = act.def.steps[act.step];
    useHud.setState({
      mission: { title: act.def.title, objective: step.text },
    });
    if ("x" in step) {
      engine.setWaypoint(step.x, step.z);
      engine.setMissionMarker(step.x, step.z);
    } else if (step.kind === "enterVehicle" && step.vehicleKey) {
      // Marker on the target car's spawn point (it idles until stolen).
      const mx = act.ctx[`${step.vehicleKey}:x`];
      const mz = act.ctx[`${step.vehicleKey}:z`];
      if (mx !== undefined && mz !== undefined) {
        engine.setWaypoint(mx, mz);
        engine.setMissionMarker(mx, mz);
      }
    } else {
      engine.clearWaypoint();
      engine.setMissionMarker(null, null);
    }
  }

  private finish(engine: WorldEngine, passed: boolean): void {
    const act = this.active!;
    this.active = null;
    engine.clearWaypoint();
    engine.setMissionMarker(null, null);
    useHud.setState({
      mission: null,
      missionFlash: passed ? `MISSION PASSED · $${act.def.reward}` : "MISSION FAILED",
    });
    this.flashTimer = 5;
    if (passed) {
      engine.sim?.giveMoney(act.def.reward);
      this.done.add(act.def.id);
      try {
        localStorage.setItem(DONE_KEY, JSON.stringify([...this.done]));
      } catch {
        // non-fatal
      }
    }
  }
}
