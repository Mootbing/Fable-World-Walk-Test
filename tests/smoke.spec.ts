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
    timeout: 20_000,
  });

  // PR11: pedestrians stroll the sidewalks (sim count + still rendering
  // through 4 instanced pools — covered by the constant-mesh assertion).
  await page.waitForFunction(() => (window.__ww!.query("peds") as number) >= 5, undefined, {
    timeout: 30_000,
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
  await page.waitForTimeout(300);
  const magenta = await page.evaluate(() => {
    const canvas = document.querySelector("canvas.minimap") as HTMLCanvasElement;
    const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    let hits = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 150 && data[i + 2] > 150 && data[i + 1] < 120) hits++;
    }
    return hits;
  });
  expect(magenta).toBeGreaterThan(20);
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
