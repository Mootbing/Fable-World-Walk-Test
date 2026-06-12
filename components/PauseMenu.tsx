"use client";

import { useState } from "react";
import { engineRef } from "@/engine/engineRef";
import { useHud, LOCK_EVENT } from "@/engine/store";
import { saveGame, loadGame, listSaves, SaveMeta } from "@/engine/save";
import { getSettings, updateSettings } from "@/engine/settings";

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

  if (!ready || locked || mapOpen || !started) return null;
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
        {flash && <div className="pause-flash">{flash}</div>}
        <div className="pause-hint">Esc resumes pointer · M map · Tab weapons</div>
      </div>
    </div>
  );
}
