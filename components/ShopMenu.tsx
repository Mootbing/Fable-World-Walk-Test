"use client";

import { useHud } from "@/engine/store";
import { SHOP_CATALOG } from "@/game/shops";

/** Hardware-store buy menu; up while standing at a kind-3 POI on foot. */
export default function ShopMenu() {
  const open = useHud((s) => s.shopOpen);
  const money = useHud((s) => s.money);
  if (!open) return null;

  return (
    <div className="shop-menu">
      <h2>HARDWARE &amp; TOOLS</h2>
      <ul>
        {SHOP_CATALOG.map((item, i) => (
          <li key={item.name} className={money < item.price ? "shop-broke" : ""}>
            <span className="shop-key">{i + 1}</span>
            <span className="shop-name">{item.name}</span>
            <span className="shop-price">${item.price}</span>
          </li>
        ))}
      </ul>
      <p>Press 1–5 to buy · walk away to leave</p>
    </div>
  );
}
