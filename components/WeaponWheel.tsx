"use client";

import { useHud } from "@/engine/store";
import { WEAPON_NAMES } from "@/engine/engine";

/**
 * Hold Tab: radial weapon wheel. Digits 1-5 equip directly (also without
 * the wheel); the wheel is informational + a reminder of the bindings.
 */
export default function WeaponWheel() {
  const open = useHud((s) => s.wheelOpen);
  const owned = useHud((s) => s.weaponsOwned);
  const equipped = useHud((s) => s.weaponEquipped);

  if (!open) return null;
  const n = WEAPON_NAMES.length;
  return (
    <div className="wheel-backdrop">
      <div className="wheel">
        {WEAPON_NAMES.map((name, i) => {
          const has = (owned & (1 << i)) !== 0;
          const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
          const x = Math.cos(angle) * 110;
          const y = Math.sin(angle) * 110;
          return (
            <div
              key={name}
              className={`wheel-slot${i === equipped ? " active" : ""}${has ? "" : " missing"}`}
              style={{ transform: `translate(${x}px, ${y}px)` }}
            >
              <span className="wheel-key">{i + 1}</span>
              {name}
            </div>
          );
        })}
      </div>
    </div>
  );
}
