#!/usr/bin/env node

import { chmodSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const targetPath = resolve(process.cwd(), process.argv[2] ?? "dist/server.js");

if (!existsSync(targetPath)) {
  throw new Error(`Cannot mark executable: file does not exist: ${targetPath}`);
}

if (process.platform !== "win32") {
  const currentMode = statSync(targetPath).mode;
  chmodSync(targetPath, currentMode | 0o111);
}
