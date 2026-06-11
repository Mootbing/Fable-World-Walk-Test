"use client";

import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { PointerLockControls } from "@react-three/drei";
import type { PointerLockControls as PointerLockControlsImpl } from "three-stdlib";
import * as THREE from "three";
import { WorldEngine } from "@/engine/engine";
import { CONFIG } from "@/engine/config";
import { useHud, LOCK_EVENT } from "@/engine/store";

function Scene({ engine }: { engine: WorldEngine }) {
  const camera = useThree((s) => s.camera);
  const keys = useRef<Record<string, boolean>>({});
  const forward = useMemo(() => new THREE.Vector3(), []);
  const right = useMemo(() => new THREE.Vector3(), []);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      keys.current[e.code] = true;
    };
    const up = (e: KeyboardEvent) => {
      keys.current[e.code] = false;
    };
    const blur = () => {
      keys.current = {};
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    const k = keys.current;
    const locked = useHud.getState().locked;

    camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    right.crossVectors(forward, THREE.Object3D.DEFAULT_UP).normalize();

    let dirX = 0;
    let dirZ = 0;
    if (locked) {
      if (k.KeyW || k.ArrowUp) {
        dirX += forward.x;
        dirZ += forward.z;
      }
      if (k.KeyS || k.ArrowDown) {
        dirX -= forward.x;
        dirZ -= forward.z;
      }
      if (k.KeyD || k.ArrowRight) {
        dirX += right.x;
        dirZ += right.z;
      }
      if (k.KeyA || k.ArrowLeft) {
        dirX -= right.x;
        dirZ -= right.z;
      }
    }
    const len = Math.hypot(dirX, dirZ);
    if (len > 1e-6) {
      dirX /= len;
      dirZ /= len;
    }

    engine.update(
      {
        dirX,
        dirZ,
        moving: len > 1e-6,
        sprint: !!(k.ShiftLeft || k.ShiftRight),
      },
      dt,
    );
    camera.position.set(engine.player.x, engine.player.y, engine.player.z);
  });

  return <primitive object={engine.group} />;
}

function LockControls() {
  const controls = useRef<PointerLockControlsImpl>(null);

  useEffect(() => {
    const lock = () => controls.current?.lock();
    window.addEventListener(LOCK_EVENT, lock);
    return () => window.removeEventListener(LOCK_EVENT, lock);
  }, []);

  return (
    // selector matching nothing: without it drei locks on ANY document click,
    // bypassing the StartOverlay gating. LOCK_EVENT is the only lock path.
    <PointerLockControls
      ref={controls}
      makeDefault
      selector="#plc-noop"
      onLock={() => useHud.setState({ locked: true })}
      onUnlock={() => useHud.setState({ locked: false })}
    />
  );
}

export default function World() {
  // Lazy ref keeps exactly one engine per mount (strict mode is off).
  const engineRef = useRef<WorldEngine | null>(null);
  engineRef.current ??= new WorldEngine();
  const engine = engineRef.current;

  useEffect(() => {
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, [engine]);

  return (
    <Canvas
      camera={{ fov: 75, near: 0.1, far: 8000, position: [0, 40, 0] }}
      gl={{ antialias: true, powerPreference: "high-performance" }}
    >
      <color attach="background" args={[CONFIG.skyColor]} />
      <fog attach="fog" args={[CONFIG.skyColor, CONFIG.fogNear, CONFIG.fogFar]} />
      <hemisphereLight args={["#ffffff", "#8e8678", 1.15]} />
      <directionalLight position={[350, 700, 420]} intensity={1.3} />
      <Scene engine={engine} />
      <LockControls />
    </Canvas>
  );
}
