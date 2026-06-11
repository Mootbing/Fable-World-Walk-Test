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

  return (
    <>
      {locked && <div className="crosshair" />}
      <div className="hud-panel">
        {`${lat.toFixed(5)}, ${lon.toFixed(5)}  ·  ${elev.toFixed(1)} m`}
        {`\n${fps} fps  ·  ${chunks} chunks  ·  ${tilesInFlight} tiles loading`}
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
