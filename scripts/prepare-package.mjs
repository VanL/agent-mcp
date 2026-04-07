#!/usr/bin/env node

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { runBuildPackage } from "./build-package.mjs";

const cwd = process.cwd();
const distServerPath = resolve(cwd, "dist/server.js");
const tscEntrypoint = resolve(cwd, "node_modules/typescript/bin/tsc");

if (existsSync(tscEntrypoint)) {
  runBuildPackage();
  process.exit(0);
}

if (existsSync(distServerPath)) {
  process.exit(0);
}

console.error(
  "agent-mcp prepare requires either node_modules/typescript/bin/tsc or a committed dist/server.js",
);
process.exit(1);
