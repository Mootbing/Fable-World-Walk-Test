import { useHud, LOCK_EVENT } from "./store";

/** One frame of consumed input; deltas are reset by each frame() call. */
export interface InputFrame {
  /** -1..1, +forward / +right (strafe). */
  forward: number;
  strafe: number;
  sprint: boolean;
  jump: boolean;
  /** Enter/exit vehicle key held (the sim edge-detects). */
  enter: boolean;
  /** Mouse deltas already scaled to radians. */
  yawDelta: number;
  pitchDelta: number;
  /** Rising-edge of the camera toggle key (V). */
  toggleCamera: boolean;
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
  private yawAcc = 0;
  private pitchAcc = 0;
  private toggleEdge = false;
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
    });
    on(window, "keyup", (e: KeyboardEvent) => {
      this.keys[e.code] = false;
    });
    on(window, "blur", () => {
      this.keys = {};
    });
    on(window, "mousemove", (e: MouseEvent) => {
      if (!document.pointerLockElement) return;
      this.yawAcc -= e.movementX * SENSITIVITY;
      this.pitchAcc -= e.movementY * SENSITIVITY;
    });
    on(window, LOCK_EVENT, () => {
      this.element?.requestPointerLock();
    });
    on(document, "pointerlockchange", () => {
      useHud.setState({ locked: document.pointerLockElement === this.element });
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
      yawDelta: this.yawAcc,
      pitchDelta: this.pitchAcc,
      toggleCamera: this.toggleEdge,
    };
    this.yawAcc = 0;
    this.pitchAcc = 0;
    this.toggleEdge = false;
    return frame;
  }
}
