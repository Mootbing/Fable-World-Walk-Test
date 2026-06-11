"use client";

import { useEffect, useRef } from "react";
import { engineRef } from "@/engine/engineRef";
import { useHud } from "@/engine/store";
import { ENTITY_STRIDE, ENTITY_TYPE, LANE } from "@/engine/sim/entityLayout";

/**
 * GTA-style radar: real streets from the parsed road tiles, rotating with
 * the camera heading, player chevron centered, blips for nearby entities.
 * Plain 2D canvas on its own ~15 Hz clock — never touches the React render
 * path or the frame loop.
 */

const SIZE = 220;
const R = SIZE / 2 - 6;
/** px per meter on foot / driving (zoomed out). */
const SCALE_FOOT = 1.15;
const SCALE_DRIVE = 0.72;

/** Stroke width by road class (motorway..service). */
const CLASS_WIDTH = [5, 4.5, 4, 3.5, 3, 2.2, 1.2];

export default function Minimap() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ready = useHud((s) => s.ready);

  useEffect(() => {
    if (!ready) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    let scale = SCALE_FOOT;

    const draw = () => {
      const engine = engineRef.current;
      ctx.clearRect(0, 0, SIZE, SIZE);
      if (!engine) return;

      const px = engine.playerX;
      const pz = engine.playerZ;
      const yaw = engine.camYaw;
      const targetScale = engine.driveState ? SCALE_DRIVE : SCALE_FOOT;
      scale += (targetScale - scale) * 0.15;

      const cx = SIZE / 2;
      const cy = SIZE / 2;

      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = "rgba(13, 18, 26, 0.85)";
      ctx.fillRect(0, 0, SIZE, SIZE);

      // World → radar: rotate so the view heading points up.
      ctx.translate(cx, cy);
      ctx.rotate(yaw);
      ctx.scale(scale, scale);
      ctx.translate(-px, -pz);

      const range = (R / scale) * 1.45; // cull margin beyond the disc
      ctx.strokeStyle = "#c8d2dc";
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      for (const tile of engine.roadTiles.values()) {
        const { coords, lineOffsets, lineAttrs } = tile;
        for (let li = 0; li < lineAttrs.length; li++) {
          const v0 = lineOffsets[li];
          const v1 = lineOffsets[li + 1];
          // Quick reject: first point far outside the radar range.
          const fx = coords[v0 * 2];
          const fz = coords[v0 * 2 + 1];
          if (Math.abs(fx - px) > range + 300 || Math.abs(fz - pz) > range + 300) continue;

          const cls = lineAttrs[li] & 0xff;
          ctx.lineWidth = CLASS_WIDTH[Math.min(cls, CLASS_WIDTH.length - 1)] / scale;
          ctx.beginPath();
          ctx.moveTo(fx, fz);
          for (let v = v0 + 1; v < v1; v++) {
            ctx.lineTo(coords[v * 2], coords[v * 2 + 1]);
          }
          ctx.stroke();
        }
      }

      // Entity blips (world space, before unrotating).
      if (engine.sim) {
        const f32 = engine.sim.entityView();
        const u32 = engine.sim.entityViewU32();
        const count = f32.length / ENTITY_STRIDE;
        for (let i = 1; i < count; i++) {
          const base = i * ENTITY_STRIDE;
          const type = u32[base + LANE.typeVariant] >>> 16;
          const ex = f32[base + LANE.posX];
          const ez = f32[base + LANE.posZ];
          if (Math.abs(ex - px) > range || Math.abs(ez - pz) > range) continue;
          if (type === ENTITY_TYPE.vehicle) {
            const kind = (u32[base + LANE.typeVariant] >>> 8) & 0xff;
            ctx.fillStyle = kind === 4 ? "#4f8dff" : "rgba(190,200,210,0.55)";
            const r = (kind === 4 ? 3.4 : 2.4) / scale;
            ctx.beginPath();
            ctx.arc(ex, ez, r, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      // GPS route.
      if (engine.gpsRoute) {
        ctx.strokeStyle = "#d24bd2";
        ctx.lineWidth = 4.5 / scale;
        ctx.beginPath();
        ctx.moveTo(engine.gpsRoute[0], engine.gpsRoute[1]);
        for (let i = 2; i < engine.gpsRoute.length; i += 2) {
          ctx.lineTo(engine.gpsRoute[i], engine.gpsRoute[i + 1]);
        }
        ctx.stroke();
      }

      // Future mission/system blips.
      for (const blip of engine.blips) {
        ctx.fillStyle = blip.color;
        ctx.beginPath();
        ctx.arc(blip.x, blip.z, 4 / scale, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();

      // Player chevron, fixed center pointing up.
      ctx.save();
      ctx.translate(cx, cy);
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.moveTo(0, -7);
      ctx.lineTo(5, 6);
      ctx.lineTo(0, 3);
      ctx.lineTo(-5, 6);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // North marker on the rim.
      const nx = cx + Math.sin(yaw) * (R - 9);
      const ny = cy - Math.cos(yaw) * (R - 9);
      ctx.fillStyle = "#9fb4cc";
      ctx.font = "bold 11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("N", nx, ny);

      // Rim.
      ctx.strokeStyle = "rgba(190,205,220,0.5)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.stroke();
    };

    draw();
    const timer = setInterval(draw, 66);
    return () => clearInterval(timer);
  }, [ready]);

  if (!ready) return null;
  return <canvas ref={canvasRef} className="minimap" width={SIZE} height={SIZE} />;
}
