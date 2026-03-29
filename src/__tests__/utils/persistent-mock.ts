import { ClaudeMock } from './claude-mock.js';
import { CodexMock } from './codex-mock.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

let sharedMock: ClaudeMock | null = null;
let sharedCodexMock: CodexMock | null = null;

export async function getSharedMock(): Promise<ClaudeMock> {
  if (!sharedMock) {
    sharedMock = new ClaudeMock('claudeMocked');
  }
  
  // Always ensure mock exists
  const mockPath = join('/tmp', 'agent-cli-test-mock', 'claudeMocked');
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
    sharedCodexMock = new CodexMock('codexMocked');
  }

  const mockPath = join('/tmp', 'agent-cli-test-mock', 'codexMocked');
  if (!existsSync(mockPath)) {
    console.error(`[DEBUG] Mock not found at ${mockPath}, creating it...`);
    await sharedCodexMock.setup();
  } else {
    console.error(`[DEBUG] Mock already exists at ${mockPath}`);
  }

  return sharedCodexMock;
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
}
