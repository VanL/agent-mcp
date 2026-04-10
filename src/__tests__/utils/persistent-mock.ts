import { ClaudeMock } from "./claude-mock.js";
import { CodexMock } from "./codex-mock.js";
import { GeminiMock } from "./gemini-mock.js";
import { QwenMock } from "./qwen-mock.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

let sharedMock: ClaudeMock | null = null;
let sharedCodexMock: CodexMock | null = null;
let sharedGeminiMock: GeminiMock | null = null;
let sharedQwenMock: QwenMock | null = null;

export async function getSharedMock(): Promise<ClaudeMock> {
  if (!sharedMock) {
    sharedMock = new ClaudeMock("claudeMocked");
  }

  // Always ensure mock exists
  const mockPath = join("/tmp", "agent-cli-test-mock", "claudeMocked");
  if (!existsSync(mockPath)) {
    console.error(`[DEBUG] Mock not found at ${mockPath}, creating it...`);
    await sharedMock.setup();
  } else {
    console.error(`[DEBUG] Mock already exists at ${mockPath}`);
  }

  return sharedMock;
}

export async function getSharedCodexMock(): Promise<CodexMock> {
  if (!sharedCodexMock) {
    sharedCodexMock = new CodexMock("codexMocked");
  }

  const mockPath = join("/tmp", "agent-cli-test-mock", "codexMocked");
  if (!existsSync(mockPath)) {
    console.error(`[DEBUG] Mock not found at ${mockPath}, creating it...`);
    await sharedCodexMock.setup();
  } else {
    console.error(`[DEBUG] Mock already exists at ${mockPath}`);
  }

  return sharedCodexMock;
}

export async function getSharedGeminiMock(): Promise<GeminiMock> {
  if (!sharedGeminiMock) {
    sharedGeminiMock = new GeminiMock("geminiMocked");
  }

  const mockPath = join("/tmp", "agent-cli-test-mock", "geminiMocked");
  if (!existsSync(mockPath)) {
    console.error(`[DEBUG] Mock not found at ${mockPath}, creating it...`);
    await sharedGeminiMock.setup();
  } else {
    console.error(`[DEBUG] Mock already exists at ${mockPath}`);
  }

  return sharedGeminiMock;
}

export async function getSharedQwenMock(): Promise<QwenMock> {
  if (!sharedQwenMock) {
    sharedQwenMock = new QwenMock("qwenMocked");
  }

  const mockPath = join("/tmp", "agent-cli-test-mock", "qwenMocked");
  if (!existsSync(mockPath)) {
    console.error(`[DEBUG] Mock not found at ${mockPath}, creating it...`);
    await sharedQwenMock.setup();
  } else {
    console.error(`[DEBUG] Mock already exists at ${mockPath}`);
  }

  return sharedQwenMock;
}

export async function cleanupSharedMock(): Promise<void> {
  if (sharedMock) {
    await sharedMock.cleanup();
    sharedMock = null;
  }
  if (sharedCodexMock) {
    await sharedCodexMock.cleanup();
    sharedCodexMock = null;
  }
  if (sharedGeminiMock) {
    await sharedGeminiMock.cleanup();
    sharedGeminiMock = null;
  }
  if (sharedQwenMock) {
    await sharedQwenMock.cleanup();
    sharedQwenMock = null;
  }
}
