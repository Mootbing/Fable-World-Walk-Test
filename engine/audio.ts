/**
 * Procedural WebAudio: every sound is synthesized — no assets. The
 * AudioContext is created on the first pointer lock (a user gesture) and
 * may sit suspended in headless runs; scheduling still works, so tests
 * count voices without needing audible output.
 *
 * Loops: engine (saw+sub pitched by speed), siren (two detuned sines on
 * an LFO), rain bed (filtered noise). One-shots: gunshots, explosions,
 * crashes, horns, chimes — fired from the sim event ring.
 */

interface AudioUpdate {
  driving: boolean;
  speed: number;
  sirenNear: boolean;
  rainIntensity: number;
  thunder: boolean;
}

export class AudioEngine {
  unlocked = false;
  /** Lifetime one-shots scheduled (test observability). */
  voicesPlayed = 0;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;

  private engineOsc: OscillatorNode | null = null;
  private engineSub: OscillatorNode | null = null;
  private engineGain: GainNode | null = null;

  private sirenOscA: OscillatorNode | null = null;
  private sirenOscB: OscillatorNode | null = null;
  private sirenLfo: OscillatorNode | null = null;
  private sirenGain: GainNode | null = null;

  private rainSrc: AudioBufferSourceNode | null = null;
  private rainGain: GainNode | null = null;

  get ctxState(): string {
    return this.ctx ? this.ctx.state : "none";
  }

  /** Call on/after a user gesture (pointer lock). Safe to call again. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => {});
      return;
    }
    const Ctx = window.AudioContext ?? null;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.55;
    this.master.connect(ctx.destination);

    // 2s shared noise loop for every percussive voice.
    this.noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    // Engine: saw + one-octave-down sine through a lowpass.
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    const engineFilter = ctx.createBiquadFilter();
    engineFilter.type = "lowpass";
    engineFilter.frequency.value = 480;
    this.engineOsc = ctx.createOscillator();
    this.engineOsc.type = "sawtooth";
    this.engineOsc.frequency.value = 50;
    this.engineSub = ctx.createOscillator();
    this.engineSub.type = "sine";
    this.engineSub.frequency.value = 25;
    this.engineOsc.connect(engineFilter);
    this.engineSub.connect(engineFilter);
    engineFilter.connect(this.engineGain);
    this.engineGain.connect(this.master);
    this.engineOsc.start();
    this.engineSub.start();

    // Siren: two detuned sines, pitch wobbled by an LFO.
    this.sirenGain = ctx.createGain();
    this.sirenGain.gain.value = 0;
    this.sirenOscA = ctx.createOscillator();
    this.sirenOscA.frequency.value = 690;
    this.sirenOscB = ctx.createOscillator();
    this.sirenOscB.frequency.value = 922;
    this.sirenLfo = ctx.createOscillator();
    this.sirenLfo.frequency.value = 0.65;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 140;
    this.sirenLfo.connect(lfoDepth);
    lfoDepth.connect(this.sirenOscA.frequency);
    lfoDepth.connect(this.sirenOscB.frequency);
    const sirenMix = ctx.createGain();
    sirenMix.gain.value = 0.5;
    this.sirenOscA.connect(sirenMix);
    this.sirenOscB.connect(sirenMix);
    sirenMix.connect(this.sirenGain);
    this.sirenGain.connect(this.master);
    this.sirenOscA.start();
    this.sirenOscB.start();
    this.sirenLfo.start();

    // Rain bed: looped noise through a dark lowpass.
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    const rainFilter = ctx.createBiquadFilter();
    rainFilter.type = "lowpass";
    rainFilter.frequency.value = 900;
    this.rainSrc = ctx.createBufferSource();
    this.rainSrc.buffer = this.noiseBuf;
    this.rainSrc.loop = true;
    this.rainSrc.connect(rainFilter);
    rainFilter.connect(this.rainGain);
    this.rainGain.connect(this.master);
    this.rainSrc.start();

    this.unlocked = true;
  }

  /** Per-frame loop levels; cheap param nudges only. */
  update(s: AudioUpdate): void {
    const ctx = this.ctx;
    if (!ctx || !this.engineGain || !this.engineOsc || !this.engineSub) return;
    const t = ctx.currentTime;
    const rpm = Math.min(Math.abs(s.speed) / 45, 1);
    const engineTarget = s.driving ? 0.16 + rpm * 0.1 : 0;
    this.engineGain.gain.setTargetAtTime(engineTarget, t, 0.08);
    this.engineOsc.frequency.setTargetAtTime(46 + rpm * 170, t, 0.06);
    this.engineSub.frequency.setTargetAtTime(23 + rpm * 85, t, 0.06);
    this.sirenGain?.gain.setTargetAtTime(s.sirenNear ? 0.12 : 0, t, 0.15);
    this.rainGain?.gain.setTargetAtTime(s.rainIntensity * 0.16, t, 0.4);
    if (s.thunder) this.thunder();
  }

  /** Route one frame's drained sim events into one-shot voices. */
  handleEvents(events: ArrayLike<number>): void {
    for (let i = 0; i < events.length; i += 4) {
      switch (events[i]) {
        case 2: // landed
          this.thump(0.06, 240);
          break;
        case 5: // crash
          this.thump(0.18, 320);
          break;
        case 6: // horn
          this.horn();
          break;
        case 11: // pickup
          this.blip(880, 1320, 0.1);
          break;
        case 12: // punch
          this.thump(0.08, 900);
          break;
        case 14: // gunshot
          this.gunshot();
          break;
        case 15: // reload
          this.blip(420, 300, 0.05);
          break;
        case 16: // dry fire
          this.blip(900, 700, 0.03);
          break;
        case 17: // explosion
          this.explosion();
          break;
        case 18: // wanted changed
          if (events[i + 1] > 0) this.blip(520, 392, 0.18);
          break;
        case 20: // hidden package
          this.jingle();
          break;
      }
    }
  }

  private voice(): { ctx: AudioContext; out: GainNode } | null {
    if (!this.ctx || !this.master) return null;
    this.voicesPlayed++;
    const g = this.ctx.createGain();
    g.connect(this.master);
    return { ctx: this.ctx, out: g };
  }

  private noiseShot(
    dur: number,
    filterHz: number,
    gain: number,
    sweepTo?: number,
  ): void {
    const v = this.voice();
    if (!v || !this.noiseBuf) return;
    const { ctx, out } = v;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.setValueAtTime(filterHz, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    src.connect(f);
    f.connect(out);
    out.gain.setValueAtTime(gain, t);
    out.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.start(t, Math.random());
    src.stop(t + dur + 0.05);
  }

  private gunshot(): void {
    this.noiseShot(0.16, 2400, 0.5, 300);
  }

  private explosion(): void {
    this.noiseShot(0.9, 420, 0.9, 60);
    const v = this.voice();
    if (!v) return;
    const { ctx, out } = v;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(34, t + 0.7);
    o.connect(out);
    out.gain.setValueAtTime(0.7, t);
    out.gain.exponentialRampToValueAtTime(0.001, t + 0.8);
    o.start(t);
    o.stop(t + 0.85);
  }

  private thump(dur: number, hz: number): void {
    this.noiseShot(dur, hz, 0.32);
  }

  private thunder(): void {
    this.noiseShot(1.6, 240, 0.5, 50);
  }

  private horn(): void {
    const v = this.voice();
    if (!v) return;
    const { ctx, out } = v;
    const t = ctx.currentTime;
    for (const hz of [370, 466]) {
      const o = ctx.createOscillator();
      o.type = "square";
      o.frequency.value = hz;
      o.connect(out);
      o.start(t);
      o.stop(t + 0.35);
    }
    out.gain.setValueAtTime(0.12, t);
    out.gain.setValueAtTime(0.12, t + 0.3);
    out.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
  }

  private blip(fromHz: number, toHz: number, dur: number): void {
    const v = this.voice();
    if (!v) return;
    const { ctx, out } = v;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(fromHz, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(toHz, 1), t + dur);
    o.connect(out);
    out.gain.setValueAtTime(0.18, t);
    out.gain.exponentialRampToValueAtTime(0.001, t + dur + 0.02);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private jingle(): void {
    const v = this.voice();
    if (!v) return;
    const { ctx, out } = v;
    const t = ctx.currentTime;
    [659, 880, 1319].forEach((hz, n) => {
      const o = ctx.createOscillator();
      o.type = "triangle";
      o.frequency.value = hz;
      o.connect(out);
      o.start(t + n * 0.09);
      o.stop(t + n * 0.09 + 0.12);
    });
    out.gain.setValueAtTime(0.16, t);
    out.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
  }

  dispose(): void {
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.unlocked = false;
  }
}
