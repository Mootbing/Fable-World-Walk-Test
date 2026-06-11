"use client";

import { useEffect, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { WorldEngine } from "@/engine/engine";
import { CONFIG } from "@/engine/config";
import { InputManager } from "@/engine/input";
import { CameraRig } from "@/engine/render/cameraRig";
import { installTestHook } from "@/engine/testHook";
import { engineRef as globalEngineRef } from "@/engine/engineRef";

function Scene({
  engine,
  input,
  rig,
}: {
  engine: WorldEngine;
  input: InputManager;
  rig: CameraRig;
}) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const gl = useThree((s) => s.gl);

  useEffect(() => {
    input.attach(gl.domElement);
    return () => input.detach();
  }, [input, gl]);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    const frame = input.frame();
    rig.integrate(frame);
    const move = rig.moveDir(frame);

    engine.update(
      {
        dirX: move.dirX,
        dirZ: move.dirZ,
        moving: move.moving,
        sprint: frame.sprint,
        jump: frame.jump,
        enter: frame.enter,
        horn: frame.horn,
        fire: frame.fire,
        aim: frame.aim,
        reload: frame.reload,
        switchWeapon: frame.switchWeapon,
        aimYaw: rig.yaw,
        forward: frame.forward,
        strafe: frame.strafe,
        toggleRoadDebug: frame.toggleRoadDebug,
        equipSlot: frame.equipSlot,
      },
      dt,
    );

    rig.driving = engine.driveState;
    rig.aiming = frame.aim && !engine.driveState;
    engine.avatar.visible = rig.mode === "tp" && !engine.driveState;
    rig.apply(camera, engine.playerX, engine.playerY, engine.playerZ, engine.cameraClamp, dt);
    engine.camMode = rig.mode;
    engine.camPos = { x: camera.position.x, y: camera.position.y, z: camera.position.z };
    engine.camYaw = rig.yaw;
  });

  return <primitive object={engine.group} />;
}

export default function World() {
  // Lazy refs keep exactly one engine/input/rig per mount (strict mode off).
  const engineRef = useRef<WorldEngine | null>(null);
  engineRef.current ??= new WorldEngine();
  const engine = engineRef.current;
  const inputRef = useRef<InputManager | null>(null);
  inputRef.current ??= new InputManager();
  const rigRef = useRef<CameraRig | null>(null);
  rigRef.current ??= new CameraRig();

  useEffect(() => installTestHook(engine), [engine]);

  useEffect(() => {
    globalEngineRef.current = engine;
    return () => {
      if (globalEngineRef.current === engine) globalEngineRef.current = null;
    };
  }, [engine]);

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
      <Scene engine={engine} input={inputRef.current} rig={rigRef.current} />
    </Canvas>
  );
}
