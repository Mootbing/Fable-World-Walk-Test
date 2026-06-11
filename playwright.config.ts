import { defineConfig } from "@playwright/test";

// NOTE: ports 3000/3001 on this machine can have phantom external listeners
// (WSL2 mirrored networking) — the harness uses its own high port.
const PORT = 4517;

export default defineConfig({
  testDir: "./tests",
  timeout: 120_000,
  fullyParallel: false,
  use: {
    baseURL: `http://localhost:${PORT}`,
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `npx next dev -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { NEXT_PUBLIC_FIXTURE: "1" },
  },
});
