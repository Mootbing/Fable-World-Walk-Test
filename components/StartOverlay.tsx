"use client";

import { useHud, LOCK_EVENT } from "@/engine/store";
import { CONFIG } from "@/engine/config";

export default function StartOverlay() {
  const ready = useHud((s) => s.ready);
  const locked = useHud((s) => s.locked);

  if (locked) return null;

  return (
    <div className="overlay">
      <h1>World Walk</h1>
      {ready ? (
        <>
          <p>
            You are standing at {CONFIG.spawnLat.toFixed(4)}, {CONFIG.spawnLon.toFixed(4)} — a
            real place, rebuilt live from satellite imagery, elevation data and building
            footprints.
          </p>
          <button onClick={() => window.dispatchEvent(new Event(LOCK_EVENT))}>
            Click to walk
          </button>
          <div className="keys">WASD move · Shift sprint · mouse look · Esc release</div>
        </>
      ) : (
        <>
          <div className="spinner" />
          <p>Streaming the world in around you…</p>
        </>
      )}
    </div>
  );
}
