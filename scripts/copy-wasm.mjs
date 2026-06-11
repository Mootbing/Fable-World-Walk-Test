// Copies the wasm-pack output into public/ so the runtime loads it from a
// stable URL (init({ module_or_path: "/sim_bg.wasm" })) instead of relying
// on bundler handling of wasm imports.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(join(root, "public"), { recursive: true });
copyFileSync(join(root, "sim/pkg/sim_bg.wasm"), join(root, "public/sim_bg.wasm"));
console.log("copied sim/pkg/sim_bg.wasm -> public/sim_bg.wasm");
