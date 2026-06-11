import { CONFIG } from "./config";
import { HeightFieldRegistry } from "./heightField";
import { CollisionWorld } from "./collision";

export interface MoveInput {
  dirX: number;
  dirZ: number;
  moving: boolean;
  sprint: boolean;
}

/**
 * Kinematic first-person body. All math in f64 world meters. Vertical is a
 * clamp to the sampled ground (low-passed to soften DEM stair-steps); when
 * the tile under foot isn't decoded yet we hold the last height, so falling
 * through the world is impossible by construction.
 */
export class Player {
  x: number;
  y: number;
  z: number;
  enabled = false;
  private lastGround: number | null = null;
  private smoothGround: number | null = null;

  constructor(
    private heights: HeightFieldRegistry,
    private collision: CollisionWorld,
    spawnX: number,
    spawnZ: number,
  ) {
    this.x = spawnX;
    this.z = spawnZ;
    this.y = 40;
  }

  update(input: MoveInput, dt: number): void {
    if (this.enabled && input.moving) {
      const speed = input.sprint ? CONFIG.sprintSpeed : CONFIG.walkSpeed;
      // Clamp per-frame travel below the player radius so a wall can never
      // be tunneled in one step (also tames dt spikes after tab switches).
      const step = Math.min(speed * dt, CONFIG.playerRadius * 0.9);
      const resolved = this.collision.resolve(
        this.x + input.dirX * step,
        this.z + input.dirZ * step,
        CONFIG.playerRadius,
      );
      this.x = resolved.x;
      this.z = resolved.z;
    }
    this.updateVertical(dt);
  }

  private updateVertical(dt: number): void {
    const ground = this.heights.sample(this.x, this.z);
    if (ground !== null) this.lastGround = ground;
    if (this.lastGround === null) return; // nothing decoded yet; hold in air
    if (this.smoothGround === null) {
      this.smoothGround = this.lastGround;
    } else {
      this.smoothGround += (this.lastGround - this.smoothGround) * Math.min(1, dt * 8);
    }
    this.y = this.smoothGround + CONFIG.eyeHeight;
  }
}
