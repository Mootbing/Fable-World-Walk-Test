"use client";

import { useHud } from "@/engine/store";

export default function Hud() {
  const locked = useHud((s) => s.locked);
  const lat = useHud((s) => s.lat);
  const lon = useHud((s) => s.lon);
  const elev = useHud((s) => s.elev);
  const fps = useHud((s) => s.fps);
  const tilesInFlight = useHud((s) => s.tilesInFlight);
  const chunks = useHud((s) => s.chunks);
  const buildingsNote = useHud((s) => s.buildingsNote);
  const simTick = useHud((s) => s.simTick);
  const simMs = useHud((s) => s.simMs);
  const vehicle = useHud((s) => s.vehicle);
  const toast = useHud((s) => s.toast);
  const areaToast = useHud((s) => s.areaToast);
  const clock = useHud((s) => s.clock);
  const health = useHud((s) => s.health);
  const armor = useHud((s) => s.armor);
  const money = useHud((s) => s.money);
  const dead = useHud((s) => s.dead);
  const weapon = useHud((s) => s.weapon);
  const wanted = useHud((s) => s.wanted);
  const busted = useHud((s) => s.busted);
  const mission = useHud((s) => s.mission);
  const missionFlash = useHud((s) => s.missionFlash);

  return (
    <>
      {locked && !vehicle && <div className="crosshair" />}
      {locked && toast && <div className="toast">{toast}</div>}
      {areaToast && (
        <div key={areaToast} className="area-toast">
          {areaToast}
        </div>
      )}
      {locked && <div className="clock">{clock}</div>}
      {locked && <div className="money">{`$${Math.round(money)}`}</div>}
      {locked && weapon && (
        <div className="weapon">
          {weapon.reloading
            ? `${weapon.name} · reloading…`
            : `${weapon.name} · ${weapon.clip}/${weapon.reserve}`}
        </div>
      )}
      {locked && (
        <div className="vitals">
          <div className="bar health">
            <div style={{ width: `${Math.max(0, Math.min(100, health))}%` }} />
          </div>
          <div className="bar armor">
            <div style={{ width: `${Math.max(0, Math.min(100, armor))}%` }} />
          </div>
        </div>
      )}
      {locked && mission && (
        <div className="mission">
          <div className="mission-title">{mission.title}</div>
          <div className="mission-objective">{mission.objective}</div>
        </div>
      )}
      {missionFlash && (
        <div key={missionFlash} className="mission-flash">
          {missionFlash}
        </div>
      )}
      {dead && <div className="wasted">WASTED</div>}
      {busted && <div className="wasted busted">BUSTED</div>}
      {locked && wanted > 0 && (
        <div className="stars">
          {Array.from({ length: 6 }, (_, i) => (
            <span key={i} className={i < wanted ? "star on" : "star"}>
              ★
            </span>
          ))}
        </div>
      )}
      {locked && vehicle && (
        <div className="speedo">
          <span className="speedo-name">{vehicle.name}</span>
          {`${Math.round(vehicle.speedKmh)} km/h`}
        </div>
      )}
      <div className="hud-panel">
        {`${lat.toFixed(5)}, ${lon.toFixed(5)}  ·  ${elev.toFixed(1)} m`}
        {`\n${fps} fps  ·  ${chunks} chunks  ·  ${tilesInFlight} tiles loading`}
        {simTick > 0 && `\nsim #${simTick}  ·  ${simMs.toFixed(2)} ms`}
        {buildingsNote && <span className="hud-warn">{`\n${buildingsNote}`}</span>}
      </div>
      <div className="attribution">
        Imagery: Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community
        <br />
        Buildings: © OpenFreeMap © OpenMapTiles · Data from OpenStreetMap contributors
        <br />
        Terrain: Mapzen/Tilezen via AWS Open Data (USGS, NASA SRTM)
      </div>
    </>
  );
}
