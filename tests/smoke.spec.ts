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

  // Movement: store-level lock, hold W for 1s, expect ~1.6 m walked north (-Z).
  await page.evaluate(() => window.__ww!.cmd("lock"));
  const before = (await page.evaluate(() => window.__ww!.query("player"))) as {
    x: number;
    z: number;
  };
  await page.evaluate(() => window.__ww!.press("KeyW", 1000));
  await page.waitForTimeout(1300);
  const after = (await page.evaluate(() => window.__ww!.query("player"))) as {
    x: number;
    z: number;
  };
  expect(before.z - after.z).toBeGreaterThan(0.8);

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
