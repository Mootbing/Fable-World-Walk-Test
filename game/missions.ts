import type { WorldEngine } from "@/engine/engine";
import type { MissionDef } from "./missionRuntime";

/**
 * Story missions. M01 is the classic opener: steal a marked car, deliver
 * it, shake the tail you picked up doing it.
 */

export const M01: MissionDef = {
  id: "m01",
  title: "Off The Bus",
  reward: 500,
  setup(engine: WorldEngine) {
    // The marked taxi idles up the avenue, clear of the spawn plaza.
    const x = 10;
    const z = -45;
    const id = engine.sim!.debugSpawnTraffic(x, z, 0, 3);
    return { taxi: id, "taxi:x": x, "taxi:z": z };
  },
  steps: [
    { kind: "goTo", x: 2, z: -40, radius: 6, text: "Get to the marked corner" },
    { kind: "enterVehicle", vehicleKey: "taxi", text: "Steal the marked taxi" },
    { kind: "driveTo", x: 10, z: -100, radius: 22, text: "Deliver it to the drop uptown" },
    { kind: "loseWanted", text: "Lose the heat" },
  ],
};

export const M02: MissionDef = {
  id: "m02",
  title: "Clean Sweep",
  reward: 750,
  setup(engine: WorldEngine) {
    // The mark takes his lunch on the same corner every day.
    const target = engine.sim!.debugSpawnPed(-20, -55);
    return { target };
  },
  steps: [
    { kind: "goTo", x: -20, z: -47, radius: 7, text: "Find the mark near the corner" },
    { kind: "eliminate", pedKey: "target", text: "Take him out" },
    { kind: "loseWanted", text: "Disappear" },
  ],
};

export const M03: MissionDef = {
  id: "m03",
  title: "Hot Wheels",
  reward: 750,
  setup(engine: WorldEngine) {
    // Evidence on wheels, parked and waiting for a tow.
    const x = -15;
    const z = -70;
    const car = engine.sim!.debugSpawnTraffic(x, z, 0, 0);
    return { car, "car:x": x, "car:z": z };
  },
  steps: [
    { kind: "goTo", x: -15, z: -62, radius: 7, text: "Get eyes on the sedan" },
    { kind: "destroyVehicle", vehicleKey: "car", text: "Torch the evidence" },
    { kind: "loseWanted", text: "Walk away from the fire" },
  ],
};

export const M04: MissionDef = {
  id: "m04",
  title: "Hard Deadline",
  reward: 600,
  setup() {
    return {};
  },
  steps: [
    { kind: "enterVehicle", text: "Grab any set of wheels" },
    {
      kind: "timedDriveTo",
      x: 10,
      z: -100,
      radius: 22,
      seconds: 90,
      text: "Make the drop before they walk",
    },
  ],
};

export const MISSIONS: MissionDef[] = [M01, M02, M03, M04];
