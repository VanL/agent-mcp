#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, } from "@modelcontextprotocol/sdk/types.js";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve as pathResolve } from "node:path";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
// Server version - update this when releasing new versions
const SERVER_VERSION = "1.10.17";
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
const opencodeModelEnvVar = "OPENCODE_MODEL";
const opencodeProbePrompt = "Reply with exactly OK.";
const opencodeProbeTimeoutMs = 2500;
const claudeMinimalModeEnvVar = "AGENT_MCP_CLAUDE_MINIMAL_MODE";
const codexMinimalModeEnvVar = "AGENT_MCP_CODEX_MINIMAL_MODE";
const codexAllowedMcpServersEnvVar = "AGENT_MCP_CODEX_ALLOWED_MCP_SERVERS";
const geminiMinimalModeEnvVar = "AGENT_MCP_GEMINI_MINIMAL_MODE";
const opencodeMinimalModeEnvVar = "AGENT_MCP_OPENCODE_MINIMAL_MODE";
const qwenMinimalModeEnvVar = "AGENT_MCP_QWEN_MINIMAL_MODE";
const geminiAuthFiles = [
    "google_accounts.json",
    "installation_id",
    "state.json",
];
const workFolderDescription = "Mandatory when using file operations or referencing any file. The working directory for the CLI execution. Must be an absolute path.";
const timeoutMsDescription = "Optional maximum execution time in milliseconds for this tool call. Defaults to AGENT_MCP_EXECUTION_TIMEOUT_MS or 300000 (5 minutes). Set to 0 to disable the server-side timeout.";
const waitMsDescription = `Optional number of milliseconds to wait in this MCP call before returning. Defaults to ${defaultJobWaitMs}ms. If the job is still running when the wait expires, the response includes a job ID that can be passed back to the same tool to continue waiting.`;
const jobIdDescription = "Optional job ID from an earlier response. Pass this instead of prompt to keep waiting on an existing job.";
const cancelDescription = "Optional. When true, cancels the existing job identified by jobId.";
const providerDescription = "Provider to run for a new job. Required when starting with prompt. Omit when continuing an existing job with jobId.";
const modelDescription = "Optional per-call model override in provider/model form. Currently supported by gemini and opencode when starting a new job.";
const providerToolArgumentsSchema = z
    .object({
    provider: z.string().optional(),
    prompt: z.string().optional(),
    jobId: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
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
            message: "workFolder can only be used when starting a new job with prompt.",
            path: ["workFolder"],
        });
    }
    if (hasJobId && value.model !== undefined) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "model can only be used when starting a new job with prompt.",
            path: ["model"],
        });
    }
    if (hasJobId && value.timeoutMs !== undefined) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "timeoutMs can only be used when starting a new job with prompt.",
            path: ["timeoutMs"],
        });
    }
});
/**
 * Dedicated debug logging function.
 */
export function debugLog(message, ...optionalParams) {
    if (debugMode) {
        console.error(message, ...optionalParams);
    }
}
function resolveExistingCliPath(cliPath) {
    if (!existsSync(cliPath)) {
        return null;
    }
    try {
        const resolvedPath = realpathSync(cliPath);
        if (typeof resolvedPath === "string" && resolvedPath.length > 0) {
            return resolvedPath;
        }
    }
    catch {
        return cliPath;
    }
    return cliPath;
}
function findCommandInPath(commandName) {
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
    const pathextEntries = process.platform === "win32"
        ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
            .split(";")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0)
        : [""];
    const candidateExtensions = process.platform === "win32" && path.extname(commandName).length === 0
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
function loadInstalledCliPaths() {
    const cliPathManifestPath = join(path.dirname(fileURLToPath(import.meta.url)), "provider-cli-paths.json");
    if (!existsSync(cliPathManifestPath)) {
        return {};
    }
    try {
        const manifestContents = readFileSync(cliPathManifestPath, "utf-8");
        const parsed = JSON.parse(manifestContents);
        if (typeof parsed !== "object" || parsed === null) {
            return {};
        }
        return Object.fromEntries(Object.entries(parsed).filter((entry) => typeof entry[0] === "string" &&
            typeof entry[1] === "string" &&
            entry[1].length > 0));
    }
    catch (error) {
        debugLog("[Debug] Failed to load installed provider CLI paths:", error);
        return {};
    }
}
const installedCliPaths = loadInstalledCliPaths();
function buildUnifiedToolDescription(providers, options) {
    const providerList = providers
        .map((provider) => {
        if (provider.toolName !== "opencode") {
            return `- \`${provider.toolName}\` (${provider.displayName})`;
        }
        const details = [provider.displayName];
        const probe = options?.opencodeProbe;
        if (probe?.defaultModel) {
            const sourceSuffix = probe.defaultModelSource === "env" ? ", env override" : "";
            details.push(`default: \`${probe.defaultModel}\`${sourceSuffix}`);
        }
        if (probe && probe.modelCatalogFamilies.length > 0) {
            details.push(`model families: ${probe.modelCatalogFamilies
                .map((entry) => `\`${entry}\``)
                .join(", ")} (auth varies)`);
        }
        if (probe && !probe.functional && probe.error) {
            details.push(`probe failed: ${probe.error}`);
        }
        details.push("supports per-call `model` override");
        return `- \`${provider.toolName}\` (${details.join("; ")})`;
    })
        .join("\n");
    return `${unifiedToolTitle}: Run a provider-backed coding agent non-interactively for code, file, Git, shell, and research tasks.

Available providers:
${providerList}

This tool uses one job-backed execution path for every provider.
Providers run in a minimal provider-local mode by default to avoid inherited MCP/plugin startup from the caller's normal user config.

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
6. Use \`waitMs\` to control how long this MCP call waits before returning.
7. Use \`model\` when you want a specific provider/model target for a provider that supports it.`;
}
function parseExecutionTimeoutMs(rawValue, source) {
    if (typeof rawValue !== "string") {
        return null;
    }
    const trimmedValue = rawValue.trim();
    if (trimmedValue.length === 0) {
        console.warn(`[Warning] Ignoring empty ${source}. Expected a non-negative integer in milliseconds.`);
        return null;
    }
    if (!/^\d+$/.test(trimmedValue)) {
        console.warn(`[Warning] Ignoring invalid ${source}: "${rawValue}". Expected a non-negative integer in milliseconds.`);
        return null;
    }
    const parsedValue = Number(trimmedValue);
    if (!Number.isSafeInteger(parsedValue)) {
        console.warn(`[Warning] Ignoring out-of-range ${source}: "${rawValue}". Expected a safe non-negative integer in milliseconds.`);
        return null;
    }
    return parsedValue;
}
function resolveDefaultExecutionTimeoutMs() {
    return (parseExecutionTimeoutMs(process.env[executionTimeoutEnvVar], executionTimeoutEnvVar) ?? defaultExecutionTimeoutMs);
}
function resolveExecutionTimeoutMs(requestedTimeoutMs) {
    return requestedTimeoutMs ?? resolveDefaultExecutionTimeoutMs();
}
function formatTimeoutMs(timeoutMs) {
    if (timeoutMs === 0) {
        return "disabled";
    }
    return `${timeoutMs}ms`;
}
function parseBooleanEnv(rawValue, defaultValue) {
    if (typeof rawValue !== "string") {
        return defaultValue;
    }
    const normalizedValue = rawValue.trim().toLowerCase();
    if (normalizedValue.length === 0) {
        return defaultValue;
    }
    if (["1", "true", "yes", "on"].includes(normalizedValue)) {
        return true;
    }
    if (["0", "false", "no", "off"].includes(normalizedValue)) {
        return false;
    }
    console.warn(`[Warning] Ignoring invalid boolean env value "${rawValue}". Expected one of: true/false, 1/0, yes/no, on/off.`);
    return defaultValue;
}
function isMinimalModeEnabled(envVar) {
    return parseBooleanEnv(process.env[envVar], true);
}
function parseCsvEnv(rawValue) {
    if (typeof rawValue !== "string") {
        return [];
    }
    return rawValue
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}
function readJsonFile(filePath) {
    if (!existsSync(filePath)) {
        return null;
    }
    try {
        return JSON.parse(readFileSync(filePath, "utf-8"));
    }
    catch (error) {
        debugLog(`[Debug] Failed to parse JSON from ${filePath}:`, error);
        return null;
    }
}
function getConfiguredCodexMcpServerNames() {
    const configPath = join(homedir(), ".codex", "config.toml");
    if (!existsSync(configPath)) {
        return [];
    }
    try {
        const contents = readFileSync(configPath, "utf-8");
        const serverNames = new Set();
        const sectionPattern = /^\s*\[mcp_servers\.("([^"]+)"|([A-Za-z0-9_-]+))\]\s*$/gm;
        for (const match of contents.matchAll(sectionPattern)) {
            const serverName = match[2] ?? match[3];
            if (serverName && serverName.length > 0) {
                serverNames.add(serverName);
            }
        }
        return [...serverNames];
    }
    catch (error) {
        debugLog("[Debug] Failed to read Codex MCP server config:", error);
        return [];
    }
}
function buildCodexMinimalConfigArgs() {
    if (!isMinimalModeEnabled(codexMinimalModeEnvVar)) {
        return [];
    }
    const allowedServers = new Set(parseCsvEnv(process.env[codexAllowedMcpServersEnvVar]).map((entry) => entry.toLowerCase()));
    const configuredServerNames = getConfiguredCodexMcpServerNames();
    return configuredServerNames.flatMap((serverName) => {
        if (!/^[A-Za-z0-9_-]+$/.test(serverName)) {
            console.warn(`[Warning] Skipping Codex MCP override for unsupported server name "${serverName}".`);
            return [];
        }
        if (allowedServers.has(serverName.toLowerCase())) {
            return [];
        }
        return ["-c", `mcp_servers.${serverName}.enabled=false`];
    });
}
function resolveGeminiSelectedAuthType() {
    const hasGeminiApiKey = typeof process.env.GEMINI_API_KEY === "string" &&
        process.env.GEMINI_API_KEY.trim().length > 0;
    if (hasGeminiApiKey) {
        return "gemini-api-key";
    }
    const settingsPath = join(homedir(), ".gemini", "settings.json");
    const settings = readJsonFile(settingsPath);
    const selectedType = settings?.security?.auth?.selectedType?.trim();
    return selectedType && selectedType.length > 0 ? selectedType : undefined;
}
function buildGeminiMinimalInvocationEnvironment() {
    const cleanupDir = mkdtempSync(join(tmpdir(), "agent-mcp-gemini-home-"));
    const geminiHome = join(cleanupDir, ".gemini");
    mkdirSync(join(geminiHome, "history"), { recursive: true });
    mkdirSync(join(geminiHome, "tmp"), { recursive: true });
    const selectedType = resolveGeminiSelectedAuthType();
    const settings = {
        ...(selectedType
            ? {
                security: {
                    auth: {
                        selectedType,
                    },
                },
            }
            : {}),
        admin: {
            mcp: { enabled: false },
            extensions: { enabled: false },
            skills: { enabled: false },
        },
        hooks: {},
        ui: {
            hideBanner: true,
            showHomeDirectoryWarning: false,
        },
    };
    writeFileSync(join(geminiHome, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
    writeFileSync(join(geminiHome, "projects.json"), `${JSON.stringify({ projects: {} }, null, 2)}\n`, "utf-8");
    writeFileSync(join(geminiHome, "trustedFolders.json"), `${JSON.stringify({}, null, 2)}\n`, "utf-8");
    const currentGeminiHome = join(homedir(), ".gemini");
    for (const fileName of geminiAuthFiles) {
        const sourcePath = join(currentGeminiHome, fileName);
        if (!existsSync(sourcePath)) {
            continue;
        }
        try {
            copyFileSync(sourcePath, join(geminiHome, fileName));
        }
        catch (error) {
            debugLog(`[Debug] Failed to copy Gemini auth file ${fileName}:`, error);
        }
    }
    const env = {
        ...process.env,
        HOME: cleanupDir,
        USERPROFILE: cleanupDir,
    };
    return {
        cleanupDir,
        env,
    };
}
function startProgressHeartbeat(extra, providerDisplayName) {
    const progressToken = extra?._meta?.progressToken;
    const sendNotification = extra?.sendNotification;
    if (progressToken === undefined || typeof sendNotification !== "function") {
        return () => { };
    }
    let progress = 0;
    let stopped = false;
    const sendProgress = () => {
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
            debugLog(`[Debug] Failed to send progress notification for ${providerDisplayName}:`, error);
        });
    };
    sendProgress();
    const heartbeatHandle = setInterval(sendProgress, progressHeartbeatIntervalMs);
    heartbeatHandle.unref?.();
    return () => {
        stopped = true;
        clearInterval(heartbeatHandle);
    };
}
export function resolveCliCommand(provider) {
    debugLog(`[Debug] Attempting to find ${provider.displayName} CLI...`);
    const customCliName = process.env[provider.cliEnvVar];
    if (customCliName) {
        debugLog(`[Debug] Using custom ${provider.displayName} CLI from ${provider.cliEnvVar}: ${customCliName}`);
        if (path.isAbsolute(customCliName)) {
            return customCliName;
        }
        if (customCliName.startsWith("./") ||
            customCliName.startsWith("../") ||
            customCliName.includes("/")) {
            throw new Error(`Invalid ${provider.cliEnvVar}: Relative paths are not allowed. Use either a simple name (e.g., "${provider.defaultCliCommand}") or an absolute path.`);
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
            debugLog(`[Debug] Found ${provider.displayName} CLI at: ${resolvedCliPath}`);
            return resolvedCliPath;
        }
    }
    const installedCliPath = installedCliPaths[provider.id];
    if (installedCliPath) {
        const resolvedInstalledCliPath = resolveExistingCliPath(installedCliPath);
        if (resolvedInstalledCliPath) {
            debugLog(`[Debug] Using installed ${provider.displayName} CLI path: ${resolvedInstalledCliPath}`);
            return resolvedInstalledCliPath;
        }
    }
    const runtimeCliPath = findCommandInPath(provider.defaultCliCommand);
    if (runtimeCliPath) {
        debugLog(`[Debug] Found ${provider.displayName} CLI in PATH: ${runtimeCliPath}`);
        return runtimeCliPath;
    }
    if (provider.warnWhenFallingBackToPath && provider.preferredCliPathLabel) {
        console.warn(`[Warning] ${provider.displayName} CLI not found at ${provider.preferredCliPathLabel}. Falling back to "${provider.defaultCliCommand}" in PATH. Ensure it is installed and accessible.`);
    }
    return provider.defaultCliCommand;
}
function resolveAvailableCliCommand(provider) {
    const customCliName = process.env[provider.cliEnvVar];
    if (customCliName) {
        if (path.isAbsolute(customCliName)) {
            const resolvedCustomPath = resolveExistingCliPath(customCliName);
            if (resolvedCustomPath) {
                return resolvedCustomPath;
            }
            console.warn(`[Warning] ${provider.displayName} CLI configured via ${provider.cliEnvVar} was not found at ${customCliName}. ${provider.toolName} will not be exposed.`);
            return null;
        }
        if (customCliName.startsWith("./") ||
            customCliName.startsWith("../") ||
            customCliName.includes("/")) {
            throw new Error(`Invalid ${provider.cliEnvVar}: Relative paths are not allowed. Use either a simple name (e.g., "${provider.defaultCliCommand}") or an absolute path.`);
        }
        const resolvedCustomCommand = findCommandInPath(customCliName);
        if (resolvedCustomCommand) {
            return resolvedCustomCommand;
        }
        console.warn(`[Warning] ${provider.displayName} CLI configured via ${provider.cliEnvVar} was not found in PATH as "${customCliName}". ${provider.toolName} will not be exposed.`);
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
    console.warn(`[Warning] ${provider.displayName} CLI was not found for ${provider.toolName}. Reinstall agent-mcp from a shell where "${provider.defaultCliCommand}" is in PATH or set ${provider.cliEnvVar} to an absolute path.`);
    return null;
}
function shouldInvokeWithServerRuntime(cliCommand) {
    if (!path.isAbsolute(cliCommand)) {
        return false;
    }
    return [".js", ".cjs", ".mjs"].includes(path.extname(cliCommand).toLowerCase());
}
export function resolveProviderExecution(cliCommand) {
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
function parseToolArguments(schema, toolArguments, toolName) {
    const parsedArguments = schema.safeParse(toolArguments);
    if (parsedArguments.success) {
        return parsedArguments.data;
    }
    const primaryIssue = parsedArguments.error.issues[0];
    const issuePath = primaryIssue?.path?.length
        ? ` at ${primaryIssue.path.join(".")}`
        : "";
    const issueMessage = primaryIssue?.message ?? "Invalid arguments";
    throw new McpError(ErrorCode.InvalidParams, `Invalid arguments for ${toolName}${issuePath}: ${issueMessage}`);
}
function truncateTail(value) {
    if (value.length <= maxJobTailChars) {
        return value;
    }
    return `[truncated to last ${maxJobTailChars} chars]\n${value.slice(-maxJobTailChars)}`;
}
function getElapsedMs(job) {
    const startedAt = new Date(job.startedAt).getTime();
    const finishedAt = job.finishedAt
        ? new Date(job.finishedAt).getTime()
        : Date.now();
    return Math.max(0, finishedAt - startedAt);
}
function killChildProcessTree(childProcess, command, reason) {
    debugLog(`[Spawn ${reason}] Killing command: ${command}`);
    if (process.platform !== "win32" && typeof childProcess.pid === "number") {
        try {
            process.kill(-childProcess.pid, "SIGKILL");
            return;
        }
        catch (error) {
            debugLog(`[Spawn ${reason}] Failed to kill process group, falling back to child process kill:`, error);
        }
    }
    childProcess.kill("SIGKILL");
}
function resolveWorkingDirectory(workFolder) {
    const effectiveCwd = homedir();
    if (!workFolder) {
        debugLog(`[Debug] No workFolder provided, using default CWD: ${effectiveCwd}`);
        return effectiveCwd;
    }
    const resolvedCwd = pathResolve(workFolder);
    debugLog(`[Debug] Specified workFolder: ${workFolder}, Resolved to: ${resolvedCwd}`);
    if (existsSync(resolvedCwd)) {
        debugLog(`[Debug] Using workFolder as CWD: ${resolvedCwd}`);
        return resolvedCwd;
    }
    debugLog(`[Warning] Specified workFolder does not exist: ${resolvedCwd}. Using default: ${effectiveCwd}`);
    return effectiveCwd;
}
function cleanupInvocation(invocation) {
    if (!invocation.cleanupDir) {
        return;
    }
    try {
        rmSync(invocation.cleanupDir, { recursive: true, force: true });
    }
    catch (error) {
        debugLog("[Debug] Failed to clean up provider temp directory:", error);
    }
}
export function parseOpencodeJsonOutput(stdout) {
    const textParts = [];
    for (const rawLine of stdout.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) {
            continue;
        }
        try {
            const event = JSON.parse(line);
            const text = event.part?.text;
            if (typeof text === "string" &&
                (event.type === "text" || event.part?.type === "text")) {
                textParts.push(text);
            }
        }
        catch {
            // Ignore non-JSON lines and fall back to raw stdout if needed.
        }
    }
    if (textParts.length > 0) {
        return textParts.join("");
    }
    return stdout;
}
function stripAnsi(value) {
    let result = "";
    let index = 0;
    while (index < value.length) {
        if (value[index] !== "\u001b" || value[index + 1] !== "[") {
            result += value[index];
            index += 1;
            continue;
        }
        index += 2;
        while (index < value.length && value[index] !== "m") {
            index += 1;
        }
        if (index < value.length) {
            index += 1;
        }
    }
    return result;
}
function normalizeProviderFamily(value) {
    return value
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/g, "-")
        .replaceAll(/^-+|-+$/g, "");
}
function parseOpencodeDefaultModel(output) {
    const cleanOutput = stripAnsi(output);
    const match = cleanOutput.match(/^\s*>\s+[^·\r\n]+\s+·\s+([^\r\n]+?)\s*$/m);
    if (!match) {
        return undefined;
    }
    const model = match[1]?.trim();
    return model && model.length > 0 ? model : undefined;
}
function parseOpencodeModelCatalogFamilies(output) {
    const cleanOutput = stripAnsi(output);
    const families = new Set();
    for (const rawLine of cleanOutput.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line.includes("/")) {
            continue;
        }
        const family = normalizeProviderFamily(line.split("/", 1)[0] ?? "");
        if (family.length > 0) {
            families.add(family);
        }
    }
    return [...families].sort();
}
export function detectOpencodeRunMode(execution) {
    try {
        const probe = spawnSync(execution.cliCommand, [...execution.cliArgsPrefix, "run", "--help"], {
            encoding: "utf-8",
            timeout: 2000,
            windowsHide: true,
        });
        const combinedOutput = `${probe?.stdout ?? ""}\n${probe?.stderr ?? ""}`;
        const normalizedOutput = combinedOutput.toLowerCase();
        if (probe?.error) {
            debugLog(`[Debug] Failed to probe ${execution.cliCommandDisplay} for opencode support:`, probe.error);
            return false;
        }
        return (probe?.status === 0 &&
            (normalizedOutput.includes("opencode run [message") ||
                normalizedOutput.includes("run opencode with a message")));
    }
    catch (error) {
        debugLog(`[Debug] Failed to probe ${execution.cliCommandDisplay} for opencode support:`, error);
        return false;
    }
}
function buildOpencodeInvocation(prompt, cwd, modelOverride = "") {
    const args = [
        "run",
        "--format",
        "json",
        "--dangerously-skip-permissions",
        "--dir",
        cwd,
    ];
    if (isMinimalModeEnabled(opencodeMinimalModeEnvVar)) {
        args.push("--pure");
    }
    if (modelOverride.length > 0) {
        args.push("--model", modelOverride);
    }
    args.push(prompt);
    return {
        args,
        invocationMode: "opencode-run",
        resolvedModel: modelOverride.length > 0 ? modelOverride : undefined,
    };
}
function probeOpencodeMetadata(execution) {
    const checkedAt = new Date().toISOString();
    const modelCatalogProbe = spawnSync(execution.cliCommand, [...execution.cliArgsPrefix, "models"], {
        encoding: "utf-8",
        timeout: 2000,
        windowsHide: true,
    });
    const modelCatalogFamilies = parseOpencodeModelCatalogFamilies(`${modelCatalogProbe.stdout ?? ""}\n${modelCatalogProbe.stderr ?? ""}`);
    const envDefaultModel = process.env[opencodeModelEnvVar]?.trim() ?? "";
    const args = [
        ...execution.cliArgsPrefix,
        "run",
        "--format",
        "default",
        "--dangerously-skip-permissions",
        "--dir",
        tmpdir(),
    ];
    if (envDefaultModel.length > 0) {
        args.push("--model", envDefaultModel);
    }
    args.push(opencodeProbePrompt);
    const runProbe = spawnSync(execution.cliCommand, args, {
        encoding: "utf-8",
        timeout: opencodeProbeTimeoutMs,
        windowsHide: true,
        cwd: tmpdir(),
    });
    const combinedOutput = `${runProbe.stdout ?? ""}\n${runProbe.stderr ?? ""}`;
    const parsedDefaultModel = envDefaultModel.length > 0
        ? envDefaultModel
        : parseOpencodeDefaultModel(combinedOutput);
    const functional = (runProbe.status === 0 && !runProbe.error) ||
        (parsedDefaultModel !== undefined &&
            !combinedOutput.includes("ProviderAuthError"));
    let error;
    if (!functional && runProbe.error) {
        error = runProbe.error.message;
    }
    else if (!functional && runProbe.status !== 0) {
        error = `exit ${runProbe.status ?? "unknown"}`;
    }
    return {
        checkedAt,
        functional,
        defaultModel: parsedDefaultModel,
        defaultModelSource: parsedDefaultModel === undefined
            ? undefined
            : envDefaultModel.length > 0
                ? "env"
                : "probe",
        modelCatalogFamilies,
        error,
    };
}
const claudeProvider = {
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
    promptDescription: "The detailed natural language prompt for Claude to execute.",
    buildInvocation: ({ prompt }) => {
        const args = ["--dangerously-skip-permissions"];
        if (isMinimalModeEnabled(claudeMinimalModeEnvVar)) {
            args.push("--strict-mcp-config");
        }
        args.push("-p", prompt);
        return {
            args,
            invocationMode: "default",
        };
    },
};
const codexProvider = {
    id: "codex",
    toolName: "codex",
    title: "Codex Agent",
    displayName: "Codex",
    recommendedUse: "Codex",
    cliEnvVar: "CODEX_CLI_NAME",
    defaultCliCommand: "codex",
    promptDescription: "The detailed natural language prompt for Codex to execute.",
    buildInvocation: ({ prompt, cwd }) => {
        const cleanupDir = mkdtempSync(join(tmpdir(), "codex-mcp-"));
        const outputFile = join(cleanupDir, "last-message.txt");
        const minimalConfigArgs = buildCodexMinimalConfigArgs();
        return {
            args: [
                "exec",
                ...minimalConfigArgs,
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
            invocationMode: "default",
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
const geminiProvider = {
    id: "gemini",
    toolName: "gemini",
    title: "Gemini Agent",
    displayName: "Gemini",
    recommendedUse: "Gemini",
    cliEnvVar: "GEMINI_CLI_NAME",
    defaultCliCommand: "gemini",
    promptDescription: "The detailed natural language prompt for Gemini to execute.",
    buildInvocation: ({ prompt, model }) => {
        const args = ["-p", prompt, "-y", "-o", "text"];
        const minimalInvocation = isMinimalModeEnabled(geminiMinimalModeEnvVar)
            ? buildGeminiMinimalInvocationEnvironment()
            : {};
        if (model) {
            args.unshift(model);
            args.unshift("-m");
        }
        return {
            args,
            ...minimalInvocation,
            invocationMode: "default",
            resolvedModel: model,
        };
    },
};
const qwenProvider = {
    id: "qwen",
    toolName: "qwen",
    title: "Qwen Agent",
    displayName: "Qwen",
    recommendedUse: "Qwen",
    cliEnvVar: "QWEN_CLI_NAME",
    defaultCliCommand: "qwen",
    promptDescription: "The detailed natural language prompt for Qwen to execute.",
    buildInvocation: ({ prompt }) => {
        const args = ["-p", prompt, "-y", "-o", "text"];
        if (isMinimalModeEnabled(qwenMinimalModeEnvVar)) {
            args.push("--extensions=", "--allowed-mcp-server-names=");
        }
        return {
            args,
            invocationMode: "default",
        };
    },
};
const opencodeProvider = {
    id: "opencode",
    toolName: "opencode",
    title: "OpenCode Agent",
    displayName: "OpenCode",
    recommendedUse: "OpenCode",
    cliEnvVar: "OPENCODE_CLI_NAME",
    defaultCliCommand: "opencode",
    promptDescription: "The detailed natural language prompt for OpenCode to execute.",
    detectInvocationMode: (execution) => detectOpencodeRunMode(execution) ? "opencode-run" : "default",
    buildInvocation: ({ prompt, cwd, model }) => buildOpencodeInvocation(prompt, cwd, model ?? process.env[opencodeModelEnvVar]?.trim() ?? ""),
    extractOutput: ({ stdout }) => parseOpencodeJsonOutput(stdout),
};
export const AGENT_PROVIDERS = [
    claudeProvider,
    codexProvider,
    geminiProvider,
    opencodeProvider,
    qwenProvider,
];
export function findClaudeCli() {
    return resolveCliCommand(claudeProvider);
}
export function findCodexCli() {
    return resolveCliCommand(codexProvider);
}
export function findGeminiCli() {
    return resolveCliCommand(geminiProvider);
}
export function findOpencodeCli() {
    return resolveCliCommand(opencodeProvider);
}
export function findQwenCli() {
    return resolveCliCommand(qwenProvider);
}
// Ensure spawnAsync is defined before the server class.
export async function spawnAsync(command, args, options) {
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
        const buildTimeoutError = (signal) => {
            const timeoutMs = options?.timeout ?? 0;
            const error = new Error(`Command timed out after ${timeoutMs}ms\nSignal: ${signal ?? "unknown"}\nStderr: ${stderr.trim()}\nStdout: ${stdout.trim()}`);
            error.code = "ETIMEDOUT";
            error.signal = signal ?? null;
            error.stderr = stderr;
            error.stdout = stdout;
            return error;
        };
        const buildAbortError = (signal) => {
            const reason = options?.signal?.reason;
            const reasonSuffix = reason === undefined ? "" : `\nReason: ${String(reason)}`;
            const error = new Error(`Command aborted${reasonSuffix}\nSignal: ${signal ?? "unknown"}\nStderr: ${stderr.trim()}\nStdout: ${stdout.trim()}`);
            error.name = "AbortError";
            error.code = "ABORT_ERR";
            error.signal = signal ?? null;
            error.stderr = stderr;
            error.stdout = stdout;
            return error;
        };
        const finishResolve = (result) => {
            if (settled) {
                return;
            }
            settled = true;
            resolve(result);
        };
        const finishReject = (error) => {
            if (settled) {
                return;
            }
            settled = true;
            reject(error);
        };
        const timeoutHandle = typeof options?.timeout === "number" && options.timeout > 0
            ? setTimeout(() => {
                if (settled) {
                    return;
                }
                timedOut = true;
                killChildProcessTree(childProcess, command, `Timeout after ${options.timeout}ms`);
            }, options.timeout)
            : null;
        const abortHandler = () => {
            if (settled) {
                return;
            }
            aborted = true;
            killChildProcessTree(childProcess, command, "Abort");
        };
        if (options?.signal) {
            if (options.signal.aborted) {
                abortHandler();
            }
            else {
                options.signal.addEventListener("abort", abortHandler, { once: true });
            }
        }
        const clearTimeoutHandle = () => {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
        };
        const cleanupAbortHandler = () => {
            options?.signal?.removeEventListener("abort", abortHandler);
        };
        childProcess.stdout.on("data", (data) => {
            stdout += data.toString();
        });
        childProcess.stderr.on("data", (data) => {
            stderr += data.toString();
            debugLog(`[Spawn Stderr Chunk] ${data.toString()}`);
        });
        childProcess.on("error", (error) => {
            clearTimeoutHandle();
            cleanupAbortHandler();
            debugLog("[Spawn Error Event] Full error object:", error);
            if (timedOut) {
                finishReject(buildTimeoutError(error.signal));
                return;
            }
            if (aborted) {
                finishReject(buildAbortError(error.signal));
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
            finishReject(new Error(`Command failed with exit code ${code}${signalMessage}\nStderr: ${stderr.trim()}\nStdout: ${stdout.trim()}`));
        });
    });
}
/**
 * MCP Server for agent CLIs.
 * Provides provider-backed MCP tools for one-shot agent execution.
 */
export class AgentCliServer {
    server;
    availableProviders;
    providersByToolName;
    jobs = new Map();
    opencodeProbe;
    constructor() {
        this.availableProviders = AGENT_PROVIDERS.flatMap((provider) => {
            const cliCommand = resolveAvailableCliCommand(provider);
            if (!cliCommand) {
                return [];
            }
            const execution = resolveProviderExecution(cliCommand);
            const invocationMode = provider.detectInvocationMode?.(execution) ?? "default";
            if (provider.id === "opencode" && invocationMode !== "opencode-run") {
                console.warn(`[Warning] ${provider.displayName} CLI at ${execution.cliCommandDisplay} does not support "run". ${provider.toolName} will not be exposed.`);
                return [];
            }
            const runtime = {
                ...provider,
                ...execution,
                invocationMode,
            };
            console.error(`[Setup] Using ${provider.displayName} CLI command/path: ${runtime.cliCommandDisplay} (${provider.toolName}, mode: ${runtime.invocationMode})`);
            return [runtime];
        });
        const opencodeRuntime = this.availableProviders.find((provider) => provider.toolName === "opencode");
        this.opencodeProbe = opencodeRuntime
            ? probeOpencodeMetadata(opencodeRuntime)
            : null;
        if (this.availableProviders.length === 0) {
            console.warn("[Warning] No agent CLIs were found. agent-mcp will start without exposing any tools.");
        }
        this.providersByToolName = new Map(this.availableProviders.map((provider) => [provider.toolName, provider]));
        this.server = new Server({
            name: "agent-mcp",
            version: SERVER_VERSION,
        }, {
            capabilities: {
                tools: {},
            },
        });
        this.setupToolHandlers();
        this.server.onerror = (error) => console.error("[Error]", error);
        process.on("SIGINT", async () => {
            this.cancelAllJobs("agent-mcp server shutting down");
            await this.server.close();
            process.exit(0);
        });
    }
    logStartupOnce(provider) {
        if (isFirstToolUse) {
            console.error(`${provider.toolName} v${SERVER_VERSION} started at ${serverStartupTime}`);
            isFirstToolUse = false;
        }
    }
    getProviderOrThrow(providerName) {
        const provider = this.providersByToolName.get(providerName);
        if (!provider) {
            const availableProviders = this.availableProviders
                .map((entry) => entry.toolName)
                .join(", ");
            throw new McpError(ErrorCode.InvalidParams, `Unknown provider "${providerName}". Available providers: ${availableProviders}`);
        }
        return provider;
    }
    validateProviderSpecificArguments(provider, args) {
        if (args.model &&
            provider.toolName !== "gemini" &&
            provider.toolName !== "opencode") {
            throw new McpError(ErrorCode.InvalidParams, `model is not supported for provider "${provider.toolName}".`);
        }
    }
    getJobOrThrow(jobId) {
        const job = this.jobs.get(jobId);
        if (!job) {
            throw new McpError(ErrorCode.InvalidParams, `Unknown job ID "${jobId}". Start a new job with provider and prompt first.`);
        }
        return job;
    }
    notifyJobCompletion(job) {
        for (const listener of job.completionListeners) {
            listener();
        }
        job.completionListeners.clear();
    }
    startJob(provider, prompt, cwd, executionTimeoutMs, model) {
        this.logStartupOnce(provider);
        const invocation = provider.buildInvocation({
            prompt,
            cwd,
            model,
            invocationMode: provider.invocationMode,
        });
        const executionArgs = [...provider.cliArgsPrefix, ...invocation.args];
        debugLog(`[Debug] Starting ${provider.displayName} job in CWD "${cwd}" (timeout: ${formatTimeoutMs(executionTimeoutMs)})`);
        debugLog(`[Debug] Invoking ${provider.displayName} CLI: ${provider.cliCommandDisplay} ${executionArgs.join(" ")}`);
        const childProcess = spawn(provider.cliCommand, executionArgs, {
            shell: false,
            cwd,
            env: invocation.env ?? process.env,
            stdio: ["ignore", "pipe", "pipe"],
            detached: process.platform !== "win32",
        });
        const job = {
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
        const finishJob = (updater, code, signal) => {
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
                killChildProcessTree(childProcess, provider.cliCommandDisplay, `Timeout after ${executionTimeoutMs}ms`);
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
        childProcess.on("error", (error) => {
            debugLog(`[Error] ${provider.displayName} background job ${job.id} emitted an error:`, error);
            finishJob(() => {
                job.status = "failed";
                job.error = `${provider.displayName} CLI execution failed: Spawn error: ${error.message}`;
            }, null, null);
        });
        childProcess.on("close", (code, signal) => {
            debugLog(`[Debug] ${provider.displayName} background job ${job.id} closed with code ${code}, signal ${signal ?? "none"}`);
            finishJob((finalCode, finalSignal) => {
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
                    const result = provider.extractOutput?.({
                        stdout: job.stdout,
                        stderr: job.stderr,
                    }, invocation);
                    job.status = "completed";
                    job.result = result ?? job.stdout;
                    return;
                }
                const signalMessage = finalSignal ? `\nSignal: ${finalSignal}` : "";
                job.status = "failed";
                job.error = `${provider.displayName} CLI execution failed: Command failed with exit code ${finalCode}${signalMessage}\nStderr: ${job.stderr.trim()}\nStdout: ${job.stdout.trim()}`;
            }, code, signal);
        });
        return job;
    }
    cancelJob(job, reason) {
        if (job.status !== "running" || job.cancellationRequested) {
            return;
        }
        job.cancellationRequested = true;
        job.cancelReason = reason;
        killChildProcessTree(job.childProcess, job.provider.cliCommandDisplay, `Cancel job ${job.id}`);
    }
    cancelAllJobs(reason) {
        for (const job of this.jobs.values()) {
            this.cancelJob(job, reason);
        }
    }
    waitForJob(job, waitMs, signal) {
        if (job.status !== "running" || waitMs <= 0) {
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            let settled = false;
            let timeoutHandle = null;
            const cleanup = () => {
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
            const onComplete = () => {
                cleanup();
                resolve();
            };
            const onAbort = () => {
                cleanup();
                const reason = signal?.reason;
                reject(reason instanceof Error
                    ? reason
                    : new Error(String(reason ?? "Request aborted while waiting")));
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
    buildRunningJobResponse(job, waitMs) {
        const stdoutTail = truncateTail(job.stdout.trim());
        const stderrTail = truncateTail(job.stderr.trim());
        const nextWaitMs = waitMs > 0 ? waitMs : defaultJobWaitMs;
        const lines = [
            `Job ${job.id} is still running with ${job.provider.displayName}.`,
            `Elapsed: ${getElapsedMs(job)}ms`,
            `Call ${unifiedToolName} again with {"jobId":"${job.id}","waitMs":${nextWaitMs}} to keep waiting.`,
        ];
        if (job.invocation.resolvedModel) {
            lines.splice(2, 0, `Model: ${job.invocation.resolvedModel}`);
        }
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
    buildCompletedJobResponse(job) {
        return {
            content: [
                {
                    type: "text",
                    text: job.result ?? "",
                },
            ],
        };
    }
    buildCancelledJobResponse(job) {
        return {
            content: [
                {
                    type: "text",
                    text: job.error ??
                        `${job.provider.displayName} job ${job.id} was cancelled.`,
                },
            ],
        };
    }
    buildJobResponse(job, waitMs) {
        switch (job.status) {
            case "completed":
                return this.buildCompletedJobResponse(job);
            case "running":
                return this.buildRunningJobResponse(job, waitMs);
            case "cancelled":
                return this.buildCancelledJobResponse(job);
            case "failed":
                throw new McpError(ErrorCode.InternalError, job.error ??
                    `${job.provider.displayName} job ${job.id} failed without an error message.`);
        }
        throw new McpError(ErrorCode.InternalError, `Unknown job status for ${job.id}.`);
    }
    setupToolHandlers() {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: unifiedToolName,
                    description: buildUnifiedToolDescription(this.availableProviders, {
                        opencodeProbe: this.opencodeProbe,
                    }),
                    inputSchema: {
                        type: "object",
                        properties: {
                            provider: {
                                type: "string",
                                enum: this.availableProviders.map((provider) => provider.toolName),
                                description: providerDescription,
                            },
                            prompt: {
                                type: "string",
                                description: "The detailed natural language prompt for a new job. Provide this together with provider.",
                            },
                            model: {
                                type: "string",
                                description: modelDescription,
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
                        required: [],
                    },
                },
            ],
        }));
        this.server.setRequestHandler(CallToolRequestSchema, async (args, extra) => {
            debugLog("[Debug] Handling CallToolRequest:", args);
            const toolName = args.params.name;
            if (toolName !== unifiedToolName) {
                throw new McpError(ErrorCode.MethodNotFound, `Tool ${toolName} not found`);
            }
            const parsedArguments = parseToolArguments(providerToolArgumentsSchema, args.params.arguments, toolName);
            let job;
            let provider;
            let stopProgressHeartbeat;
            try {
                if (parsedArguments.jobId) {
                    job = this.getJobOrThrow(parsedArguments.jobId);
                    provider = job.provider;
                }
                else {
                    provider = this.getProviderOrThrow(parsedArguments.provider);
                    this.validateProviderSpecificArguments(provider, parsedArguments);
                    const effectiveCwd = resolveWorkingDirectory(parsedArguments.workFolder);
                    const executionTimeoutMs = resolveExecutionTimeoutMs(parsedArguments.timeoutMs);
                    debugLog(`[Debug] Starting ${provider.displayName} job with prompt: "${parsedArguments.prompt}" in CWD: "${effectiveCwd}" (timeout: ${formatTimeoutMs(executionTimeoutMs)})`);
                    job = this.startJob(provider, parsedArguments.prompt, effectiveCwd, executionTimeoutMs, parsedArguments.model);
                }
                stopProgressHeartbeat = startProgressHeartbeat(extra, provider.displayName);
                if (parsedArguments.cancel) {
                    this.cancelJob(job, `${provider.displayName} job ${job.id} was cancelled by request.`);
                }
                await this.waitForJob(job, parsedArguments.waitMs ?? defaultJobWaitMs, extra?.signal);
                return this.buildJobResponse(job, parsedArguments.waitMs ?? defaultJobWaitMs);
            }
            catch (error) {
                if (extra?.signal?.aborted) {
                    debugLog("[Debug] agent tool request was cancelled by the client.");
                    throw error;
                }
                debugLog("[Error] Error executing agent tool:", error);
                if (error?.code === ErrorCode.InternalError ||
                    error?.code === ErrorCode.InvalidParams ||
                    error?.code === ErrorCode.MethodNotFound) {
                    throw error;
                }
                throw new McpError(ErrorCode.InternalError, error.message || "Unknown agent tool error");
            }
            finally {
                stopProgressHeartbeat?.();
            }
        });
    }
    /**
     * Start the MCP server.
     */
    async run() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error("agent-mcp server running on stdio");
    }
}
export const ClaudeCodeServer = AgentCliServer;
function isDirectExecution() {
    const entryPoint = process.argv[1];
    if (typeof entryPoint !== "string" || entryPoint.length === 0) {
        return false;
    }
    try {
        const resolvedEntryPoint = realpathSync(entryPoint);
        if (typeof resolvedEntryPoint !== "string" ||
            resolvedEntryPoint.length === 0) {
            return false;
        }
        return import.meta.url === pathToFileURL(resolvedEntryPoint).href;
    }
    catch {
        return false;
    }
}
if (isDirectExecution()) {
    const server = new AgentCliServer();
    server.run().catch(console.error);
}
