"use client";

import { useEffect, useRef } from "react";
import { engineRef } from "@/engine/engineRef";
import { useHud } from "@/engine/store";

/**
 * Full-screen pause map (M): pannable/zoomable canvas of the streamed
 * road network; click sets the GPS waypoint. North-up (unlike the radar).
 */

const CLASS_WIDTH = [5, 4.5, 4, 3.5, 3, 2.2, 1.2];

export default function FullMap() {
  const open = useHud((s) => s.mapOpen);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const view = useRef({ x: 0, z: 0, scale: 0.5, panned: false });

  useEffect(() => {
    if (!open) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    const engine = engineRef.current;
    if (!canvas || !ctx || !engine) return;

    const size = Math.min(window.innerWidth, window.innerHeight) * 0.82;
    canvas.width = size;
    canvas.height = size;
    if (!view.current.panned) {
      view.current.x = engine.playerX;
      view.current.z = engine.playerZ;
    }

    const draw = () => {
      const { x: cxw, z: czw, scale } = view.current;
      ctx.fillStyle = "#0c1118";
      ctx.fillRect(0, 0, size, size);
      ctx.save();
      ctx.translate(size / 2, size / 2);
      ctx.scale(scale, scale);
      ctx.translate(-cxw, -czw);

      ctx.strokeStyle = "#aebbc9";
      ctx.lineCap = "round";
      for (const tile of engine.roadTiles.values()) {
        const { coords, lineOffsets, lineAttrs } = tile;
        for (let li = 0; li < lineAttrs.length; li++) {
          const v0 = lineOffsets[li];
          const v1 = lineOffsets[li + 1];
          const cls = lineAttrs[li] & 0xff;
          ctx.lineWidth = CLASS_WIDTH[Math.min(cls, CLASS_WIDTH.length - 1)] / scale;
          ctx.beginPath();
          ctx.moveTo(coords[v0 * 2], coords[v0 * 2 + 1]);
          for (let v = v0 + 1; v < v1; v++) ctx.lineTo(coords[v * 2], coords[v * 2 + 1]);
          ctx.stroke();
        }
      }

      if (engine.gpsRoute) {
        ctx.strokeStyle = "#d24bd2";
        ctx.lineWidth = 5 / scale;
        ctx.beginPath();
        ctx.moveTo(engine.gpsRoute[0], engine.gpsRoute[1]);
        for (let i = 2; i < engine.gpsRoute.length; i += 2) {
          ctx.lineTo(engine.gpsRoute[i], engine.gpsRoute[i + 1]);
        }
        ctx.stroke();
      }

      for (const blip of engine.blips) {
        ctx.fillStyle = blip.color;
        ctx.beginPath();
        ctx.arc(blip.x, blip.z, 7 / scale, 0, Math.PI * 2);
        ctx.fill();
      }

      // Player marker.
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(engine.playerX, engine.playerZ, 6 / scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    };

    draw();
    const timer = setInterval(draw, 120);

    let down: { x: number; y: number } | null = null;
    let dragged = false;
    const toWorld = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const { x, z, scale } = view.current;
      return {
        x: x + (e.clientX - rect.left - size / 2) / scale,
        z: z + (e.clientY - rect.top - size / 2) / scale,
      };
    };
    const onDown = (e: MouseEvent) => {
      down = { x: e.clientX, y: e.clientY };
      dragged = false;
    };
    const onMove = (e: MouseEvent) => {
      if (!down || !(e.buttons & 1)) return;
      const dx = e.clientX - down.x;
      const dy = e.clientY - down.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) dragged = true;
      view.current.x -= dx / view.current.scale;
      view.current.z -= dy / view.current.scale;
      view.current.panned = true;
      down = { x: e.clientX, y: e.clientY };
    };
    const onUp = (e: MouseEvent) => {
      if (down && !dragged) {
        const w = toWorld(e);
        engineRef.current?.setWaypoint(w.x, w.z);
      }
      down = null;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
      view.current.scale = Math.min(4, Math.max(0.08, view.current.scale * factor));
    };
    canvas.addEventListener("mousedown", onDown);
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mouseup", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      clearInterval(timer);
      canvas.removeEventListener("mousedown", onDown);
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mouseup", onUp);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="fullmap-backdrop">
      <canvas ref={canvasRef} className="fullmap" />
      <div className="fullmap-hint">click: set waypoint · drag: pan · scroll: zoom · M: close</div>
    </div>
  );
}
