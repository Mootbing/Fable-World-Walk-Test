"use client";

import { useHud, LOCK_EVENT } from "@/engine/store";
import { CONFIG } from "@/engine/config";

const CONTROLS: [string, string][] = [
  ["WASD", "move / drive"],
  ["Shift", "sprint · heli down"],
  ["Space", "jump · handbrake · heli up"],
  ["E", "enter / exit vehicle"],
  ["LMB / RMB", "attack / aim"],
  ["Tab · 1-5 · Q", "weapons"],
  ["R", "reload · radio (in car)"],
  ["T", "taxi / vigilante / paramedic jobs"],
  ["V", "first / third person"],
  ["M", "map · G road debug · H horn"],
];

export default function StartOverlay() {
  const ready = useHud((s) => s.ready);
  const locked = useHud((s) => s.locked);
  const mapOpen = useHud((s) => s.mapOpen);
  const started = useHud((s) => s.started);

  if (locked || mapOpen || started) return null;

  return (
    <div className="overlay">
      <div className="title-card">
        <div className="title-kicker">A real-world open city</div>
        <h1>
          WORLD<span>WALK</span>
        </h1>
        <div className="title-sub">
          {CONFIG.spawnLat.toFixed(4)}, {CONFIG.spawnLon.toFixed(4)} — rebuilt live from
          satellite imagery, elevation data and OpenStreetMap. Drive it, fly it, swim it,
          or just cause trouble in it.
        </div>
      </div>
      {ready ? (
        <>
          <button onClick={() => window.dispatchEvent(new Event(LOCK_EVENT))}>
            Click to play
          </button>
          <div className="title-controls">
            {CONTROLS.map(([key, what]) => (
              <div key={key} className="title-control">
                <span className="title-key">{key}</span>
                <span>{what}</span>
              </div>
            ))}
          </div>
          <div className="title-credits">
            Imagery: Esri · Terrain: Mapzen/AWS · Map data © OpenStreetMap contributors ·
            Sim: Rust → WebAssembly
          </div>
        </>
      ) : (
        <>
          <div className="spinner" />
          <p>Streaming the city in around you…</p>
        </>
      )}
    </div>
  );
}
