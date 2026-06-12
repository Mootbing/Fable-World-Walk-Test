"use client";

import { useState } from "react";
import { engineRef } from "@/engine/engineRef";
import { useHud, LOCK_EVENT } from "@/engine/store";
import { saveGame, loadGame, listSaves, SaveMeta } from "@/engine/save";
import { getSettings, updateSettings } from "@/engine/settings";
import { MISSIONS } from "@/game/missions";

/**
 * Esc pauses (pointer unlock); this menu replaces the start overlay once
 * the game has started. Resume re-locks via the same LOCK_EVENT path.
 */
export default function PauseMenu() {
  const ready = useHud((s) => s.ready);
  const locked = useHud((s) => s.locked);
  const mapOpen = useHud((s) => s.mapOpen);
  const started = useHud((s) => s.started);
  const [saves, setSaves] = useState<SaveMeta[] | null>(null);
  const [flash, setFlash] = useState("");
  const [settings, setSettings] = useState(getSettings());
  const [statsOpen, setStatsOpen] = useState(false);

  if (!ready || locked || mapOpen || !started) return null;
  const engine = engineRef.current;
  const counters = engine?.sim?.statsCounters() ?? [0, 0, 0, 0, 0];
  const missionsDone = MISSIONS.filter((m) => engine?.missions.isDone(m.id)).length;
  const statRows: [string, string][] = [
    ["Distance on foot", `${(counters[0] / 1000).toFixed(2)} km`],
    ["Distance by car", `${(counters[1] / 1000).toFixed(2)} km`],
    ["Peds put down", String(counters[2])],
    ["Cars jacked", String(counters[3])],
    ["Shots fired", String(counters[4])],
    ["Missions passed", `${missionsDone} / ${MISSIONS.length}`],
    ["Taxi fares", String(engine?.totalFares ?? 0)],
    ["Vigilante bounties", String(engine?.totalBounties ?? 0)],
  ];
  const slots = saves ?? listSaves();

  const doSave = (slot: number) => {
    const ok = engineRef.current && saveGame(engineRef.current, slot);
    setFlash(ok ? `Saved to slot ${slot}` : "Save failed");
    setSaves(listSaves());
  };
  const doLoad = (slot: number) => {
    const ok = engineRef.current && loadGame(engineRef.current, slot);
    setFlash(ok ? `Loaded slot ${slot}` : "Nothing in that slot");
  };

  return (
    <div className="pause-backdrop">
      <div className="pause-menu">
        <h1>PAUSED</h1>
        <button onClick={() => window.dispatchEvent(new Event(LOCK_EVENT))}>Resume</button>
        <div className="pause-slots">
          {[1, 2, 3].map((slot) => {
            const meta = slots.find((s) => s.slot === slot);
            return (
              <div key={slot} className="pause-slot">
                <span>
                  Slot {slot}
                  {meta ? ` · $${meta.money} · ${new Date(meta.savedAt).toLocaleTimeString()}` : " · empty"}
                </span>
                <button onClick={() => doSave(slot)}>Save</button>
                <button onClick={() => doLoad(slot)} disabled={!meta}>
                  Load
                </button>
              </div>
            );
          })}
        </div>
        <div className="pause-settings">
          <label>
            Sensitivity
            <input
              type="range"
              min="0.4"
              max="2.5"
              step="0.1"
              value={settings.sensitivity}
              onChange={(e) => {
                const next = updateSettings({ sensitivity: Number(e.target.value) });
                setSettings(next);
              }}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={settings.invertY}
              onChange={(e) => setSettings(updateSettings({ invertY: e.target.checked }))}
            />
            Invert look
          </label>
        </div>
        <button onClick={() => setStatsOpen(!statsOpen)}>
          {statsOpen ? "Hide stats" : "Stats"}
        </button>
        {statsOpen && (
          <div className="pause-stats">
            {statRows.map(([label, value]) => (
              <div key={label} className="pause-stat-row">
                <span>{label}</span>
                <span>{value}</span>
              </div>
            ))}
          </div>
        )}
        {flash && <div className="pause-flash">{flash}</div>}
        <div className="pause-hint">Esc resumes pointer · M map · Tab weapons</div>
      </div>
    </div>
  );
}
