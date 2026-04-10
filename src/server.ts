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
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
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
const SERVER_VERSION = "1.10.15";

const debugMode = process.env.MCP_CLAUDE_DEBUG === "true";
let isFirstToolUse = true;
const serverStartupTime = new Date().toISOString();
const defaultExecutionTimeoutMs = 300000; // 5 minutes
const executionTimeoutEnvVar = "AGENT_MCP_EXECUTION_TIMEOUT_MS";
const progressHeartbeatIntervalMs = 5000;
const defaultJobWaitMs = 25000;
const maxJobTailChars = 4000;
const unifiedToolName = "agent";
const unifiedToolTitle = "Agent Runner";

const workFolderDescription =
  "Mandatory when using file operations or referencing any file. The working directory for the CLI execution. Must be an absolute path.";
const timeoutMsDescription =
  "Optional maximum execution time in milliseconds for this tool call. Defaults to AGENT_MCP_EXECUTION_TIMEOUT_MS or 300000 (5 minutes). Set to 0 to disable the server-side timeout.";
const waitMsDescription = `Optional number of milliseconds to wait in this MCP call before returning. Defaults to ${defaultJobWaitMs}ms. If the job is still running when the wait expires, the response includes a job ID that can be passed back to the same tool to continue waiting.`;
const jobIdDescription =
  "Optional job ID from an earlier response. Pass this instead of prompt to keep waiting on an existing job.";
const cancelDescription =
  "Optional. When true, cancels the existing job identified by jobId.";
const providerDescription =
  "Provider to run for a new job. Required when starting with prompt. Omit when continuing an existing job with jobId.";

const providerToolArgumentsSchema = z
  .object({
    provider: z.string().optional(),
    prompt: z.string().optional(),
    jobId: z.string().min(1).optional(),
    workFolder: z.string().optional(),
    timeoutMs: z.number().int().nonnegative().optional(),
    waitMs: z.number().int().nonnegative().optional(),
    cancel: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const hasPrompt = typeof value.prompt === "string";
    const hasJobId = typeof value.jobId === "string";

    if (hasPrompt === hasJobId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide exactly one of prompt or jobId.",
        path: hasPrompt ? ["jobId"] : ["prompt"],
      });
    }

    if (hasPrompt && value.cancel) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "cancel can only be used together with jobId.",
        path: ["cancel"],
      });
    }

    if (hasPrompt && typeof value.provider !== "string") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "provider is required when starting a new job with prompt.",
        path: ["provider"],
      });
    }

    if (hasJobId && value.provider !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "provider cannot be used together with jobId.",
        path: ["provider"],
      });
    }

    if (hasJobId && value.workFolder !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "workFolder can only be used when starting a new job with prompt.",
        path: ["workFolder"],
      });
    }

    if (hasJobId && value.timeoutMs !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "timeoutMs can only be used when starting a new job with prompt.",
        path: ["timeoutMs"],
      });
    }
  });

type ProviderToolArguments = z.infer<typeof providerToolArgumentsSchema>;

interface ProgressNotificationExtra {
  _meta?: {
    progressToken?: string | number;
  };
  sendNotification?: (notification: {
    method: "notifications/progress";
    params: {
      progressToken: string | number;
      progress: number;
    };
  }) => Promise<void>;
  signal?: AbortSignal;
}

interface SpawnResult {
  stdout: string;
  stderr: string;
}

type AgentJobStatus = "running" | "completed" | "failed" | "cancelled";

interface ProviderInvocation {
  args: string[];
  outputFile?: string;
  cleanupDir?: string;
}

interface AgentJob {
  id: string;
  provider: AgentProviderRuntime;
  prompt: string;
  cwd: string;
  executionTimeoutMs: number;
  status: AgentJobStatus;
  startedAt: string;
  finishedAt?: string;
  stdout: string;
  stderr: string;
  result?: string;
  error?: string;
  cancelReason?: string;
  invocation: ProviderInvocation;
  childProcess: ChildProcess;
  completionListeners: Set<() => void>;
  timedOut: boolean;
  cancellationRequested: boolean;
  timeoutHandle: NodeJS.Timeout | null;
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
  cliArgsPrefix: string[];
  cliCommandDisplay: string;
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

function buildUnifiedToolDescription(
  providers: readonly AgentProviderRuntime[],
): string {
  const providerList = providers
    .map((provider) => `\`${provider.toolName}\` (${provider.displayName})`)
    .join(", ");

  return `${unifiedToolTitle}: Run a provider-backed coding agent non-interactively for code, file, Git, shell, and research tasks.

Available providers: ${providerList}

This tool uses one job-backed execution path for every provider.

How to use it:
1. Start a job with \`provider\` and \`prompt\`.
2. The server waits up to \`waitMs\` in this MCP call.
3. If the job finishes in time, you get the final result directly.
4. If it is still running, call the same tool again with \`jobId\` to keep waiting.
5. Cancel a running job by calling the same tool with \`jobId\` and \`cancel: true\`.

Prompt tips:
1. Be concise and explicit for multi-step work.
2. Set \`workFolder\` to the project root so relative paths resolve correctly.
3. For analysis-only tasks, explicitly say no file modifications should be made.
4. Ask for staged or commit-ready changes when you want a Git workflow result.
5. Use \`timeoutMs\` to cap the provider runtime; set it to \`0\` to disable the server-side timeout.
6. Use \`waitMs\` to control how long this MCP call waits before returning.`;
}

function parseExecutionTimeoutMs(
  rawValue: string | undefined,
  source: string,
): number | null {
  if (typeof rawValue !== "string") {
    return null;
  }

  const trimmedValue = rawValue.trim();
  if (trimmedValue.length === 0) {
    console.warn(
      `[Warning] Ignoring empty ${source}. Expected a non-negative integer in milliseconds.`,
    );
    return null;
  }

  if (!/^\d+$/.test(trimmedValue)) {
    console.warn(
      `[Warning] Ignoring invalid ${source}: "${rawValue}". Expected a non-negative integer in milliseconds.`,
    );
    return null;
  }

  const parsedValue = Number(trimmedValue);
  if (!Number.isSafeInteger(parsedValue)) {
    console.warn(
      `[Warning] Ignoring out-of-range ${source}: "${rawValue}". Expected a safe non-negative integer in milliseconds.`,
    );
    return null;
  }

  return parsedValue;
}

function resolveDefaultExecutionTimeoutMs(): number {
  return (
    parseExecutionTimeoutMs(
      process.env[executionTimeoutEnvVar],
      executionTimeoutEnvVar,
    ) ?? defaultExecutionTimeoutMs
  );
}

function resolveExecutionTimeoutMs(requestedTimeoutMs?: number): number {
  return requestedTimeoutMs ?? resolveDefaultExecutionTimeoutMs();
}

function formatTimeoutMs(timeoutMs: number): string {
  if (timeoutMs === 0) {
    return "disabled";
  }

  return `${timeoutMs}ms`;
}

function startProgressHeartbeat(
  extra: ProgressNotificationExtra | undefined,
  providerDisplayName: string,
): () => void {
  const progressToken = extra?._meta?.progressToken;
  const sendNotification = extra?.sendNotification;

  if (progressToken === undefined || typeof sendNotification !== "function") {
    return () => {};
  }

  let progress = 0;
  let stopped = false;

  const sendProgress = (): void => {
    if (stopped) {
      return;
    }

    progress += 1;
    void sendNotification({
      method: "notifications/progress",
      params: {
        progressToken,
        progress,
      },
    }).catch((error) => {
      debugLog(
        `[Debug] Failed to send progress notification for ${providerDisplayName}:`,
        error,
      );
    });
  };

  sendProgress();

  const heartbeatHandle = setInterval(
    sendProgress,
    progressHeartbeatIntervalMs,
  );
  heartbeatHandle.unref?.();

  return () => {
    stopped = true;
    clearInterval(heartbeatHandle);
  };
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

function shouldInvokeWithServerRuntime(cliCommand: string): boolean {
  if (!path.isAbsolute(cliCommand)) {
    return false;
  }

  return [".js", ".cjs", ".mjs"].includes(
    path.extname(cliCommand).toLowerCase(),
  );
}

export function resolveProviderExecution(
  cliCommand: string,
): Pick<
  AgentProviderRuntime,
  "cliCommand" | "cliArgsPrefix" | "cliCommandDisplay"
> {
  if (shouldInvokeWithServerRuntime(cliCommand)) {
    return {
      cliCommand: process.execPath,
      cliArgsPrefix: [cliCommand],
      cliCommandDisplay: `${process.execPath} ${cliCommand}`,
    };
  }

  return {
    cliCommand,
    cliArgsPrefix: [],
    cliCommandDisplay: cliCommand,
  };
}

function parseToolArguments<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  toolArguments: unknown,
  toolName: string,
): z.infer<TSchema> {
  const parsedArguments = schema.safeParse(toolArguments);
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

function truncateTail(value: string): string {
  if (value.length <= maxJobTailChars) {
    return value;
  }

  return `[truncated to last ${maxJobTailChars} chars]\n${value.slice(-maxJobTailChars)}`;
}

function getElapsedMs(job: AgentJob): number {
  const startedAt = new Date(job.startedAt).getTime();
  const finishedAt = job.finishedAt
    ? new Date(job.finishedAt).getTime()
    : Date.now();
  return Math.max(0, finishedAt - startedAt);
}

function killChildProcessTree(
  childProcess: ChildProcess,
  command: string,
  reason: string,
): void {
  debugLog(`[Spawn ${reason}] Killing command: ${command}`);

  if (process.platform !== "win32" && typeof childProcess.pid === "number") {
    try {
      process.kill(-childProcess.pid, "SIGKILL");
      return;
    } catch (error) {
      debugLog(
        `[Spawn ${reason}] Failed to kill process group, falling back to child process kill:`,
        error,
      );
    }
  }

  childProcess.kill("SIGKILL");
}

function resolveWorkingDirectory(workFolder?: string): string {
  const effectiveCwd = homedir();

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
  options?: { timeout?: number; cwd?: string; signal?: AbortSignal },
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    debugLog(`[Spawn] Running command: ${command} ${args.join(" ")}`);
    const childProcess = spawn(command, args, {
      shell: false,
      cwd: options?.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let aborted = false;

    const buildTimeoutError = (signal?: NodeJS.Signals | null): Error => {
      const timeoutMs = options?.timeout ?? 0;
      const error = new Error(
        `Command timed out after ${timeoutMs}ms\nSignal: ${signal ?? "unknown"}\nStderr: ${stderr.trim()}\nStdout: ${stdout.trim()}`,
      ) as Error & {
        code?: string;
        signal?: NodeJS.Signals | null;
        stderr?: string;
        stdout?: string;
      };
      error.code = "ETIMEDOUT";
      error.signal = signal ?? null;
      error.stderr = stderr;
      error.stdout = stdout;
      return error;
    };

    const buildAbortError = (signal?: NodeJS.Signals | null): Error => {
      const reason = options?.signal?.reason;
      const reasonSuffix =
        reason === undefined ? "" : `\nReason: ${String(reason)}`;
      const error = new Error(
        `Command aborted${reasonSuffix}\nSignal: ${signal ?? "unknown"}\nStderr: ${stderr.trim()}\nStdout: ${stdout.trim()}`,
      ) as Error & {
        code?: string;
        signal?: NodeJS.Signals | null;
        stderr?: string;
        stdout?: string;
      };
      error.name = "AbortError";
      error.code = "ABORT_ERR";
      error.signal = signal ?? null;
      error.stderr = stderr;
      error.stdout = stdout;
      return error;
    };

    const finishResolve = (result: SpawnResult): void => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(result);
    };

    const finishReject = (error: Error): void => {
      if (settled) {
        return;
      }

      settled = true;
      reject(error);
    };

    const timeoutHandle =
      typeof options?.timeout === "number" && options.timeout > 0
        ? setTimeout(() => {
            if (settled) {
              return;
            }

            timedOut = true;
            killChildProcessTree(
              childProcess,
              command,
              `Timeout after ${options.timeout}ms`,
            );
          }, options.timeout)
        : null;

    const abortHandler = (): void => {
      if (settled) {
        return;
      }

      aborted = true;
      killChildProcessTree(childProcess, command, "Abort");
    };

    if (options?.signal) {
      if (options.signal.aborted) {
        abortHandler();
      } else {
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }
    }

    const clearTimeoutHandle = (): void => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    };

    const cleanupAbortHandler = (): void => {
      options?.signal?.removeEventListener("abort", abortHandler);
    };

    childProcess.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    childProcess.stderr.on("data", (data) => {
      stderr += data.toString();
      debugLog(`[Spawn Stderr Chunk] ${data.toString()}`);
    });

    childProcess.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeoutHandle();
      cleanupAbortHandler();
      debugLog("[Spawn Error Event] Full error object:", error);

      if (timedOut) {
        finishReject(
          buildTimeoutError(
            (
              error as NodeJS.ErrnoException & {
                signal?: NodeJS.Signals | null;
              }
            ).signal,
          ),
        );
        return;
      }

      if (aborted) {
        finishReject(
          buildAbortError(
            (
              error as NodeJS.ErrnoException & {
                signal?: NodeJS.Signals | null;
              }
            ).signal,
          ),
        );
        return;
      }

      let errorMessage = `Spawn error: ${error.message}`;
      if (error.path) {
        errorMessage += ` | Path: ${error.path}`;
      }
      if (error.syscall) {
        errorMessage += ` | Syscall: ${error.syscall}`;
      }
      errorMessage += `\nStderr: ${stderr.trim()}`;
      finishReject(new Error(errorMessage));
    });

    childProcess.on("close", (code, signal) => {
      clearTimeoutHandle();
      cleanupAbortHandler();
      debugLog(`[Spawn Close] Exit code: ${code}, Signal: ${signal ?? "none"}`);
      debugLog(`[Spawn Stderr Full] ${stderr.trim()}`);
      debugLog(`[Spawn Stdout Full] ${stdout.trim()}`);

      if (timedOut) {
        finishReject(buildTimeoutError(signal));
        return;
      }

      if (aborted) {
        finishReject(buildAbortError(signal));
        return;
      }

      if (code === 0) {
        finishResolve({ stdout, stderr });
        return;
      }

      const signalMessage = signal ? `\nSignal: ${signal}` : "";
      finishReject(
        new Error(
          `Command failed with exit code ${code}${signalMessage}\nStderr: ${stderr.trim()}\nStdout: ${stdout.trim()}`,
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
  private readonly jobs = new Map<string, AgentJob>();

  constructor() {
    this.availableProviders = AGENT_PROVIDERS.flatMap((provider) => {
      const cliCommand = resolveAvailableCliCommand(provider);
      if (!cliCommand) {
        return [];
      }

      const execution = resolveProviderExecution(cliCommand);

      const runtime = {
        ...provider,
        ...execution,
      };

      console.error(
        `[Setup] Using ${provider.displayName} CLI command/path: ${runtime.cliCommandDisplay} (${provider.toolName})`,
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
        version: SERVER_VERSION,
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
      this.cancelAllJobs("agent-mcp server shutting down");
      await this.server.close();
      process.exit(0);
    });
  }

  private logStartupOnce(provider: AgentProviderRuntime): void {
    if (isFirstToolUse) {
      console.error(
        `${provider.toolName} v${SERVER_VERSION} started at ${serverStartupTime}`,
      );
      isFirstToolUse = false;
    }
  }

  private getProviderOrThrow(providerName: string): AgentProviderRuntime {
    const provider = this.providersByToolName.get(providerName);
    if (!provider) {
      const availableProviders = this.availableProviders
        .map((entry) => entry.toolName)
        .join(", ");
      throw new McpError(
        ErrorCode.InvalidParams,
        `Unknown provider "${providerName}". Available providers: ${availableProviders}`,
      );
    }

    return provider;
  }

  private getJobOrThrow(jobId: string): AgentJob {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Unknown job ID "${jobId}". Start a new job with provider and prompt first.`,
      );
    }

    return job;
  }

  private notifyJobCompletion(job: AgentJob): void {
    for (const listener of job.completionListeners) {
      listener();
    }
    job.completionListeners.clear();
  }

  private startJob(
    provider: AgentProviderRuntime,
    prompt: string,
    cwd: string,
    executionTimeoutMs: number,
  ): AgentJob {
    this.logStartupOnce(provider);

    const invocation = provider.buildInvocation({
      prompt,
      cwd,
    });
    const executionArgs = [...provider.cliArgsPrefix, ...invocation.args];

    debugLog(
      `[Debug] Starting ${provider.displayName} job in CWD "${cwd}" (timeout: ${formatTimeoutMs(executionTimeoutMs)})`,
    );
    debugLog(
      `[Debug] Invoking ${provider.displayName} CLI: ${provider.cliCommandDisplay} ${executionArgs.join(" ")}`,
    );

    const childProcess = spawn(provider.cliCommand, executionArgs, {
      shell: false,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    const job: AgentJob = {
      id: randomUUID(),
      provider,
      prompt,
      cwd,
      executionTimeoutMs,
      status: "running",
      startedAt: new Date().toISOString(),
      stdout: "",
      stderr: "",
      invocation,
      childProcess,
      completionListeners: new Set(),
      timedOut: false,
      cancellationRequested: false,
      timeoutHandle: null,
    };

    this.jobs.set(job.id, job);

    let settled = false;
    const finishJob = (
      updater: (code: number | null, signal: NodeJS.Signals | null) => void,
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      if (settled) {
        return;
      }

      settled = true;
      if (job.timeoutHandle) {
        clearTimeout(job.timeoutHandle);
        job.timeoutHandle = null;
      }

      updater(code, signal);
      job.finishedAt = new Date().toISOString();
      cleanupInvocation(job.invocation);
      this.notifyJobCompletion(job);
    };

    if (executionTimeoutMs > 0) {
      job.timeoutHandle = setTimeout(() => {
        if (job.status !== "running") {
          return;
        }

        job.timedOut = true;
        killChildProcessTree(
          childProcess,
          provider.cliCommandDisplay,
          `Timeout after ${executionTimeoutMs}ms`,
        );
      }, executionTimeoutMs);
      job.timeoutHandle.unref?.();
    }

    childProcess.stdout?.on("data", (data) => {
      job.stdout += data.toString();
    });

    childProcess.stderr?.on("data", (data) => {
      const chunk = data.toString();
      job.stderr += chunk;
      debugLog(`[Job ${job.id} ${provider.displayName} Stderr Chunk] ${chunk}`);
    });

    childProcess.on("error", (error: NodeJS.ErrnoException) => {
      debugLog(
        `[Error] ${provider.displayName} background job ${job.id} emitted an error:`,
        error,
      );
      finishJob(
        () => {
          job.status = "failed";
          job.error = `${provider.displayName} CLI execution failed: Spawn error: ${error.message}`;
        },
        null,
        null,
      );
    });

    childProcess.on("close", (code, signal) => {
      debugLog(
        `[Debug] ${provider.displayName} background job ${job.id} closed with code ${code}, signal ${signal ?? "none"}`,
      );

      finishJob(
        (finalCode, finalSignal) => {
          if (job.timedOut) {
            const timeoutDetails = `Command timed out after ${executionTimeoutMs}ms\nSignal: ${finalSignal ?? "unknown"}\nStderr: ${job.stderr.trim()}\nStdout: ${job.stdout.trim()}`;
            job.status = "failed";
            job.error = `${provider.displayName} CLI command timed out after ${formatTimeoutMs(executionTimeoutMs)}. Details: ${timeoutDetails}`;
            return;
          }

          if (job.cancellationRequested) {
            job.status = "cancelled";
            job.error =
              job.cancelReason ??
              `${provider.displayName} job ${job.id} was cancelled.`;
            return;
          }

          if (finalCode === 0) {
            const result = provider.extractOutput?.(
              {
                stdout: job.stdout,
                stderr: job.stderr,
              },
              invocation,
            );
            job.status = "completed";
            job.result = result ?? job.stdout;
            return;
          }

          const signalMessage = finalSignal ? `\nSignal: ${finalSignal}` : "";
          job.status = "failed";
          job.error = `${provider.displayName} CLI execution failed: Command failed with exit code ${finalCode}${signalMessage}\nStderr: ${job.stderr.trim()}\nStdout: ${job.stdout.trim()}`;
        },
        code,
        signal,
      );
    });

    return job;
  }

  private cancelJob(job: AgentJob, reason: string): void {
    if (job.status !== "running" || job.cancellationRequested) {
      return;
    }

    job.cancellationRequested = true;
    job.cancelReason = reason;
    killChildProcessTree(
      job.childProcess,
      job.provider.cliCommandDisplay,
      `Cancel job ${job.id}`,
    );
  }

  private cancelAllJobs(reason: string): void {
    for (const job of this.jobs.values()) {
      this.cancelJob(job, reason);
    }
  }

  private waitForJob(
    job: AgentJob,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (job.status !== "running" || waitMs <= 0) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let timeoutHandle: NodeJS.Timeout | null = null;

      const cleanup = (): void => {
        if (settled) {
          return;
        }

        settled = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        signal?.removeEventListener("abort", onAbort);
        job.completionListeners.delete(onComplete);
      };

      const onComplete = (): void => {
        cleanup();
        resolve();
      };

      const onAbort = (): void => {
        cleanup();
        const reason = signal?.reason;
        reject(
          reason instanceof Error
            ? reason
            : new Error(String(reason ?? "Request aborted while waiting")),
        );
      };

      timeoutHandle = setTimeout(() => {
        cleanup();
        resolve();
      }, waitMs);
      timeoutHandle.unref?.();

      job.completionListeners.add(onComplete);

      if (signal?.aborted) {
        onAbort();
        return;
      }

      signal?.addEventListener("abort", onAbort, { once: true });

      if (job.status !== "running") {
        onComplete();
      }
    });
  }

  private buildRunningJobResponse(job: AgentJob, waitMs: number): ServerResult {
    const stdoutTail = truncateTail(job.stdout.trim());
    const stderrTail = truncateTail(job.stderr.trim());
    const nextWaitMs = waitMs > 0 ? waitMs : defaultJobWaitMs;
    const lines = [
      `Job ${job.id} is still running with ${job.provider.displayName}.`,
      `Elapsed: ${getElapsedMs(job)}ms`,
      `Call ${unifiedToolName} again with {"jobId":"${job.id}","waitMs":${nextWaitMs}} to keep waiting.`,
    ];

    if (stdoutTail.length > 0) {
      lines.push("", "Stdout tail:", stdoutTail);
    }

    if (stderrTail.length > 0) {
      lines.push("", "Stderr tail:", stderrTail);
    }

    return {
      content: [
        {
          type: "text",
          text: lines.join("\n"),
        },
      ],
    };
  }

  private buildCompletedJobResponse(job: AgentJob): ServerResult {
    return {
      content: [
        {
          type: "text",
          text: job.result ?? "",
        },
      ],
    };
  }

  private buildCancelledJobResponse(job: AgentJob): ServerResult {
    return {
      content: [
        {
          type: "text",
          text:
            job.error ??
            `${job.provider.displayName} job ${job.id} was cancelled.`,
        },
      ],
    };
  }

  private buildJobResponse(job: AgentJob, waitMs: number): ServerResult {
    switch (job.status) {
      case "completed":
        return this.buildCompletedJobResponse(job);
      case "running":
        return this.buildRunningJobResponse(job, waitMs);
      case "cancelled":
        return this.buildCancelledJobResponse(job);
      case "failed":
        throw new McpError(
          ErrorCode.InternalError,
          job.error ??
            `${job.provider.displayName} job ${job.id} failed without an error message.`,
        );
    }

    throw new McpError(
      ErrorCode.InternalError,
      `Unknown job status for ${job.id}.`,
    );
  }

  private setupToolHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: unifiedToolName,
          description: buildUnifiedToolDescription(this.availableProviders),
          inputSchema: {
            type: "object",
            properties: {
              provider: {
                type: "string",
                enum: this.availableProviders.map(
                  (provider) => provider.toolName,
                ),
                description: providerDescription,
              },
              prompt: {
                type: "string",
                description:
                  "The detailed natural language prompt for a new job. Provide this together with provider.",
              },
              jobId: {
                type: "string",
                description: jobIdDescription,
              },
              workFolder: {
                type: "string",
                description: workFolderDescription,
              },
              timeoutMs: {
                type: "integer",
                minimum: 0,
                description: timeoutMsDescription,
              },
              waitMs: {
                type: "integer",
                minimum: 0,
                description: waitMsDescription,
              },
              cancel: {
                type: "boolean",
                description: cancelDescription,
              },
            },
            anyOf: [
              {
                required: ["provider", "prompt"],
              },
              {
                required: ["jobId"],
              },
            ],
          },
        },
      ],
    }));

    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (args, extra): Promise<ServerResult> => {
        debugLog("[Debug] Handling CallToolRequest:", args);

        const toolName = args.params.name;
        if (toolName !== unifiedToolName) {
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Tool ${toolName} not found`,
          );
        }

        const parsedArguments: ProviderToolArguments = parseToolArguments(
          providerToolArgumentsSchema,
          args.params.arguments,
          toolName,
        );

        let job: AgentJob;
        let provider: AgentProviderRuntime;
        let stopProgressHeartbeat: (() => void) | undefined;

        try {
          if (parsedArguments.jobId) {
            job = this.getJobOrThrow(parsedArguments.jobId);
            provider = job.provider;
          } else {
            provider = this.getProviderOrThrow(parsedArguments.provider!);
            const effectiveCwd = resolveWorkingDirectory(
              parsedArguments.workFolder,
            );
            const executionTimeoutMs = resolveExecutionTimeoutMs(
              parsedArguments.timeoutMs,
            );

            debugLog(
              `[Debug] Starting ${provider.displayName} job with prompt: "${parsedArguments.prompt}" in CWD: "${effectiveCwd}" (timeout: ${formatTimeoutMs(executionTimeoutMs)})`,
            );
            job = this.startJob(
              provider,
              parsedArguments.prompt!,
              effectiveCwd,
              executionTimeoutMs,
            );
          }

          stopProgressHeartbeat = startProgressHeartbeat(
            extra,
            provider.displayName,
          );

          if (parsedArguments.cancel) {
            this.cancelJob(
              job,
              `${provider.displayName} job ${job.id} was cancelled by request.`,
            );
          }

          await this.waitForJob(
            job,
            parsedArguments.waitMs ?? defaultJobWaitMs,
            extra?.signal,
          );

          return this.buildJobResponse(
            job,
            parsedArguments.waitMs ?? defaultJobWaitMs,
          );
        } catch (error: any) {
          if (extra?.signal?.aborted) {
            debugLog("[Debug] agent tool request was cancelled by the client.");
            throw error;
          }

          debugLog("[Error] Error executing agent tool:", error);

          if (
            error?.code === ErrorCode.InternalError ||
            error?.code === ErrorCode.InvalidParams ||
            error?.code === ErrorCode.MethodNotFound
          ) {
            throw error;
          }

          throw new McpError(
            ErrorCode.InternalError,
            error.message || "Unknown agent tool error",
          );
        } finally {
          stopProgressHeartbeat?.();
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
