import { useHud, LOCK_EVENT } from "./store";
import { getSettings } from "./settings";

/** One frame of consumed input; deltas are reset by each frame() call. */
export interface InputFrame {
  /** -1..1, +forward / +right (strafe). */
  forward: number;
  strafe: number;
  sprint: boolean;
  jump: boolean;
  /** Enter/exit vehicle key held (the sim edge-detects). */
  enter: boolean;
  /** Horn key held (driving). */
  horn: boolean;
  /** LMB attack held. */
  fire: boolean;
  /** RMB aim held. */
  aim: boolean;
  reload: boolean;
  switchWeapon: boolean;
  /** Mouse deltas already scaled to radians. */
  yawDelta: number;
  pitchDelta: number;
  /** Rising-edge of the camera toggle key (V). */
  toggleCamera: boolean;
  /** Rising-edge of the road-graph debug overlay key (G). */
  toggleRoadDebug: boolean;
  /** Weapon slot requested via Digit1-5 this frame, or null. */
  equipSlot: number | null;
  /** T edge: start/cancel a vehicle side activity. */
  toggleActivity: boolean;
}

const SENSITIVITY = 0.0022;

/**
 * Owns pointer lock + raw input capture (replaces drei PointerLockControls;
 * the camera quaternion is now CameraRig's job, not a control's). Lock is
 * still only requested via LOCK_EVENT from the StartOverlay; Esc releases
 * it through the browser and we mirror that into the store.
 */
export class InputManager {
  private keys: Record<string, boolean> = {};
  private mouse: Record<number, boolean> = {};
  private yawAcc = 0;
  private pitchAcc = 0;
  private toggleEdge = false;
  private roadDebugEdge = false;
  private equipEdge: number | null = null;
  private activityEdge = false;
  private element: HTMLElement | null = null;
  private detachFns: (() => void)[] = [];

  attach(element: HTMLElement): void {
    this.element = element;
    const on = <K extends keyof WindowEventMap>(
      target: Window | Document,
      type: K | string,
      fn: (e: never) => void,
    ) => {
      target.addEventListener(type as string, fn as EventListener);
      this.detachFns.push(() => target.removeEventListener(type as string, fn as EventListener));
    };

    on(window, "keydown", (e: KeyboardEvent) => {
      this.keys[e.code] = true;
      if (e.code === "KeyV" && !e.repeat && this.locked()) this.toggleEdge = true;
      if (e.code === "KeyG" && !e.repeat && this.locked()) this.roadDebugEdge = true;
      if (e.code === "KeyT" && !e.repeat && this.locked()) this.activityEdge = true;
      if (e.code === "Tab") {
        e.preventDefault(); // keep focus; Tab is the weapon wheel
        if (!e.repeat && this.locked()) useHud.setState({ wheelOpen: true });
      }
      if (/^Digit[1-5]$/.test(e.code) && !e.repeat && this.locked()) {
        this.equipEdge = Number(e.code.slice(5)) - 1;
      }
      if (e.code === "KeyM" && !e.repeat) {
        // Map toggle: opening releases pointer lock so the cursor can
        // click; closing re-locks (keydown carries user activation).
        const hud = useHud.getState();
        if (hud.mapOpen) {
          useHud.setState({ mapOpen: false });
          this.element?.requestPointerLock();
        } else if (hud.locked) {
          useHud.setState({ mapOpen: true });
          document.exitPointerLock();
        }
      }
    });
    on(window, "keyup", (e: KeyboardEvent) => {
      this.keys[e.code] = false;
      if (e.code === "Tab") useHud.setState({ wheelOpen: false });
    });
    on(window, "blur", () => {
      this.keys = {};
    });
    on(window, "mousedown", (e: MouseEvent) => {
      this.mouse[e.button] = true;
    });
    on(window, "mouseup", (e: MouseEvent) => {
      this.mouse[e.button] = false;
    });
    on(window, "contextmenu", (e: MouseEvent) => {
      if (this.locked()) e.preventDefault();
    });
    on(window, "mousemove", (e: MouseEvent) => {
      if (!document.pointerLockElement) return;
      const s = getSettings();
      this.yawAcc -= e.movementX * SENSITIVITY * s.sensitivity;
      this.pitchAcc -= e.movementY * SENSITIVITY * s.sensitivity * (s.invertY ? -1 : 1);
    });
    on(window, LOCK_EVENT, () => {
      this.element?.requestPointerLock();
    });
    on(document, "pointerlockchange", () => {
      const locked = document.pointerLockElement === this.element;
      useHud.setState(locked ? { locked, started: true } : { locked });
    });
  }

  detach(): void {
    for (const fn of this.detachFns) fn();
    this.detachFns = [];
    this.element = null;
  }

  private locked(): boolean {
    return useHud.getState().locked;
  }

  /** Consume accumulated input. Movement only flows while locked. */
  frame(): InputFrame {
    const k = this.keys;
    const locked = this.locked();
    const frame: InputFrame = {
      forward: locked ? (k.KeyW || k.ArrowUp ? 1 : 0) - (k.KeyS || k.ArrowDown ? 1 : 0) : 0,
      strafe: locked ? (k.KeyD || k.ArrowRight ? 1 : 0) - (k.KeyA || k.ArrowLeft ? 1 : 0) : 0,
      sprint: locked && !!(k.ShiftLeft || k.ShiftRight),
      jump: locked && !!k.Space,
      enter: locked && !!k.KeyE,
      horn: locked && !!k.KeyH,
      fire: locked && !!this.mouse[0],
      aim: locked && !!this.mouse[2],
      reload: locked && !!k.KeyR,
      switchWeapon: locked && !!k.KeyQ,
      yawDelta: this.yawAcc,
      pitchDelta: this.pitchAcc,
      toggleCamera: this.toggleEdge,
      toggleRoadDebug: this.roadDebugEdge,
      equipSlot: this.equipEdge,
      toggleActivity: this.activityEdge,
    };
    this.yawAcc = 0;
    this.pitchAcc = 0;
    this.toggleEdge = false;
    this.roadDebugEdge = false;
    this.equipEdge = null;
    this.activityEdge = false;
    return frame;
  }
}
