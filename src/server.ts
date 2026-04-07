#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type ServerResult,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve as pathResolve } from "node:path";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

// Server version - update this when releasing new versions
const SERVER_VERSION = "1.10.12";

const debugMode = process.env.MCP_CLAUDE_DEBUG === "true";
let isFirstToolUse = true;
const serverStartupTime = new Date().toISOString();
const executionTimeoutMs = 1800000; // 30 minutes

const workFolderDescription =
  "Mandatory when using file operations or referencing any file. The working directory for the CLI execution. Must be an absolute path.";

const toolArgumentsSchema = z.object({
  prompt: z.string(),
  workFolder: z.string().optional(),
});

type ToolArguments = z.infer<typeof toolArgumentsSchema>;

interface SpawnResult {
  stdout: string;
  stderr: string;
}

interface ProviderInvocation {
  args: string[];
  outputFile?: string;
  cleanupDir?: string;
}

interface AgentProviderConfig {
  id: string;
  toolName: string;
  title: string;
  displayName: string;
  recommendedUse: string;
  cliEnvVar: string;
  defaultCliCommand: string;
  preferredCliPaths?: () => string[];
  preferredCliPathLabel?: string;
  warnWhenFallingBackToPath?: boolean;
  promptDescription: string;
  buildInvocation: (input: {
    prompt: string;
    cwd: string;
  }) => ProviderInvocation;
  extractOutput?: (
    result: SpawnResult,
    invocation: ProviderInvocation,
  ) => string;
}

interface AgentProviderRuntime extends AgentProviderConfig {
  cliCommand: string;
}

type InstalledCliPathMap = Partial<Record<AgentProviderConfig["id"], string>>;

/**
 * Dedicated debug logging function.
 */
export function debugLog(
  message?: unknown,
  ...optionalParams: unknown[]
): void {
  if (debugMode) {
    console.error(message, ...optionalParams);
  }
}

function resolveExistingCliPath(cliPath: string): string | null {
  if (!existsSync(cliPath)) {
    return null;
  }

  try {
    const resolvedPath = realpathSync(cliPath);
    if (typeof resolvedPath === "string" && resolvedPath.length > 0) {
      return resolvedPath;
    }
  } catch {
    return cliPath;
  }

  return cliPath;
}

function findCommandInPath(commandName: string): string | null {
  if (commandName.length === 0) {
    return null;
  }

  if (path.isAbsolute(commandName)) {
    return resolveExistingCliPath(commandName);
  }

  if (commandName.includes("/") || commandName.includes("\\")) {
    return null;
  }

  const pathEntries = (process.env.PATH ?? "")
    .split(path.delimiter)
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
    process.platform === "win32" && path.extname(commandName).length === 0
      ? pathextEntries
      : [""];

  for (const pathEntry of pathEntries) {
    for (const extension of candidateExtensions) {
      const candidatePath = path.join(pathEntry, `${commandName}${extension}`);
      const resolvedPath = resolveExistingCliPath(candidatePath);
      if (resolvedPath) {
        return resolvedPath;
      }
    }
  }

  return null;
}

function loadInstalledCliPaths(): InstalledCliPathMap {
  const cliPathManifestPath = join(
    path.dirname(fileURLToPath(import.meta.url)),
    "provider-cli-paths.json",
  );

  if (!existsSync(cliPathManifestPath)) {
    return {};
  }

  try {
    const manifestContents = readFileSync(cliPathManifestPath, "utf-8");
    const parsed = JSON.parse(manifestContents);

    if (typeof parsed !== "object" || parsed === null) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [AgentProviderConfig["id"], string] =>
          typeof entry[0] === "string" &&
          typeof entry[1] === "string" &&
          entry[1].length > 0,
      ),
    );
  } catch (error) {
    debugLog("[Debug] Failed to load installed provider CLI paths:", error);
    return {};
  }
}

const installedCliPaths = loadInstalledCliPaths();

function buildToolDescription(provider: AgentProviderConfig): string {
  return `${provider.title}: Run ${provider.displayName} non-interactively for code, file, Git, shell, and research tasks. Use \`workFolder\` for contextual execution.

Use this tool when you specifically want ${provider.recommendedUse}.

• File ops: Create, read, edit, move, copy, delete, list, and inspect files
• Code: Generate, explain, refactor, review, and fix code
• Git: Stage, commit, branch, push, inspect diffs, and prepare PRs
• Terminal: Run project commands, tests, linters, and build steps
• Web: Search or inspect docs when the provider supports it

Prompt tips:
1. Be concise and explicit for multi-step work.
2. Set \`workFolder\` to the project root so relative paths resolve correctly.
3. For analysis-only tasks, explicitly say no file modifications should be made.
4. Ask for staged or commit-ready changes when you want a Git workflow result.`;
}

export function resolveCliCommand(provider: AgentProviderConfig): string {
  debugLog(`[Debug] Attempting to find ${provider.displayName} CLI...`);

  const customCliName = process.env[provider.cliEnvVar];
  if (customCliName) {
    debugLog(
      `[Debug] Using custom ${provider.displayName} CLI from ${provider.cliEnvVar}: ${customCliName}`,
    );

    if (path.isAbsolute(customCliName)) {
      return customCliName;
    }

    if (
      customCliName.startsWith("./") ||
      customCliName.startsWith("../") ||
      customCliName.includes("/")
    ) {
      throw new Error(
        `Invalid ${provider.cliEnvVar}: Relative paths are not allowed. Use either a simple name (e.g., "${provider.defaultCliCommand}") or an absolute path.`,
      );
    }

    const runtimeCliPath = findCommandInPath(customCliName);
    if (runtimeCliPath) {
      return runtimeCliPath;
    }

    return customCliName;
  }

  const preferredCliPaths = provider.preferredCliPaths?.() ?? [];
  for (const cliPath of preferredCliPaths) {
    debugLog(`[Debug] Checking for ${provider.displayName} CLI at: ${cliPath}`);
    const resolvedCliPath = resolveExistingCliPath(cliPath);
    if (resolvedCliPath) {
      debugLog(
        `[Debug] Found ${provider.displayName} CLI at: ${resolvedCliPath}`,
      );
      return resolvedCliPath;
    }
  }

  const installedCliPath = installedCliPaths[provider.id];
  if (installedCliPath) {
    const resolvedInstalledCliPath = resolveExistingCliPath(installedCliPath);
    if (resolvedInstalledCliPath) {
      debugLog(
        `[Debug] Using installed ${provider.displayName} CLI path: ${resolvedInstalledCliPath}`,
      );
      return resolvedInstalledCliPath;
    }
  }

  const runtimeCliPath = findCommandInPath(provider.defaultCliCommand);
  if (runtimeCliPath) {
    debugLog(
      `[Debug] Found ${provider.displayName} CLI in PATH: ${runtimeCliPath}`,
    );
    return runtimeCliPath;
  }

  if (provider.warnWhenFallingBackToPath && provider.preferredCliPathLabel) {
    console.warn(
      `[Warning] ${provider.displayName} CLI not found at ${provider.preferredCliPathLabel}. Falling back to "${provider.defaultCliCommand}" in PATH. Ensure it is installed and accessible.`,
    );
  }

  return provider.defaultCliCommand;
}

function resolveAvailableCliCommand(
  provider: AgentProviderConfig,
): string | null {
  const customCliName = process.env[provider.cliEnvVar];
  if (customCliName) {
    if (path.isAbsolute(customCliName)) {
      const resolvedCustomPath = resolveExistingCliPath(customCliName);
      if (resolvedCustomPath) {
        return resolvedCustomPath;
      }

      console.warn(
        `[Warning] ${provider.displayName} CLI configured via ${provider.cliEnvVar} was not found at ${customCliName}. ${provider.toolName} will not be exposed.`,
      );
      return null;
    }

    if (
      customCliName.startsWith("./") ||
      customCliName.startsWith("../") ||
      customCliName.includes("/")
    ) {
      throw new Error(
        `Invalid ${provider.cliEnvVar}: Relative paths are not allowed. Use either a simple name (e.g., "${provider.defaultCliCommand}") or an absolute path.`,
      );
    }

    const resolvedCustomCommand = findCommandInPath(customCliName);
    if (resolvedCustomCommand) {
      return resolvedCustomCommand;
    }

    console.warn(
      `[Warning] ${provider.displayName} CLI configured via ${provider.cliEnvVar} was not found in PATH as "${customCliName}". ${provider.toolName} will not be exposed.`,
    );
    return null;
  }

  const preferredCliPaths = provider.preferredCliPaths?.() ?? [];
  for (const cliPath of preferredCliPaths) {
    const resolvedCliPath = resolveExistingCliPath(cliPath);
    if (resolvedCliPath) {
      return resolvedCliPath;
    }
  }

  const installedCliPath = installedCliPaths[provider.id];
  if (installedCliPath) {
    const resolvedInstalledCliPath = resolveExistingCliPath(installedCliPath);
    if (resolvedInstalledCliPath) {
      return resolvedInstalledCliPath;
    }
  }

  const resolvedRuntimeCliPath = findCommandInPath(provider.defaultCliCommand);
  if (resolvedRuntimeCliPath) {
    return resolvedRuntimeCliPath;
  }

  console.warn(
    `[Warning] ${provider.displayName} CLI was not found for ${provider.toolName}. Reinstall agent-mcp from a shell where "${provider.defaultCliCommand}" is in PATH or set ${provider.cliEnvVar} to an absolute path.`,
  );
  return null;
}

function parseToolArguments(
  toolArguments: unknown,
  toolName: string,
): ToolArguments {
  const parsedArguments = toolArgumentsSchema.safeParse(toolArguments);
  if (parsedArguments.success) {
    return parsedArguments.data;
  }

  const primaryIssue = parsedArguments.error.issues[0];
  const issuePath = primaryIssue?.path?.length
    ? ` at ${primaryIssue.path.join(".")}`
    : "";
  const issueMessage = primaryIssue?.message ?? "Invalid arguments";

  throw new McpError(
    ErrorCode.InvalidParams,
    `Invalid arguments for ${toolName}${issuePath}: ${issueMessage}`,
  );
}

function resolveWorkingDirectory(workFolder?: string): string {
  let effectiveCwd = homedir();

  if (!workFolder) {
    debugLog(
      `[Debug] No workFolder provided, using default CWD: ${effectiveCwd}`,
    );
    return effectiveCwd;
  }

  const resolvedCwd = pathResolve(workFolder);
  debugLog(
    `[Debug] Specified workFolder: ${workFolder}, Resolved to: ${resolvedCwd}`,
  );

  if (existsSync(resolvedCwd)) {
    debugLog(`[Debug] Using workFolder as CWD: ${resolvedCwd}`);
    return resolvedCwd;
  }

  debugLog(
    `[Warning] Specified workFolder does not exist: ${resolvedCwd}. Using default: ${effectiveCwd}`,
  );
  return effectiveCwd;
}

function cleanupInvocation(invocation: ProviderInvocation): void {
  if (!invocation.cleanupDir) {
    return;
  }

  try {
    rmSync(invocation.cleanupDir, { recursive: true, force: true });
  } catch (error) {
    debugLog("[Debug] Failed to clean up provider temp directory:", error);
  }
}

const claudeProvider: AgentProviderConfig = {
  id: "claude",
  toolName: "claude_code",
  title: "Claude Code Agent",
  displayName: "Claude",
  recommendedUse: "Claude Code",
  cliEnvVar: "CLAUDE_CLI_NAME",
  defaultCliCommand: "claude",
  preferredCliPaths: () => [join(homedir(), ".claude", "local", "claude")],
  preferredCliPathLabel: "~/.claude/local/claude",
  warnWhenFallingBackToPath: true,
  promptDescription:
    "The detailed natural language prompt for Claude to execute.",
  buildInvocation: ({ prompt }) => ({
    args: ["--dangerously-skip-permissions", "-p", prompt],
  }),
};

const codexProvider: AgentProviderConfig = {
  id: "codex",
  toolName: "codex",
  title: "Codex Agent",
  displayName: "Codex",
  recommendedUse: "Codex",
  cliEnvVar: "CODEX_CLI_NAME",
  defaultCliCommand: "codex",
  promptDescription:
    "The detailed natural language prompt for Codex to execute.",
  buildInvocation: ({ prompt, cwd }) => {
    const cleanupDir = mkdtempSync(join(tmpdir(), "codex-mcp-"));
    const outputFile = join(cleanupDir, "last-message.txt");

    return {
      args: [
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
        "--color",
        "never",
        "-C",
        cwd,
        "-o",
        outputFile,
        prompt,
      ],
      outputFile,
      cleanupDir,
    };
  },
  extractOutput: ({ stdout }, invocation) => {
    if (invocation.outputFile && existsSync(invocation.outputFile)) {
      const lastMessage = readFileSync(invocation.outputFile, "utf-8");
      if (lastMessage.trim()) {
        return lastMessage;
      }
    }

    return stdout;
  },
};

const geminiProvider: AgentProviderConfig = {
  id: "gemini",
  toolName: "gemini",
  title: "Gemini Agent",
  displayName: "Gemini",
  recommendedUse: "Gemini",
  cliEnvVar: "GEMINI_CLI_NAME",
  defaultCliCommand: "gemini",
  promptDescription:
    "The detailed natural language prompt for Gemini to execute.",
  buildInvocation: ({ prompt }) => ({
    args: ["-p", prompt, "-y", "-o", "text"],
  }),
};

const qwenProvider: AgentProviderConfig = {
  id: "qwen",
  toolName: "qwen",
  title: "Qwen Agent",
  displayName: "Qwen",
  recommendedUse: "Qwen",
  cliEnvVar: "QWEN_CLI_NAME",
  defaultCliCommand: "qwen",
  promptDescription:
    "The detailed natural language prompt for Qwen to execute.",
  buildInvocation: ({ prompt }) => ({
    args: ["-p", prompt, "-y", "-o", "text"],
  }),
};

export const AGENT_PROVIDERS: readonly AgentProviderConfig[] = [
  claudeProvider,
  codexProvider,
  geminiProvider,
  qwenProvider,
];

export function findClaudeCli(): string {
  return resolveCliCommand(claudeProvider);
}

export function findCodexCli(): string {
  return resolveCliCommand(codexProvider);
}

export function findGeminiCli(): string {
  return resolveCliCommand(geminiProvider);
}

export function findQwenCli(): string {
  return resolveCliCommand(qwenProvider);
}

// Ensure spawnAsync is defined before the server class.
export async function spawnAsync(
  command: string,
  args: string[],
  options?: { timeout?: number; cwd?: string },
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    debugLog(`[Spawn] Running command: ${command} ${args.join(" ")}`);
    const process = spawn(command, args, {
      shell: false,
      timeout: options?.timeout,
      cwd: options?.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    process.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    process.stderr.on("data", (data) => {
      stderr += data.toString();
      debugLog(`[Spawn Stderr Chunk] ${data.toString()}`);
    });

    process.on("error", (error: NodeJS.ErrnoException) => {
      debugLog("[Spawn Error Event] Full error object:", error);
      let errorMessage = `Spawn error: ${error.message}`;
      if (error.path) {
        errorMessage += ` | Path: ${error.path}`;
      }
      if (error.syscall) {
        errorMessage += ` | Syscall: ${error.syscall}`;
      }
      errorMessage += `\nStderr: ${stderr.trim()}`;
      reject(new Error(errorMessage));
    });

    process.on("close", (code) => {
      debugLog(`[Spawn Close] Exit code: ${code}`);
      debugLog(`[Spawn Stderr Full] ${stderr.trim()}`);
      debugLog(`[Spawn Stdout Full] ${stdout.trim()}`);

      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new Error(
          `Command failed with exit code ${code}\nStderr: ${stderr.trim()}\nStdout: ${stdout.trim()}`,
        ),
      );
    });
  });
}

/**
 * MCP Server for agent CLIs.
 * Provides provider-backed MCP tools for one-shot agent execution.
 */
export class AgentCliServer {
  private readonly server: Server;
  private readonly availableProviders: AgentProviderRuntime[];
  private readonly providersByToolName: Map<string, AgentProviderRuntime>;

  constructor() {
    this.availableProviders = AGENT_PROVIDERS.flatMap((provider) => {
      const cliCommand = resolveAvailableCliCommand(provider);
      if (!cliCommand) {
        return [];
      }

      const runtime = {
        ...provider,
        cliCommand,
      };

      console.error(
        `[Setup] Using ${provider.displayName} CLI command/path: ${runtime.cliCommand} (${provider.toolName})`,
      );
      return [runtime];
    });

    if (this.availableProviders.length === 0) {
      console.warn(
        "[Warning] No agent CLIs were found. agent-mcp will start without exposing any tools.",
      );
    }

    this.providersByToolName = new Map(
      this.availableProviders.map((provider) => [provider.toolName, provider]),
    );

    this.server = new Server(
      {
        name: "agent-mcp",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    this.setupToolHandlers();

    this.server.onerror = (error) => console.error("[Error]", error);
    process.on("SIGINT", async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.availableProviders.map((provider) => ({
        name: provider.toolName,
        description: buildToolDescription(provider),
        inputSchema: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: provider.promptDescription,
            },
            workFolder: {
              type: "string",
              description: workFolderDescription,
            },
          },
          required: ["prompt"],
        },
      })),
    }));

    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (args): Promise<ServerResult> => {
        debugLog("[Debug] Handling CallToolRequest:", args);

        const toolName = args.params.name;
        const provider = this.providersByToolName.get(toolName);
        if (!provider) {
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Tool ${toolName} not found`,
          );
        }

        const parsedArguments = parseToolArguments(
          args.params.arguments,
          toolName,
        );
        const effectiveCwd = resolveWorkingDirectory(
          parsedArguments.workFolder,
        );

        try {
          debugLog(
            `[Debug] Attempting to execute ${provider.displayName} CLI with prompt: "${parsedArguments.prompt}" in CWD: "${effectiveCwd}"`,
          );

          if (isFirstToolUse) {
            console.error(
              `${provider.toolName} v${SERVER_VERSION} started at ${serverStartupTime}`,
            );
            isFirstToolUse = false;
          }

          const invocation = provider.buildInvocation({
            prompt: parsedArguments.prompt,
            cwd: effectiveCwd,
          });

          try {
            debugLog(
              `[Debug] Invoking ${provider.displayName} CLI: ${provider.cliCommand} ${invocation.args.join(" ")}`,
            );
            const result = await spawnAsync(
              provider.cliCommand,
              invocation.args,
              {
                timeout: executionTimeoutMs,
                cwd: effectiveCwd,
              },
            );

            debugLog(
              `[Debug] ${provider.displayName} CLI stdout:`,
              result.stdout.trim(),
            );
            if (result.stderr) {
              debugLog(
                `[Debug] ${provider.displayName} CLI stderr:`,
                result.stderr.trim(),
              );
            }

            const output =
              provider.extractOutput?.(result, invocation) ?? result.stdout;
            return { content: [{ type: "text", text: output }] };
          } finally {
            cleanupInvocation(invocation);
          }
        } catch (error: any) {
          debugLog(
            `[Error] Error executing ${provider.displayName} CLI:`,
            error,
          );

          let errorMessage = error.message || "Unknown error";
          if (error.stderr) {
            errorMessage += `\nStderr: ${error.stderr}`;
          }
          if (error.stdout) {
            errorMessage += `\nStdout: ${error.stdout}`;
          }

          if (
            error.signal === "SIGTERM" ||
            (error.message && error.message.includes("ETIMEDOUT")) ||
            error.code === "ETIMEDOUT"
          ) {
            throw new McpError(
              ErrorCode.InternalError,
              `${provider.displayName} CLI command timed out after ${executionTimeoutMs / 1000}s. Details: ${errorMessage}`,
            );
          }

          throw new McpError(
            ErrorCode.InternalError,
            `${provider.displayName} CLI execution failed: ${errorMessage}`,
          );
        }
      },
    );
  }

  /**
   * Start the MCP server.
   */
  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("agent-mcp server running on stdio");
  }
}

export const ClaudeCodeServer = AgentCliServer;

function isDirectExecution(): boolean {
  const entryPoint = process.argv[1];
  if (typeof entryPoint !== "string" || entryPoint.length === 0) {
    return false;
  }

  try {
    const resolvedEntryPoint = realpathSync(entryPoint);
    if (
      typeof resolvedEntryPoint !== "string" ||
      resolvedEntryPoint.length === 0
    ) {
      return false;
    }

    return import.meta.url === pathToFileURL(resolvedEntryPoint).href;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  const server = new AgentCliServer();
  server.run().catch(console.error);
}
