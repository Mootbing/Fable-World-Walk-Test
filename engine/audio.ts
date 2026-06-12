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

export const STATIONS = ["Nightdrive FM", "Bedrock Beats", "Static AM"] as const;

/** Chord roots (Hz) for the synthwave loop: Am, F, C, G. */
const NIGHTDRIVE_ROOTS = [110, 87.31, 130.81, 98];
/** Lo-fi stab: minor 7th intervals over the root. */
const LOFI_CHORD = [1, 1.189, 1.498, 1.782];

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

  /** 0 = off, 1..STATIONS.length = on-air. */
  station = 0;
  private radioGain: GainNode | null = null;
  private radioBarEnd = 0;
  private radioBarIdx = 0;

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

    this.radioGain = ctx.createGain();
    this.radioGain.gain.value = 0;
    this.radioGain.connect(this.master);

    this.unlocked = true;
  }

  get stationName(): string {
    return this.station === 0 ? "Radio off" : STATIONS[this.station - 1];
  }

  /** Cycle off → 1 → … → N → off; returns the new station. */
  nextStation(): number {
    this.station = (this.station + 1) % (STATIONS.length + 1);
    // Drop straight into the new program.
    if (this.ctx) {
      this.radioBarEnd = this.ctx.currentTime + 0.05;
      this.radioBarIdx = 0;
    }
    return this.station;
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

    // Radio: audible only in a vehicle; bars scheduled half a second ahead.
    const onAir = this.station > 0 && s.driving;
    this.radioGain?.gain.setTargetAtTime(onAir ? 0.13 : 0, t, 0.12);
    if (onAir && this.radioGain) {
      if (this.radioBarEnd < t) this.radioBarEnd = t + 0.05;
      while (this.radioBarEnd < t + 0.6) {
        this.radioBarEnd += this.scheduleBar(this.station, this.radioBarEnd, this.radioBarIdx++);
      }
    }
  }

  /** Synthesize one bar of the station at barStart; returns bar length s. */
  private scheduleBar(station: number, barStart: number, barIdx: number): number {
    const ctx = this.ctx;
    const out = this.radioGain;
    if (!ctx || !out) return 2;
    if (station === 1) {
      // Nightdrive FM — 100bpm synthwave: pad chord, offbeat bass, hats.
      const bar = (60 / 100) * 4;
      const root = NIGHTDRIVE_ROOTS[barIdx % 4];
      for (const mul of [1, 1.5, 2.02]) {
        const o = ctx.createOscillator();
        o.type = "sawtooth";
        o.frequency.value = root * mul;
        const f = ctx.createBiquadFilter();
        f.type = "lowpass";
        f.frequency.setValueAtTime(420, barStart);
        f.frequency.linearRampToValueAtTime(900, barStart + bar / 2);
        f.frequency.linearRampToValueAtTime(420, barStart + bar);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.06, barStart);
        g.gain.setValueAtTime(0.06, barStart + bar - 0.05);
        g.gain.linearRampToValueAtTime(0.0001, barStart + bar);
        o.connect(f); f.connect(g); g.connect(out);
        o.start(barStart); o.stop(barStart + bar + 0.02);
      }
      for (let n = 0; n < 8; n++) {
        const tN = barStart + (n * bar) / 8;
        const b = ctx.createOscillator();
        b.type = "sine";
        b.frequency.value = root * (n % 2 === 0 ? 0.5 : 1);
        const g = ctx.createGain();
        g.gain.setValueAtTime(n % 2 ? 0.1 : 0.16, tN);
        g.gain.exponentialRampToValueAtTime(0.001, tN + bar / 9);
        b.connect(g); g.connect(out);
        b.start(tN); b.stop(tN + bar / 8);
        if (this.noiseBuf && n % 2 === 1) {
          const h = ctx.createBufferSource();
          h.buffer = this.noiseBuf;
          const hf = ctx.createBiquadFilter();
          hf.type = "highpass";
          hf.frequency.value = 6000;
          const hg = ctx.createGain();
          hg.gain.setValueAtTime(0.05, tN);
          hg.gain.exponentialRampToValueAtTime(0.001, tN + 0.05);
          h.connect(hf); hf.connect(hg); hg.connect(out);
          h.start(tN, Math.random()); h.stop(tN + 0.06);
        }
      }
      return bar;
    }
    if (station === 2) {
      // Bedrock Beats — 84bpm lo-fi: kick 1 & 3.5, snare 2/4, dusty stab.
      const bar = (60 / 84) * 4;
      const beat = bar / 4;
      for (const at of [0, 2.5 * beat]) {
        const k = ctx.createOscillator();
        k.type = "sine";
        k.frequency.setValueAtTime(120, barStart + at);
        k.frequency.exponentialRampToValueAtTime(40, barStart + at + 0.12);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.3, barStart + at);
        g.gain.exponentialRampToValueAtTime(0.001, barStart + at + 0.18);
        k.connect(g); g.connect(out);
        k.start(barStart + at); k.stop(barStart + at + 0.2);
      }
      if (this.noiseBuf) {
        for (const at of [beat, 3 * beat]) {
          const sN = ctx.createBufferSource();
          sN.buffer = this.noiseBuf;
          const f = ctx.createBiquadFilter();
          f.type = "bandpass";
          f.frequency.value = 1800;
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.16, barStart + at);
          g.gain.exponentialRampToValueAtTime(0.001, barStart + at + 0.16);
          sN.connect(f); f.connect(g); g.connect(out);
          sN.start(barStart + at, Math.random()); sN.stop(barStart + at + 0.18);
        }
      }
      const stabRoot = NIGHTDRIVE_ROOTS[(barIdx + 2) % 4] * 2;
      for (const mul of LOFI_CHORD) {
        const o = ctx.createOscillator();
        o.type = "triangle";
        o.frequency.value = stabRoot * mul;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.045, barStart);
        g.gain.exponentialRampToValueAtTime(0.001, barStart + beat * 1.6);
        o.connect(g); g.connect(out);
        o.start(barStart); o.stop(barStart + beat * 1.7);
      }
      return bar;
    }
    // Static AM — talk radio: syllabic bandpassed noise with pauses.
    const seg = 1.6;
    if (this.noiseBuf) {
      let tN = barStart + 0.1;
      while (tN < barStart + seg - 0.15) {
        const dur = 0.05 + Math.random() * 0.16;
        const sN = ctx.createBufferSource();
        sN.buffer = this.noiseBuf;
        const f = ctx.createBiquadFilter();
        f.type = "bandpass";
        f.frequency.value = 400 + Math.random() * 1800;
        f.Q.value = 4;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.14, tN);
        g.gain.exponentialRampToValueAtTime(0.001, tN + dur);
        sN.connect(f); f.connect(g); g.connect(out);
        sN.start(tN, Math.random()); sN.stop(tN + dur + 0.02);
        tN += dur + (Math.random() < 0.25 ? 0.3 : 0.04);
      }
    }
    return seg;
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
