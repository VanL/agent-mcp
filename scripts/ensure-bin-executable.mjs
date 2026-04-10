#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { homedir } from "node:os";

const packageRoot = process.cwd();
const distServerPath = resolve(process.cwd(), "dist/server.js");
const providerCliPathsPath = resolve(
  process.cwd(),
  "dist/provider-cli-paths.json",
);
const launcherPath = resolve(process.cwd(), "bin/agent-mcp");
const shouldInstallBinWrapper = process.argv.includes("--install-bin-wrapper");
const positionalArgs = process.argv
  .slice(2)
  .filter((arg) => !arg.startsWith("--"));

const targetPaths = (
  positionalArgs.length > 0 ? positionalArgs : [distServerPath, launcherPath]
).map((target) => resolve(process.cwd(), target));

const providerCliConfigs = [
  {
    id: "claude",
    envVar: "CLAUDE_CLI_NAME",
    defaultCommand: "claude",
    preferredPaths: [resolve(homedir(), ".claude", "local", "claude")],
  },
  {
    id: "codex",
    envVar: "CODEX_CLI_NAME",
    defaultCommand: "codex",
    preferredPaths: [],
  },
  {
    id: "gemini",
    envVar: "GEMINI_CLI_NAME",
    defaultCommand: "gemini",
    preferredPaths: [],
  },
  {
    id: "opencode",
    envVar: "OPENCODE_CLI_NAME",
    defaultCommand: "opencode",
    preferredPaths: [],
  },
  {
    id: "qwen",
    envVar: "QWEN_CLI_NAME",
    defaultCommand: "qwen",
    preferredPaths: [],
  },
];

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function detectPreferredRuntime() {
  if (process.versions.bun) {
    return {
      runtime: "bun",
      absolutePath: process.execPath,
      fallbackOrder: ["bun", "node"],
    };
  }

  const userAgent = (process.env.npm_config_user_agent ?? "").toLowerCase();
  const execPath = (process.env.npm_execpath ?? "").toLowerCase();

  if (userAgent.startsWith("bun/") || execPath.includes("/bun")) {
    return {
      runtime: "bun",
      absolutePath: process.env.npm_execpath ?? "bun",
      fallbackOrder: ["bun", "node"],
    };
  }

  return {
    runtime: "node",
    absolutePath: process.execPath,
    fallbackOrder: ["node", "bun"],
  };
}

function resolveExistingPath(candidatePath) {
  if (!existsSync(candidatePath)) {
    return null;
  }

  try {
    const resolvedPath = realpathSync(candidatePath);
    if (typeof resolvedPath === "string" && resolvedPath.length > 0) {
      return resolvedPath;
    }
  } catch {
    return candidatePath;
  }

  return candidatePath;
}

function findCommandInPath(commandName) {
  if (!commandName || commandName.includes("/") || commandName.includes("\\")) {
    return null;
  }

  const pathEntries = (process.env.PATH ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const pathextEntries =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      : [""];
  const candidateExtensions =
    process.platform === "win32" && !commandName.includes(".")
      ? pathextEntries
      : [""];

  for (const pathEntry of pathEntries) {
    for (const extension of candidateExtensions) {
      const candidatePath = join(pathEntry, `${commandName}${extension}`);
      const resolvedPath = resolveExistingPath(candidatePath);
      if (resolvedPath) {
        return resolvedPath;
      }
    }
  }

  return null;
}

function discoverProviderCliPaths() {
  const discoveredCliPaths = {};

  for (const provider of providerCliConfigs) {
    const configuredCommand = process.env[provider.envVar];
    if (configuredCommand) {
      if (
        configuredCommand.startsWith("./") ||
        configuredCommand.startsWith("../")
      ) {
        continue;
      }

      if (isAbsolute(configuredCommand)) {
        const resolvedConfiguredPath = resolveExistingPath(configuredCommand);
        if (resolvedConfiguredPath) {
          discoveredCliPaths[provider.id] = resolvedConfiguredPath;
          continue;
        }
      }

      const resolvedConfiguredCommand = findCommandInPath(configuredCommand);
      if (resolvedConfiguredCommand) {
        discoveredCliPaths[provider.id] = resolvedConfiguredCommand;
        continue;
      }
    }

    for (const preferredPath of provider.preferredPaths) {
      const resolvedPreferredPath = resolveExistingPath(preferredPath);
      if (resolvedPreferredPath) {
        discoveredCliPaths[provider.id] = resolvedPreferredPath;
        break;
      }
    }

    if (discoveredCliPaths[provider.id]) {
      continue;
    }

    const resolvedCommand = findCommandInPath(provider.defaultCommand);
    if (resolvedCommand) {
      discoveredCliPaths[provider.id] = resolvedCommand;
    }
  }

  mkdirSync(dirname(providerCliPathsPath), { recursive: true });
  writeFileSync(
    providerCliPathsPath,
    `${JSON.stringify(discoveredCliPaths, null, 2)}\n`,
  );
}

function buildLauncherScript(serverJsPath) {
  const { absolutePath, fallbackOrder } = detectPreferredRuntime();
  const lines = [
    "#!/bin/sh",
    "# generated by scripts/ensure-bin-executable.mjs",
    `SERVER_JS=${shellQuote(serverJsPath)}`,
    "",
  ];

  if (absolutePath) {
    lines.push(
      `if [ -x ${shellQuote(absolutePath)} ]; then exec ${shellQuote(absolutePath)} "$SERVER_JS" "$@"; fi`,
      "",
    );
  }

  for (const candidate of fallbackOrder) {
    lines.push(
      `if command -v ${candidate} >/dev/null 2>&1; then exec /usr/bin/env ${candidate} "$SERVER_JS" "$@"; fi`,
      "",
    );
  }

  lines.push(
    `echo "agent-mcp requires ${fallbackOrder.join(" or ")} in PATH" >&2`,
    "exit 127",
    "",
  );

  return lines.join("\n");
}

function isLikelyGlobalInstall() {
  if (process.env.npm_config_global === "true") {
    return true;
  }

  if (process.env.BUN_INSTALL_GLOBAL_DIR) {
    return true;
  }

  return packageRoot.includes(
    `${sep}install${sep}global${sep}node_modules${sep}`,
  );
}

function resolveInstalledNodeModulesBinDir() {
  const nodeModulesSegment = `${sep}node_modules${sep}`;
  const nodeModulesIndex = packageRoot.lastIndexOf(nodeModulesSegment);
  if (nodeModulesIndex === -1) {
    return null;
  }

  const nodeModulesRoot = packageRoot.slice(
    0,
    nodeModulesIndex + nodeModulesSegment.length - 1,
  );
  return resolve(nodeModulesRoot, ".bin");
}

function resolveInstallBinDir() {
  if (process.platform === "win32") {
    return null;
  }

  if (!isLikelyGlobalInstall()) {
    return resolveInstalledNodeModulesBinDir();
  }

  const { runtime, absolutePath } = detectPreferredRuntime();
  if (runtime === "bun") {
    const bunCandidates = [absolutePath, "bun"].filter(Boolean);
    for (const candidate of bunCandidates) {
      try {
        const globalBinDir = execFileSync(candidate, ["pm", "-g", "bin"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        if (globalBinDir) {
          return globalBinDir;
        }
      } catch {
        continue;
      }
    }
  }

  if (process.env.npm_config_prefix) {
    return resolve(process.env.npm_config_prefix, "bin");
  }

  return null;
}

function ensureExecutable(targetPath) {
  if (!existsSync(targetPath)) {
    throw new Error(
      `Cannot mark executable: file does not exist: ${targetPath}`,
    );
  }

  if (process.platform !== "win32") {
    const currentMode = statSync(targetPath).mode;
    chmodSync(targetPath, currentMode | 0o111);
  }
}

function installBinWrapper() {
  const installBinDir = resolveInstallBinDir();
  if (!installBinDir) {
    return;
  }

  const commandPath = resolve(installBinDir, "agent-mcp");
  mkdirSync(dirname(commandPath), { recursive: true });

  if (existsSync(commandPath) && lstatSync(commandPath).isSymbolicLink()) {
    unlinkSync(commandPath);
  }

  writeFileSync(commandPath, buildLauncherScript(distServerPath));
  ensureExecutable(commandPath);
}

discoverProviderCliPaths();

if (shouldInstallBinWrapper) {
  installBinWrapper();
}

for (const targetPath of targetPaths) {
  ensureExecutable(targetPath);
}
