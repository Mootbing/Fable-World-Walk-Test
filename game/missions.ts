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

export const MISSIONS: MissionDef[] = [M01];
