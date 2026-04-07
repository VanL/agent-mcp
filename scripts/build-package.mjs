#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

const cwd = process.cwd();
const node = process.execPath;
const distDir = resolve(cwd, "dist");
const tscEntrypoint = resolve(cwd, "node_modules/typescript/bin/tsc");
const ensureBinExecutableScript = resolve(
  cwd,
  "scripts/ensure-bin-executable.mjs",
);

rmSync(distDir, { recursive: true, force: true });

const tscResult = spawnSync(
  node,
  [tscEntrypoint, "-p", "tsconfig.build.json"],
  { cwd, stdio: "inherit" },
);

if (tscResult.status !== 0) {
  process.exit(tscResult.status ?? 1);
}

const ensureExecutableResult = spawnSync(node, [ensureBinExecutableScript], {
  cwd,
  stdio: "inherit",
});

if (ensureExecutableResult.status !== 0) {
  process.exit(ensureExecutableResult.status ?? 1);
}
