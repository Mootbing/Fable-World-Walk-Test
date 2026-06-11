// Runs `playwright test`, augmenting LD_LIBRARY_PATH with locally-extracted
// chromium deps if present (machines without sudo can't `playwright
// install-deps`; see ROADMAP.md environment notes). No-op elsewhere.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const localLibs = join(homedir(), ".local/opt/pw-libs/usr/lib/x86_64-linux-gnu");
const env = { ...process.env };
if (existsSync(localLibs)) {
  env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH
    ? `${localLibs}:${env.LD_LIBRARY_PATH}`
    : localLibs;
}

const result = spawnSync("npx", ["playwright", "test", ...process.argv.slice(2)], {
  stdio: "inherit",
  env,
});
process.exit(result.status ?? 1);
