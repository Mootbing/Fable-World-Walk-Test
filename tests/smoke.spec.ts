import { test, expect } from "@playwright/test";

/**
 * Boot-to-walk smoke in offline fixture mode. Every later PR appends an
 * assertion for its headline feature here (see ROADMAP.md gate).
 */
test("boots from fixtures, sim ticks, player walks", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  await page.goto("/");

  // World becomes ready from committed fixtures alone (no network).
  await page.waitForFunction(() => window.__ww?.ready() === true, undefined, {
    timeout: 90_000,
  });

  // Wasm sim booted and is ticking.
  await page.waitForFunction(() => (window.__ww!.query("simTick") as number) > 0, undefined, {
    timeout: 30_000,
  });
  const t1 = (await page.evaluate(() => window.__ww!.query("simTick"))) as number;
  await page.waitForTimeout(600);
  const t2 = (await page.evaluate(() => window.__ww!.query("simTick"))) as number;
  expect(t2).toBeGreaterThan(t1);

  // Movement: store-level lock, hold W, expect a clear walk north (-Z).
  // Threshold is deliberately loose: under the software renderer the frame
  // rate can dip below 10fps, and the engine's 100ms dt clamp then dilates
  // sim time vs wall clock. Exact speed (1.6 m/s) is pinned by Rust tests.
  await page.evaluate(() => window.__ww!.cmd("lock"));
  const before = (await page.evaluate(() => window.__ww!.query("player"))) as {
    x: number;
    z: number;
  };
  await page.evaluate(() => window.__ww!.press("KeyW", 1500));
  await page.waitForTimeout(1800);
  const after = (await page.evaluate(() => window.__ww!.query("player"))) as {
    x: number;
    z: number;
  };
  expect(before.z - after.z).toBeGreaterThan(0.5);
  expect(Math.abs(after.x - before.x)).toBeLessThan(0.3); // due north, no drift

  // PR3: jump — Space sends the player up ~1m and gravity brings them back;
  // the wasm event ring reports JUMP (1) then LAND (2).
  const y0 = (await page.evaluate(() => (window.__ww!.query("player") as { y: number }).y)) as number;
  await page.evaluate(() => window.__ww!.press("Space", 80));
  await page.waitForFunction(
    (base) => (window.__ww!.query("player") as { y: number }).y > base + 0.4,
    y0,
    { timeout: 3_000 },
  );
  await page.waitForFunction(
    (base) => Math.abs((window.__ww!.query("player") as { y: number }).y - base) < 0.15,
    y0,
    { timeout: 3_000 },
  );
  const eventLog = (await page.evaluate(() => window.__ww!.query("eventLog"))) as number[];
  const types = [];
  for (let i = 0; i < eventLog.length; i += 4) types.push(eventLog[i]);
  expect(types).toContain(1); // JUMP
  expect(types).toContain(2); // LAND

  // PR5: V toggles third person — camera pulls back from the player and the
  // body avatar appears; V again returns to first person.
  await page.evaluate(() => window.__ww!.press("KeyV", 60));
  await page.waitForFunction(() => window.__ww!.query("camMode") === "tp", undefined, {
    timeout: 3_000,
  });
  await page.waitForTimeout(1_000); // boom relaxes out from the body
  const tp = (await page.evaluate(() => ({
    cam: window.__ww!.query("camera"),
    player: window.__ww!.query("player"),
    avatar: window.__ww!.query("avatarVisible"),
  }))) as {
    cam: { x: number; y: number; z: number };
    player: { x: number; y: number; z: number };
    avatar: boolean;
  };
  const camDist = Math.hypot(
    tp.cam.x - tp.player.x,
    tp.cam.y - tp.player.y,
    tp.cam.z - tp.player.z,
  );
  expect(camDist).toBeGreaterThan(1.5);
  expect(tp.avatar).toBe(true);
  await page.screenshot({ path: "test-results/third-person.png" });
  await page.evaluate(() => window.__ww!.press("KeyV", 60));
  await page.waitForFunction(() => window.__ww!.query("camMode") === "fp", undefined, {
    timeout: 3_000,
  });

  // PR6: the starter car — warp beside it, E to enter, drive forward,
  // E to exit. Drive distance is asserted loosely (time dilation, supra).
  const cars = (await page.evaluate(() => window.__ww!.query("vehicles"))) as {
    id: number;
    x: number;
    z: number;
  }[];
  expect(cars.length).toBeGreaterThanOrEqual(1);
  await page.evaluate(
    ([x, z]) => window.__ww!.cmd("warpPlayer", x, z),
    [cars[0].x - 2.2, cars[0].z] as [number, number],
  );
  await page.evaluate(() => window.__ww!.press("KeyE", 120));
  await page.waitForFunction(() => window.__ww!.query("driving") === true, undefined, {
    timeout: 3_000,
  });
  const carBefore = (await page.evaluate(() => window.__ww!.query("player"))) as {
    x: number;
    z: number;
  };
  await page.evaluate(() => window.__ww!.press("KeyW", 2000));
  await page.waitForTimeout(2300);
  const carAfter = (await page.evaluate(() => window.__ww!.query("player"))) as {
    x: number;
    z: number;
  };
  const driven = Math.hypot(carAfter.x - carBefore.x, carAfter.z - carBefore.z);
  expect(driven).toBeGreaterThan(3);
  await page.screenshot({ path: "test-results/driving.png" });
  await page.evaluate(() => window.__ww!.press("KeyE", 120));
  await page.waitForFunction(() => window.__ww!.query("driving") === false, undefined, {
    timeout: 3_000,
  });

  // PR4: building collision lives in the wasm sim — probing west from the
  // spawn plaza must hit a footprint (Times Square's west blockfront) that
  // pushes the circle out, within 250m.
  const hitWall = await page.evaluate(() => {
    for (let t = 5; t <= 250; t += 5) {
      const probe = window.__ww!.cmd("probeCollision", -t, 0) as { moved: boolean } | null;
      if (probe?.moved) return t;
    }
    return 0;
  });
  expect(hitWall).toBeGreaterThan(0);

  // PR7: instanced vehicle pools — spawning a fleet must NOT add scene
  // meshes (constant draw calls), only instances.
  const meshesBefore = ((await page.evaluate(() => window.__ww!.query("render"))) as {
    meshes: number;
  }).meshes;
  await page.evaluate(() => window.__ww!.cmd("spawnRow", 24));
  await page.waitForTimeout(400);
  const fleet = (await page.evaluate(() => ({
    vehicles: (window.__ww!.query("vehicles") as unknown[]).length,
    meshes: (window.__ww!.query("render") as { meshes: number }).meshes,
  }))) as { vehicles: number; meshes: number };
  expect(fleet.vehicles).toBeGreaterThanOrEqual(25); // starter car + 24
  expect(fleet.meshes - meshesBefore).toBeLessThanOrEqual(2);
  await page.screenshot({ path: "test-results/fleet.png" });

  // PR8: the real OSM road graph — midtown Manhattan's z14 tile must yield
  // a dense, well-connected directed graph in the wasm sim.
  const roads = (await page.evaluate(() => window.__ww!.query("roads"))) as {
    edges: number;
    nodes: number;
    connectivity: number;
  };
  expect(roads.edges).toBeGreaterThan(150);
  expect(roads.nodes).toBeGreaterThan(50);
  expect(roads.connectivity).toBeGreaterThan(0.85);
  await page.evaluate(() => window.__ww!.cmd("roadDebug"));
  await page.waitForTimeout(500);
  const overlay = (await page.evaluate(() => window.__ww!.query("roadDebugInfo"))) as {
    visible: boolean;
    vertices: number;
  };
  expect(overlay.visible).toBe(true);
  expect(overlay.vertices).toBeGreaterThan(1000);
  await page.screenshot({ path: "test-results/road-graph.png" });
  await page.evaluate(() => window.__ww!.cmd("roadDebug"));

  // PR9: ambient traffic — AI cars spawn on the real road graph, drive,
  // and never go non-finite. (Counted from the sim; rendered by the same
  // instanced pools the PR7 assertion already covered.)
  await page.waitForFunction(() => (window.__ww!.query("traffic") as number) >= 8, undefined, {
    timeout: 30_000,
  });
  const snap1 = (await page.evaluate(() => window.__ww!.query("vehicles"))) as {
    id: number;
    x: number;
    z: number;
  }[];
  await page.waitForTimeout(3_000);
  const snap2 = (await page.evaluate(() => window.__ww!.query("vehicles"))) as {
    id: number;
    x: number;
    z: number;
  }[];
  const pos1 = new Map(snap1.map((v) => [v.id, v]));
  let moved = 0;
  for (const v of snap2) {
    expect(Number.isFinite(v.x) && Number.isFinite(v.z)).toBe(true);
    const before = pos1.get(v.id);
    if (before && Math.hypot(v.x - before.x, v.z - before.z) > 2) moved++;
  }
  expect(moved).toBeGreaterThan(3);
  await page.screenshot({ path: "test-results/traffic.png" });

  // PR10: intersection arbitration is live — some car brakes for a line or
  // leader within a few seconds of midtown traffic (FLAG_BRAKING lane bit).
  await page.waitForFunction(() => window.__ww!.query("anyBraking") === true, undefined, {
    timeout: 45_000,
  });

  // PR11: pedestrians stroll the sidewalks (sim count + still rendering
  // through 4 instanced pools — covered by the constant-mesh assertion).
  await page.waitForFunction(() => (window.__ww!.query("peds") as number) >= 5, undefined, {
    timeout: 60_000, // late-run time dilation makes sim seconds slow
  });
  await page.screenshot({ path: "test-results/peds.png" });

  // PR12: carjacking — a taxi parked 3m west gets jacked with E (the
  // starter car is 10m away, out of range), then horn scatters.
  await page.evaluate(() => window.__ww!.cmd("warpPlayer", 0, 0));
  await page.evaluate(() => window.__ww!.cmd("spawnTraffic", -3, 0, 3));
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__ww!.press("KeyE", 120));
  await page.waitForFunction(() => window.__ww!.query("driving") === true, undefined, {
    timeout: 3_000,
  });
  await page.evaluate(() => window.__ww!.press("KeyH", 120));
  await page.waitForTimeout(500);
  const log12 = (await page.evaluate(() => window.__ww!.query("eventLog"))) as number[];
  const types12 = [];
  for (let i = 0; i < log12.length; i += 4) types12.push(log12[i]);
  expect(types12).toContain(8); // CARJACK
  expect(types12).toContain(6); // HORN
  await page.evaluate(() => window.__ww!.press("KeyE", 120));
  await page.waitForFunction(() => window.__ww!.query("driving") === false, undefined, {
    timeout: 3_000,
  });

  // PR13: the radar — canvas present and painted with real streets (count
  // road-colored pixels well above the rim/chevron baseline).
  const radarPixels = await page.evaluate(() => {
    const canvas = document.querySelector("canvas.minimap") as HTMLCanvasElement | null;
    if (!canvas) return -1;
    const ctx = canvas.getContext("2d")!;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let lit = 0;
    for (let i = 0; i < data.length; i += 4) {
      // Light street strokes on the dark disc.
      if (data[i] > 150 && data[i + 1] > 150 && data[i + 2] > 150 && data[i + 3] > 100) lit++;
    }
    return lit;
  });
  expect(radarPixels).toBeGreaterThan(800);

  // PR14: GPS — set a waypoint 250m north, get an A* route on the real
  // graph; magenta route renders on the radar; M toggles the full map.
  const routePts = (await page.evaluate(() =>
    window.__ww!.cmd("setWaypoint", 0, -250),
  )) as number;
  expect(routePts).toBeGreaterThan(4);
  // Poll: radar redraws on its own clock, which lags under late-run load.
  await page.waitForFunction(
    () => {
      const canvas = document.querySelector("canvas.minimap") as HTMLCanvasElement | null;
      if (!canvas) return false;
      const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      let hits = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 150 && data[i + 2] > 150 && data[i + 1] < 120) hits++;
      }
      return hits > 20;
    },
    undefined,
    { timeout: 15_000 },
  );
  await page.evaluate(() => window.__ww!.press("KeyM", 80));
  await page.waitForFunction(
    () => (window.__ww!.query("hud") as { mapOpen: boolean }).mapOpen === true,
    undefined,
    { timeout: 3_000 },
  );
  await page.screenshot({ path: "test-results/fullmap.png" });
  await page.evaluate(() => window.__ww!.press("KeyM", 80));
  await page.waitForFunction(
    () => (window.__ww!.query("hud") as { mapOpen: boolean }).mapOpen === false,
    undefined,
    { timeout: 3_000 },
  );
  await page.evaluate(() => window.__ww!.cmd("lock")); // headless: re-lock manually
  await page.evaluate(() => window.__ww!.cmd("clearWaypoint"));

  // PR15: area-name toast resolved from the real place layer + game clock.
  await page.waitForFunction(
    () => ((window.__ww!.query("hud") as { areaToast: string }).areaToast ?? "").length > 0,
    undefined,
    { timeout: 15_000 },
  );
  const hud15 = (await page.evaluate(() => window.__ww!.query("hud"))) as {
    areaToast: string;
    clock: string;
  };
  expect(hud15.clock).toMatch(/^\d{2}:\d{2}$/);

  // PR16: stats — money pickup collects; lethal damage shows WASTED and
  // respawns at spawn minus the hospital fee.
  const stats0 = (await page.evaluate(() => window.__ww!.query("stats"))) as {
    health: number;
    money: number;
  };
  expect(stats0.health).toBe(100);
  const playerNow = (await page.evaluate(() => window.__ww!.query("player"))) as {
    x: number;
    z: number;
  };
  await page.evaluate(
    ([x, z]) => window.__ww!.cmd("spawnPickup", x, z, 2, 60),
    [playerNow.x, playerNow.z] as [number, number],
  );
  await page.waitForFunction(
    (m0) => (window.__ww!.query("stats") as { money: number }).money === m0 + 60,
    stats0.money,
    { timeout: 5_000 },
  );
  await page.evaluate(() => window.__ww!.cmd("damage", 250));
  await page.waitForFunction(
    () => (window.__ww!.query("stats") as { dead: boolean }).dead === true,
    undefined,
    { timeout: 3_000 },
  );
  await expect(page.locator(".wasted")).toBeVisible();
  await page.screenshot({ path: "test-results/wasted.png" });
  await page.waitForFunction(
    () => (window.__ww!.query("stats") as { dead: boolean }).dead === false,
    undefined,
    { timeout: 15_000 },
  );
  const stats1 = (await page.evaluate(() => window.__ww!.query("stats"))) as {
    health: number;
    money: number;
  };
  expect(stats1.health).toBe(100);
  expect(stats1.money).toBe(stats0.money + 60 - 100);

  // PR17: melee — spawn a ped at arm's length, swing until the kill event
  // fires and the dropped cash lands in the wallet.
  const meleeStart = (await page.evaluate(() => ({
    player: window.__ww!.query("player"),
    money: (window.__ww!.query("stats") as { money: number }).money,
  }))) as { player: { x: number; z: number }; money: number };
  await page.evaluate(
    ([x, z]) => window.__ww!.cmd("spawnPed", x, z - 1.2),
    [meleeStart.player.x, meleeStart.player.z] as [number, number],
  );
  await page.waitForTimeout(200);
  for (let swing = 0; swing < 9; swing++) {
    await page.evaluate(() => window.dispatchEvent(new MouseEvent("mousedown", { button: 0 })));
    await page.waitForTimeout(600);
    await page.evaluate(() => window.dispatchEvent(new MouseEvent("mouseup", { button: 0 })));
    await page.waitForTimeout(800);
    const money = (await page.evaluate(
      () => (window.__ww!.query("stats") as { money: number }).money,
    )) as number;
    if (money > meleeStart.money) break;
  }
  const meleeLog = (await page.evaluate(() => window.__ww!.query("eventLog"))) as number[];
  const meleeTypes = [];
  for (let i = 0; i < meleeLog.length; i += 4) meleeTypes.push(meleeLog[i]);
  expect(meleeTypes).toContain(13); // PED_KILLED
  const moneyAfterMelee = (await page.evaluate(
    () => (window.__ww!.query("stats") as { money: number }).money,
  )) as number;
  expect(moneyAfterMelee).toBeGreaterThan(meleeStart.money);

  // PR18: the pistol — grab the starter iron, aim+fire at a spawned ped,
  // expect gunshots in the ring and the clip to drain.
  await page.evaluate(() => window.__ww!.cmd("warpPlayer", -7, 0));
  await page.waitForFunction(
    () => (window.__ww!.query("weapon") as { equipped: number } | null)?.equipped === 2,
    undefined,
    { timeout: 5_000 },
  );
  await page.evaluate(() => window.__ww!.cmd("spawnPed", -7, -6));
  await page.waitForTimeout(200);
  // Count-driven firing: synthetic presses drop at degraded fps (the
  // mechanism itself is pinned by cargo tests + isolated probes), so keep
  // squeezing until two shots register.
  let gunshots = 0;
  for (let attempt = 0; attempt < 8 && gunshots < 2; attempt++) {
    await page.evaluate(() => {
      window.dispatchEvent(new MouseEvent("mousedown", { button: 2 }));
      window.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));
    });
    await page.waitForTimeout(900);
    await page.evaluate(() => {
      window.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));
      window.dispatchEvent(new MouseEvent("mouseup", { button: 2 }));
    });
    await page.waitForTimeout(500);
    gunshots = (await page.evaluate(() => {
      const log = window.__ww!.query("eventLog") as number[];
      let c = 0;
      for (let i = 0; i < log.length; i += 4) if (log[i] === 14) c++;
      return c;
    })) as number;
  }
  expect(gunshots).toBeGreaterThanOrEqual(2);
  const weaponAfter = (await page.evaluate(() => window.__ww!.query("weapon"))) as {
    clip: number;
  };
  expect(weaponAfter.clip).toBeLessThan(12);

  // PR19: arsenal — SMG auto-fire drains the clip on a single long hold;
  // one shotgun blast emits a pellet fan of gunshot events.
  await page.evaluate(() => window.__ww!.cmd("giveWeapon", 3, 60)); // SMG
  for (let attempt = 0; attempt < 6; attempt++) {
    await page.evaluate(() => {
      window.dispatchEvent(new MouseEvent("mousedown", { button: 2 }));
      window.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));
    });
    await page.waitForTimeout(1200);
    await page.evaluate(() => {
      window.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));
      window.dispatchEvent(new MouseEvent("mouseup", { button: 2 }));
    });
    await page.waitForTimeout(500);
    const clip = (await page.evaluate(
      () => (window.__ww!.query("weapon") as { clip: number })?.clip ?? 99,
    )) as number;
    if (clip <= 24) break;
  }
  const smgClip = (await page.evaluate(
    () => (window.__ww!.query("weapon") as { clip: number })?.clip ?? 99,
  )) as number;
  expect(smgClip).toBeLessThanOrEqual(24);

  const shotsBefore = (await page.evaluate(() => {
    const log = window.__ww!.query("eventLog") as number[];
    let c = 0;
    for (let i = 0; i < log.length; i += 4) if (log[i] === 14) c++;
    return c;
  })) as number;
  await page.evaluate(() => window.__ww!.cmd("giveWeapon", 4, 18)); // shotgun
  let pelletFan = 0;
  for (let attempt = 0; attempt < 6 && pelletFan < shotsBefore + 6; attempt++) {
    await page.evaluate(() => {
      window.dispatchEvent(new MouseEvent("mousedown", { button: 2 }));
      window.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));
    });
    await page.waitForTimeout(900);
    await page.evaluate(() => {
      window.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));
      window.dispatchEvent(new MouseEvent("mouseup", { button: 2 }));
    });
    await page.waitForTimeout(600);
    pelletFan = (await page.evaluate(() => {
      const log = window.__ww!.query("eventLog") as number[];
      let c = 0;
      for (let i = 0; i < log.length; i += 4) if (log[i] === 14) c++;
      return c;
    })) as number;
  }
  expect(pelletFan).toBeGreaterThanOrEqual(shotsBefore + 6); // 8-pellet fan
  await page.evaluate(() => window.__ww!.cmd("equip", 0)); // fists away

  // PR20: shoot a parked car until it detonates (EV_EXPLOSION in the ring).
  const p20 = (await page.evaluate(() => window.__ww!.query("player"))) as {
    x: number;
    z: number;
  };
  await page.evaluate(
    ([x, z]) => window.__ww!.cmd("spawnTraffic", x, z - 8, 0),
    [p20.x, p20.z] as [number, number],
  );
  await page.evaluate(() => window.__ww!.cmd("giveWeapon", 3, 240)); // ammo refill
  await page.evaluate(() => window.__ww!.cmd("equip", 3)); // …and back in hand
  let booms = 0;
  for (let attempt = 0; attempt < 8 && booms === 0; attempt++) {
    await page.evaluate(() => {
      window.dispatchEvent(new MouseEvent("mousedown", { button: 2 }));
      window.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));
    });
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
      window.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));
      window.dispatchEvent(new MouseEvent("mouseup", { button: 2 }));
    });
    await page.waitForTimeout(500);
    booms = (await page.evaluate(() => {
      const log = window.__ww!.query("eventLog") as number[];
      let c = 0;
      for (let i = 0; i < log.length; i += 4) if (log[i] === 17) c++;
      return c;
    })) as number;
  }
  expect(booms).toBeGreaterThanOrEqual(1);
  await page.screenshot({ path: "test-results/explosion.png" });
  await page.evaluate(() => window.__ww!.cmd("equip", 0));

  // PR21: wanted — heat raises stars, cops spawn (uniformed peds), and
  // teleporting out of sight clears everything.
  await page.evaluate(() => window.__ww!.cmd("heat", 12));
  await page.waitForFunction(() => (window.__ww!.query("wanted") as number) >= 1, undefined, {
    timeout: 5_000,
  });
  await page.waitForFunction(() => (window.__ww!.query("cops") as number) >= 1, undefined, {
    timeout: 20_000, // force maintenance runs every 1.5 sim-seconds
  });
  await page.screenshot({ path: "test-results/wanted.png" });
  await page.evaluate(() => window.__ww!.cmd("warpPlayer", 500, 500));
  // Out of every cop's sight the evasion clock starts — unless the cops
  // already busted us while we stood in their grab during the cop-wait
  // (also a valid police outcome; the full state machine is cargo-pinned).
  await page.waitForFunction(
    () =>
      window.__ww!.query("evading") === true ||
      (window.__ww!.query("wanted") as number) === 0,
    undefined,
    { timeout: 20_000 },
  );
  await page.evaluate(() => window.__ww!.cmd("warpPlayer", 0, 0));

  // PR22: real POIs streamed into the sim — midtown's tile carries dozens
  // of hospitals + precincts (death/busted respawn anchors).
  await page.waitForFunction(() => (window.__ww!.query("pois") as number) >= 10, undefined, {
    timeout: 10_000,
  });

  // PR23: save/load — snapshot state, trash it, restore it.
  await page.evaluate(() => window.__ww!.cmd("warpPlayer", -20, -20));
  await page.waitForTimeout(300);
  const preSave = (await page.evaluate(() => ({
    stats: window.__ww!.query("stats"),
    player: window.__ww!.query("player"),
  }))) as { stats: { money: number; health: number }; player: { x: number; z: number } };
  expect(await page.evaluate(() => window.__ww!.cmd("save", 1))).toBe(true);
  await page.evaluate(() => window.__ww!.cmd("warpPlayer", 150, 150));
  await page.evaluate(() => window.__ww!.cmd("damage", 40));
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__ww!.cmd("load", 1))).toBe(true);
  await page.waitForTimeout(400);
  const postLoad = (await page.evaluate(() => ({
    stats: window.__ww!.query("stats"),
    player: window.__ww!.query("player"),
  }))) as { stats: { money: number; health: number }; player: { x: number; z: number } };
  expect(Math.abs(postLoad.player.x - preSave.player.x)).toBeLessThan(1);
  expect(Math.abs(postLoad.player.z - preSave.player.z)).toBeLessThan(1);
  expect(postLoad.stats.money).toBe(preSave.stats.money);
  expect(postLoad.stats.health).toBeGreaterThanOrEqual(preSave.stats.health - 1);

  // Pause menu appears when unlocked (post-start).
  await page.evaluate(() => window.__ww!.cmd("unlock"));
  await expect(page.locator(".pause-menu")).toBeVisible();
  await page.screenshot({ path: "test-results/pause.png" });
  await page.evaluate(() => window.__ww!.cmd("lock"));

  // PR24: mission M01 end-to-end — corner, marked taxi, delivery, heat.
  expect(await page.evaluate(() => window.__ww!.cmd("startMission", "m01"))).toBe(true);
  await page.evaluate(() => window.__ww!.cmd("warpPlayer", 2, -40));
  await page.waitForFunction(
    () => (window.__ww!.query("mission") as { step: number }).step >= 1,
    undefined,
    { timeout: 8_000 },
  );
  await page.evaluate(() => window.__ww!.cmd("warpPlayer", 8.2, -45));
  await page.evaluate(() => window.__ww!.press("KeyE", 200));
  await page.waitForFunction(
    () => (window.__ww!.query("mission") as { step: number }).step >= 2,
    undefined,
    { timeout: 8_000 },
  );
  // Drive north until the drop completes (count-driven, dilation-proof).
  for (let leg = 0; leg < 16; leg++) {
    const m = (await page.evaluate(() => window.__ww!.query("mission"))) as { step: number };
    if (m.step >= 3) break;
    await page.evaluate(() => window.__ww!.press("KeyW", 2000));
    await page.waitForTimeout(2300);
  }
  await page.waitForFunction(
    () => (window.__ww!.query("mission") as { step: number }).step >= 3,
    undefined,
    { timeout: 5_000 },
  );
  const moneyBeforeReward = (await page.evaluate(
    () => (window.__ww!.query("stats") as { money: number }).money,
  )) as number;
  await page.evaluate(() => window.__ww!.cmd("clearWanted"));
  await page.waitForFunction(
    () => ((window.__ww!.query("mission") as { flash: string }).flash ?? "").includes("PASSED"),
    undefined,
    { timeout: 8_000 },
  );
  const moneyAfterReward = (await page.evaluate(
    () => (window.__ww!.query("stats") as { money: number }).money,
  )) as number;
  expect(moneyAfterReward).toBe(moneyBeforeReward + 500);
  await page.screenshot({ path: "test-results/mission-passed.png" });
  // step out of the delivery car for later blocks
  await page.evaluate(() => window.__ww!.press("KeyE", 200));
  await page.waitForFunction(() => window.__ww!.query("driving") === false, undefined, {
    timeout: 5_000,
  });

  // PR25: M02 assassination — find the mark, drop him, vanish.
  expect(await page.evaluate(() => window.__ww!.cmd("startMission", "m02"))).toBe(true);
  await page.evaluate(() => window.__ww!.cmd("warpPlayer", -20, -47));
  await page.waitForFunction(
    () => (window.__ww!.query("mission") as { step: number }).step >= 1,
    undefined,
    { timeout: 8_000 },
  );
  await page.evaluate(() => window.__ww!.cmd("giveWeapon", 2, 36)); // pistol refill
  await page.evaluate(() => window.__ww!.cmd("equip", 2));
  await page.evaluate(() => window.__ww!.cmd("warpPlayer", -20, -52)); // 3m north of the mark
  for (let shot = 0; shot < 8; shot++) {
    const m = (await page.evaluate(() => window.__ww!.query("mission"))) as { step: number };
    if (m.step >= 2) break;
    await page.evaluate(() => {
      window.dispatchEvent(new MouseEvent("mousedown", { button: 2 }));
      window.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));
    });
    await page.waitForTimeout(700);
    await page.evaluate(() => {
      window.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));
      window.dispatchEvent(new MouseEvent("mouseup", { button: 2 }));
    });
    await page.waitForTimeout(700);
  }
  await page.waitForFunction(
    () => (window.__ww!.query("mission") as { step: number }).step >= 2,
    undefined,
    { timeout: 5_000 },
  );
  const m02Money = (await page.evaluate(
    () => (window.__ww!.query("stats") as { money: number }).money,
  )) as number;
  await page.evaluate(() => window.__ww!.cmd("clearWanted"));
  await page.waitForFunction(
    () => ((window.__ww!.query("mission") as { flash: string }).flash ?? "").includes("PASSED"),
    undefined,
    { timeout: 8_000 },
  );
  expect(
    (await page.evaluate(() => (window.__ww!.query("stats") as { money: number }).money)) as number,
  ).toBe(m02Money + 750);

  // PR26: side activities — taxi fares and vigilante bounties arm and
  // cancel correctly from the right vehicles.
  const p26 = (await page.evaluate(() => window.__ww!.query("player"))) as {
    x: number;
    z: number;
  };
  await page.evaluate(
    ([x, z]) => window.__ww!.cmd("spawnTraffic", x + 2.2, z, 3), // taxi
    [p26.x, p26.z] as [number, number],
  );
  await page.evaluate(() => window.__ww!.press("KeyE", 250));
  await page.waitForFunction(() => window.__ww!.query("driving") === true, undefined, {
    timeout: 5_000,
  });
  const taxiAct = (await page.evaluate(() => window.__ww!.cmd("toggleActivity"))) as string;
  expect(taxiAct).toBe("taxi");
  const fare = (await page.evaluate(() => window.__ww!.query("activity"))) as {
    stage: string;
    target: { x: number; z: number };
  };
  expect(fare.stage).toBe("pickup");
  expect(Math.hypot(fare.target.x - p26.x, fare.target.z - p26.z)).toBeGreaterThan(30);
  await page.evaluate(() => window.__ww!.cmd("toggleActivity")); // cancel
  expect(await page.evaluate(() => window.__ww!.query("activity"))).toBe(null);
  await page.evaluate(() => window.__ww!.press("KeyE", 250)); // out of the cab
  await page.waitForFunction(() => window.__ww!.query("driving") === false, undefined, {
    timeout: 5_000,
  });

  // Step clear of the taxi so E can't re-grab it, then bring in a cruiser.
  await page.evaluate(
    ([x, z]) => window.__ww!.cmd("warpPlayer", x, z),
    [p26.x - 40, p26.z] as [number, number],
  );
  await page.evaluate(
    ([x, z]) => window.__ww!.cmd("spawnTraffic", x - 38, z, 4), // cruiser
    [p26.x, p26.z] as [number, number],
  );
  await page.evaluate(() => window.__ww!.press("KeyE", 250));
  await page.waitForFunction(() => window.__ww!.query("driving") === true, undefined, {
    timeout: 5_000,
  });
  const vigAct = (await page.evaluate(() => window.__ww!.cmd("toggleActivity"))) as string;
  expect(vigAct).toBe("vigilante");
  const bounty = (await page.evaluate(() => window.__ww!.query("activity"))) as {
    targetId: number;
  };
  expect(bounty.targetId).toBeGreaterThan(0);
  await page.evaluate(() => window.__ww!.cmd("toggleActivity"));
  await page.evaluate(() => window.__ww!.press("KeyE", 250));
  await page.waitForFunction(() => window.__ww!.query("driving") === false, undefined, {
    timeout: 5_000,
  });

  // PR27: shops — pay'n'spray clears wanted + repairs for $100; hardware
  // stores sell weapons via Digit keys; lifetime counters tick.
  await page.evaluate(() => window.__ww!.cmd("giveMoney", 3000));
  const m27 = (await page.evaluate(
    () => (window.__ww!.query("stats") as { money: number }).money,
  )) as number;
  const p27 = (await page.evaluate(() => window.__ww!.query("player"))) as {
    x: number;
    z: number;
  };
  await page.evaluate(
    ([x, z]) => window.__ww!.cmd("spawnTraffic", x + 2.2, z, 0),
    [p27.x, p27.z] as [number, number],
  );
  await page.evaluate(() => window.__ww!.press("KeyE", 250));
  await page.waitForFunction(() => window.__ww!.query("driving") === true, undefined, {
    timeout: 5_000,
  });
  await page.evaluate(() => window.__ww!.cmd("heat", 50)); // 2 stars
  await page.evaluate(
    ([x, z]) => window.__ww!.cmd("spawnPoi", 2, x, z), // spray bay on the car
    [p27.x, p27.z] as [number, number],
  );
  await page.waitForFunction(
    (m) =>
      (window.__ww!.query("wanted") as number) === 0 &&
      (window.__ww!.query("stats") as { money: number }).money === m - 100,
    m27,
    { timeout: 10_000 },
  );
  await page.evaluate(() => window.__ww!.press("KeyE", 250));
  await page.waitForFunction(() => window.__ww!.query("driving") === false, undefined, {
    timeout: 5_000,
  });

  // Hardware store: menu opens in range on foot, Digit2 buys the pistol.
  await page.evaluate(
    ([x, z]) => window.__ww!.cmd("warpPlayer", x, z),
    [p27.x + 60, p27.z] as [number, number],
  );
  await page.evaluate(
    ([x, z]) => window.__ww!.cmd("spawnPoi", 3, x, z),
    [p27.x + 60, p27.z] as [number, number],
  );
  await page.waitForFunction(
    () => (window.__ww!.query("shop") as { open: boolean }).open === true,
    undefined,
    { timeout: 5_000 },
  );
  const mShop = (await page.evaluate(
    () => (window.__ww!.query("stats") as { money: number }).money,
  )) as number;
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.__ww!.press("Digit2", 900));
    await page.waitForTimeout(300);
    const m = (await page.evaluate(
      () => (window.__ww!.query("stats") as { money: number }).money,
    )) as number;
    if (m === mShop - 400) break;
  }
  expect(
    await page.evaluate(() => (window.__ww!.query("stats") as { money: number }).money),
  ).toBe(mShop - 400);
  await page.evaluate(
    ([x, z]) => window.__ww!.cmd("warpPlayer", x, z),
    [p27.x + 140, p27.z] as [number, number],
  );
  await page.waitForFunction(
    () => (window.__ww!.query("shop") as { open: boolean }).open === false,
    undefined,
    { timeout: 5_000 },
  );
  // Odometer: walking moves the on-foot counter (delta-based — most of
  // the suite warps or drives, and save/load rolls counters back).
  let counters = (await page.evaluate(() => window.__ww!.query("counters"))) as number[];
  const w0 = counters[0];
  for (let i = 0; i < 5 && counters[0] <= w0 + 1; i++) {
    await page.evaluate(() => window.__ww!.press("KeyW", 1200));
    counters = (await page.evaluate(() => window.__ww!.query("counters"))) as number[];
  }
  expect(counters[0]).toBeGreaterThan(w0 + 1);
  expect(counters[1]).toBeGreaterThan(10); // m driven (missions, activities)
  expect(counters[3]).toBeGreaterThanOrEqual(1); // cars jacked

  // PR28: hidden packages seed deterministically on road tiles; walking
  // onto one collects it. Ambulance activity arms from a van.
  const pk28 = (await page.evaluate(() => window.__ww!.query("packages"))) as {
    found: number;
    spawned: number;
    nearest: number[];
  };
  expect(pk28.spawned).toBeGreaterThanOrEqual(8);
  expect(pk28.nearest.length).toBe(2);
  await page.evaluate(
    ([x, z]) => window.__ww!.cmd("warpPlayer", x, z),
    [pk28.nearest[0], pk28.nearest[1]] as [number, number],
  );
  await page.waitForFunction(
    (n) => (window.__ww!.query("packages") as { found: number }).found === n + 1,
    pk28.found,
    { timeout: 8_000 },
  );

  const p28 = (await page.evaluate(() => window.__ww!.query("player"))) as {
    x: number;
    z: number;
  };
  await page.evaluate(
    ([x, z]) => window.__ww!.cmd("spawnTraffic", x + 2.2, z, 2), // the van moonlights
    [p28.x, p28.z] as [number, number],
  );
  await page.evaluate(() => window.__ww!.press("KeyE", 250));
  await page.waitForFunction(() => window.__ww!.query("driving") === true, undefined, {
    timeout: 5_000,
  });
  const ambAct = (await page.evaluate(() => window.__ww!.cmd("toggleActivity"))) as string;
  expect(ambAct).toBe("ambulance");
  const amb = (await page.evaluate(() => window.__ww!.query("activity"))) as {
    stage: string;
    target: { x: number; z: number };
  };
  expect(amb.stage).toBe("pickup");
  expect(Math.hypot(amb.target.x - p28.x, amb.target.z - p28.z)).toBeGreaterThan(30);
  await page.evaluate(() => window.__ww!.cmd("toggleActivity"));
  expect(await page.evaluate(() => window.__ww!.query("activity"))).toBe(null);
  await page.evaluate(() => window.__ww!.press("KeyE", 250));
  await page.waitForFunction(() => window.__ww!.query("driving") === false, undefined, {
    timeout: 5_000,
  });

  // PR29: day/night — the clock drives daylight, lamps, window glow.
  await page.evaluate(() => window.__ww!.cmd("setClock", 12 * 60)); // noon
  await page.waitForFunction(
    () => {
      const d = window.__ww!.query("daylight") as { factor: number; lamps: number };
      return d.factor > 0.85 && d.lamps === 0;
    },
    undefined,
    { timeout: 5_000 },
  );
  await page.evaluate(() => window.__ww!.cmd("setClock", 60)); // 01:00
  await page.waitForFunction(
    () => {
      const d = window.__ww!.query("daylight") as {
        factor: number;
        lamps: number;
        windowOpacity: number;
      };
      return d.factor < 0.15 && d.lamps > 0 && d.windowOpacity > 0.4;
    },
    undefined,
    { timeout: 5_000 },
  );
  await page.screenshot({ path: "test-results/night.png" });
  await page.evaluate(() => window.__ww!.cmd("setClock", 12 * 60)); // back to noon

  // PR30: weather — rain drops grip and visibility, particles fall.
  await page.evaluate(() => window.__ww!.cmd("setWeather", 2)); // rain
  await page.waitForFunction(
    () => {
      const w = window.__ww!.query("weather") as {
        state: number;
        grip: number;
        fogScale: number;
        drops: number;
      };
      return w.state === 2 && w.grip < 0.6 && w.fogScale < 0.5 && w.drops > 100;
    },
    undefined,
    { timeout: 5_000 },
  );
  await page.evaluate(() => window.__ww!.cmd("setWeather", 0)); // clear up
  await page.waitForFunction(
    () => {
      const w = window.__ww!.query("weather") as { state: number; grip: number; drops: number };
      return w.state === 0 && w.grip === 1 && w.drops === 0;
    },
    undefined,
    { timeout: 5_000 },
  );

  // PR31: audio — context unlocks on pointer lock, sim events schedule
  // voices (count grows even if headless keeps the context suspended).
  const au0 = (await page.evaluate(() => window.__ww!.query("audio"))) as {
    unlocked: boolean;
    voices: number;
    state: string;
  };
  expect(au0.unlocked).toBe(true);
  expect(au0.voices).toBeGreaterThan(0); // the whole suite has been noisy
  const p31 = (await page.evaluate(() => window.__ww!.query("player"))) as {
    x: number;
    z: number;
  };
  await page.evaluate(
    ([x, z]) => window.__ww!.cmd("spawnPickup", x, z, 0, 10), // health chime
    [p31.x, p31.z] as [number, number],
  );
  await page.waitForFunction(
    (v) => (window.__ww!.query("audio") as { voices: number }).voices > v,
    au0.voices,
    { timeout: 8_000 },
  );

  // PR32: radio — R cycles stations in a car, program persists, off on 4th.
  const p32 = (await page.evaluate(() => window.__ww!.query("player"))) as {
    x: number;
    z: number;
  };
  await page.evaluate(
    ([x, z]) => window.__ww!.cmd("warpPlayer", x, z),
    [p32.x + 55, p32.z] as [number, number],
  );
  await page.evaluate(
    ([x, z]) => window.__ww!.cmd("spawnTraffic", x + 57.2, z, 0),
    [p32.x, p32.z] as [number, number],
  );
  await page.evaluate(() => window.__ww!.press("KeyE", 250));
  await page.waitForFunction(() => window.__ww!.query("driving") === true, undefined, {
    timeout: 5_000,
  });
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.__ww!.press("KeyR", 600));
    const r = (await page.evaluate(() => window.__ww!.query("radio"))) as { station: number };
    if (r.station === 1) break;
  }
  const r32 = (await page.evaluate(() => window.__ww!.query("radio"))) as {
    station: number;
    name: string;
  };
  expect(r32.station).toBe(1);
  expect(r32.name).toBe("Nightdrive FM");
  expect(await page.evaluate(() => window.__ww!.cmd("radio"))).toBe(2);
  expect(await page.evaluate(() => window.__ww!.cmd("radio"))).toBe(3);
  expect(await page.evaluate(() => window.__ww!.cmd("radio"))).toBe(0);
  await page.evaluate(() => window.__ww!.press("KeyE", 250));
  await page.waitForFunction(() => window.__ww!.query("driving") === false, undefined, {
    timeout: 5_000,
  });

  // PR33: character pass — dressed peds render through all six pools.
  const p33 = (await page.evaluate(() => window.__ww!.query("player"))) as {
    x: number;
    z: number;
  };
  for (const off of [3, 4.5, 6]) {
    await page.evaluate(
      ([x, z]) => window.__ww!.cmd("spawnPed", x, z),
      [p33.x + off, p33.z - 4] as [number, number],
    );
  }
  await page.waitForFunction(
    () => (window.__ww!.query("pedRender") as number) >= 3,
    undefined,
    { timeout: 5_000 },
  );
  await page.screenshot({ path: "test-results/characters.png" });

  // PR34: motorcycles — the bike leans into corners with the rider aboard.
  const p34 = (await page.evaluate(() => window.__ww!.query("player"))) as {
    x: number;
    z: number;
  };
  await page.evaluate(
    ([x, z]) => window.__ww!.cmd("warpPlayer", x, z),
    [p34.x - 45, p34.z] as [number, number],
  );
  await page.evaluate(
    ([x, z]) => window.__ww!.cmd("spawnTraffic", x - 43, z, 6), // the bike
    [p34.x, p34.z] as [number, number],
  );
  await page.evaluate(() => window.__ww!.press("KeyE", 250));
  await page.waitForFunction(() => window.__ww!.query("driving") === true, undefined, {
    timeout: 5_000,
  });
  expect(await page.evaluate(() => window.__ww!.query("drivingKind"))).toBe(6);
  // Throttle + full lock: watch the roll component build.
  let lean34 = 0;
  for (let i = 0; i < 6 && lean34 < 0.06; i++) {
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW", bubbles: true }));
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyA", bubbles: true }));
    });
    await page.waitForTimeout(1000);
    lean34 = Math.abs(
      (await page.evaluate(() => window.__ww!.query("lean"))) as number,
    );
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyW", bubbles: true }));
      window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyA", bubbles: true }));
    });
    await page.waitForTimeout(200);
  }
  expect(lean34).toBeGreaterThan(0.06);
  await page.evaluate(() => window.__ww!.press("KeyE", 250));
  await page.waitForFunction(() => window.__ww!.query("driving") === false, undefined, {
    timeout: 5_000,
  });

  // PR35: water — real Hudson polygons, swimming, and a boat ride.
  const land35 = (await page.evaluate(() => window.__ww!.query("player"))) as {
    x: number;
    z: number;
  };
  const w35 = (await page.evaluate(() => window.__ww!.query("water"))) as {
    polys: number;
    probe: number[];
  };
  expect(w35.polys).toBeGreaterThan(0);
  expect(w35.probe.length).toBe(2);
  await page.evaluate(
    ([x, z]) => window.__ww!.cmd("warpPlayer", x, z),
    [w35.probe[0], w35.probe[1]] as [number, number],
  );
  await page.waitForFunction(() => window.__ww!.query("swim") === true, undefined, {
    timeout: 8_000,
  });
  const boat35 = (await page.evaluate(
    ([x, z]) => window.__ww!.cmd("spawnBoat", x + 2.0, z),
    [w35.probe[0], w35.probe[1]] as [number, number],
  )) as number;
  expect(boat35).toBeGreaterThan(0);
  await page.evaluate(() => window.__ww!.press("KeyE", 250));
  await page.waitForFunction(() => window.__ww!.query("driving") === true, undefined, {
    timeout: 5_000,
  });
  expect(await page.evaluate(() => window.__ww!.query("drivingKind"))).toBe(7);
  const aboard = (await page.evaluate(() => window.__ww!.query("player"))) as {
    x: number;
    z: number;
  };
  let sailed = 0;
  for (let i = 0; i < 6 && sailed < 5; i++) {
    await page.evaluate(() =>
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW", bubbles: true })),
    );
    await page.waitForTimeout(1200);
    await page.evaluate(() =>
      window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyW", bubbles: true })),
    );
    const p = (await page.evaluate(() => window.__ww!.query("player"))) as {
      x: number;
      z: number;
    };
    sailed = Math.hypot(p.x - aboard.x, p.z - aboard.z);
  }
  expect(sailed).toBeGreaterThan(5);
  await page.evaluate(() => window.__ww!.press("KeyE", 250));
  await page.waitForFunction(() => window.__ww!.query("driving") === false, undefined, {
    timeout: 5_000,
  });
  await page.screenshot({ path: "test-results/water.png" });
  await page.evaluate(
    ([x, z]) => window.__ww!.cmd("warpPlayer", x, z),
    [land35.x, land35.z] as [number, number],
  );
  await page.waitForFunction(() => window.__ww!.query("swim") === false, undefined, {
    timeout: 8_000,
  });

  // PR36: helicopters — collective climbs, lands, and 5 stars scrambles
  // the air unit.
  const p36 = (await page.evaluate(() => window.__ww!.query("player"))) as {
    x: number;
    z: number;
    y: number;
  };
  await page.evaluate(
    ([x, z]) => window.__ww!.cmd("warpPlayer", x, z),
    [p36.x + 70, p36.z] as [number, number],
  );
  await page.evaluate(
    ([x, z]) => window.__ww!.cmd("spawnTraffic", x + 72.2, z, 8),
    [p36.x, p36.z] as [number, number],
  );
  await page.evaluate(() => window.__ww!.press("KeyE", 250));
  await page.waitForFunction(() => window.__ww!.query("driving") === true, undefined, {
    timeout: 5_000,
  });
  expect(await page.evaluate(() => window.__ww!.query("drivingKind"))).toBe(8);
  const ground36 = ((await page.evaluate(() => window.__ww!.query("player"))) as { y: number })
    .y;
  let climbed = 0;
  for (let i = 0; i < 6 && climbed < 6; i++) {
    await page.evaluate(() =>
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", bubbles: true })),
    );
    await page.waitForTimeout(1100);
    await page.evaluate(() =>
      window.dispatchEvent(new KeyboardEvent("keyup", { code: "Space", bubbles: true })),
    );
    climbed =
      ((await page.evaluate(() => window.__ww!.query("player"))) as { y: number }).y - ground36;
  }
  expect(climbed).toBeGreaterThan(6);
  await page.screenshot({ path: "test-results/heli.png" });
  // Air support at 5 stars while we hover.
  await page.evaluate(() => window.__ww!.cmd("heat", 260));
  await page.waitForFunction(
    () =>
      (window.__ww!.query("wanted") as number) >= 5 &&
      (window.__ww!.query("policeHeli") as boolean) === true,
    undefined,
    { timeout: 8_000 },
  );
  await page.evaluate(() => window.__ww!.cmd("clearWanted"));
  await page.waitForFunction(
    () => (window.__ww!.query("policeHeli") as boolean) === false,
    undefined,
    { timeout: 5_000 },
  );
  // Set it down and step off.
  let down36 = climbed;
  for (let i = 0; i < 8 && down36 > 2; i++) {
    await page.evaluate(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { code: "ShiftLeft", bubbles: true }),
      ),
    );
    await page.waitForTimeout(1100);
    await page.evaluate(() =>
      window.dispatchEvent(new KeyboardEvent("keyup", { code: "ShiftLeft", bubbles: true })),
    );
    down36 =
      ((await page.evaluate(() => window.__ww!.query("player"))) as { y: number }).y - ground36;
  }
  expect(down36).toBeLessThanOrEqual(2);
  await page.evaluate(() => window.__ww!.press("KeyE", 250));
  await page.waitForFunction(() => window.__ww!.query("driving") === false, undefined, {
    timeout: 5_000,
  });

  // World actually meshed: 9 terrain chunks alone are ~295k triangles, and
  // Times Square building tiles add meshes on top.
  const render = (await page.evaluate(() => window.__ww!.query("render"))) as {
    meshes: number;
    triangles: number;
  };
  expect(render.meshes).toBeGreaterThanOrEqual(9);
  expect(render.triangles).toBeGreaterThan(100_000);

  expect(pageErrors).toEqual([]);

  await page.screenshot({ path: "test-results/smoke.png" });
});
