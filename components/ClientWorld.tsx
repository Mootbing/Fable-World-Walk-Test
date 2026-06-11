"use client";

import dynamic from "next/dynamic";
import StartOverlay from "./StartOverlay";
import Hud from "./Hud";
import Minimap from "./Minimap";

// All three.js code lives behind this boundary; ssr:false keeps it out of
// the server bundle entirely (and is only legal inside a client component).
const World = dynamic(() => import("./World"), {
  ssr: false,
  loading: () => <div className="boot">Starting engine…</div>,
});

export default function ClientWorld() {
  return (
    <div className="world-root">
      <World />
      <Hud />
      <Minimap />
      <StartOverlay />
    </div>
  );
}
