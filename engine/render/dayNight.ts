import * as THREE from "three";
import { CONFIG } from "../config";

/**
 * Clock-driven daylight: the game clock (1 real s = 1 game min) sweeps a
 * sun angle; everything else — sky/fog color, light intensities, window
 * glow, headlights — derives from one daylight factor so the whole scene
 * agrees about what time it is.
 */

export interface DayState {
  /** 0 = full night, 1 = full day. */
  daylight: number;
  sky: THREE.Color;
  hemiIntensity: number;
  dirIntensity: number;
  dirColor: THREE.Color;
  sunPos: THREE.Vector3;
}

const DAY_SKY = new THREE.Color(CONFIG.skyColor);
const NIGHT_SKY = new THREE.Color(0x0a0f1c);
const DUSK_SKY = new THREE.Color(0xcf7a45);
const DAY_SUN = new THREE.Color(0xffffff);
const LOW_SUN = new THREE.Color(0xffb070);
const MOON = new THREE.Color(0x8fa3c8);

export function createDayState(): DayState {
  return {
    daylight: 1,
    sky: DAY_SKY.clone(),
    hemiIntensity: 1.15,
    dirIntensity: 1.3,
    dirColor: DAY_SUN.clone(),
    sunPos: new THREE.Vector3(350, 700, 420),
  };
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Update `out` in place from the game clock (minutes, 0..1440). */
export function computeDayState(clockMinutes: number, out: DayState): void {
  // 06:00 sunrise, 12:00 zenith, 18:00 sunset.
  const theta = (clockMinutes / 1440 - 0.25) * Math.PI * 2;
  const elev = Math.sin(theta);
  const daylight = smoothstep(-0.06, 0.22, elev);
  out.daylight = daylight;

  // Sky: night → day, with a dusk/dawn band blended in near the horizon.
  out.sky.copy(NIGHT_SKY).lerp(DAY_SKY, daylight);
  const duskiness = Math.max(0, 1 - Math.abs(elev) * 4) * 0.65;
  out.sky.lerp(DUSK_SKY, duskiness);

  out.hemiIntensity = 0.22 + 0.93 * daylight;

  // Sun above the horizon, a faint moon below it.
  if (elev > 0) {
    out.dirIntensity = 0.15 + 1.15 * daylight;
    out.dirColor.copy(LOW_SUN).lerp(DAY_SUN, smoothstep(0.05, 0.45, elev));
  } else {
    out.dirIntensity = 0.12;
    out.dirColor.copy(MOON);
  }
  const azimuth = theta; // east → overhead → west
  out.sunPos.set(Math.cos(azimuth) * 600, Math.max(Math.abs(elev), 0.08) * 700, 420);
}
