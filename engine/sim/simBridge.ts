import init, { Sim } from "@/sim/pkg/sim";
import { ENTITY_STRIDE } from "./entityLayout";

/**
 * Owns the wasm sim instance and all views into its linear memory. Views are
 * recreated on every access: wasm memory growth detaches ArrayBuffers, so a
 * cached view can silently go stale. Pointers from Rust are byte offsets;
 * Float32Array lengths are in elements — keep that math in here only.
 */
export class SimBridge {
  lastStepMs = 0;

  private constructor(
    private readonly sim: Sim,
    private readonly memory: WebAssembly.Memory,
  ) {}

  static async boot(seed: number): Promise<SimBridge> {
    const out = await init({ module_or_path: "/sim_bg.wasm" });
    const sim = new Sim(BigInt(seed), 0, 0);
    return new SimBridge(sim, out.memory);
  }

  step(dt: number): void {
    const t0 = performance.now();
    this.sim.step(dt);
    this.lastStepMs = performance.now() - t0;
  }

  get tick(): number {
    return this.sim.tick();
  }

  static get version(): string {
    return Sim.version();
  }

  entityView(): Float32Array {
    return this.f32(this.sim.entities_ptr(), this.sim.entity_count() * ENTITY_STRIDE);
  }

  entityCount(): number {
    return this.sim.entity_count();
  }

  /**
   * PR1 acceptance benchmark: time a full readback pass (fresh view + touch
   * every lane) over `n` live entities. Returns average ms per pass.
   */
  benchmark(n: number, passes = 100): number {
    this.sim.bench_spawn(n);
    this.sim.step(1 / 60);
    let sink = 0;
    const t0 = performance.now();
    for (let p = 0; p < passes; p++) {
      const view = this.entityView();
      for (let i = 0; i < view.length; i++) sink += view[i];
    }
    const avg = (performance.now() - t0) / passes;
    // Keep `sink` observable so the loop can't be optimized away.
    if (!Number.isFinite(sink)) console.warn("benchmark sink overflow");
    this.sim.bench_spawn(0);
    return avg;
  }

  dispose(): void {
    this.sim.free();
  }

  private f32(bytePtr: number, len: number): Float32Array {
    return new Float32Array(this.memory.buffer, bytePtr, len);
  }
}
