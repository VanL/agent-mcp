import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

/**
 * Mock Qwen CLI for testing.
 */
export class QwenMock {
  private mockPath: string;

  constructor(binaryName: string = 'qwen') {
    this.mockPath = join('/tmp', 'agent-cli-test-mock', binaryName);
  }

  async setup(): Promise<void> {
    const dir = dirname(this.mockPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const mockScript = `#!/bin/bash
# Mock Qwen CLI for testing

prompt=""
capture_prompt=false

while [[ $# -gt 0 ]]; do
  case $1 in
    -y|-o)
      shift
      if [[ "$1" == "text" ]]; then
        shift
      fi
      ;;
    --)
      capture_prompt=true
      shift
      ;;
    *)
      if [[ "$capture_prompt" == true ]]; then
        prompt="$1"
      fi
      shift
      ;;
  esac
done

if [[ "$prompt" == *"create"* ]] || [[ "$prompt" == *"Create"* ]]; then
  echo "Created file successfully"
elif [[ "$prompt" == *"git"* ]] && [[ "$prompt" == *"commit"* ]]; then
  echo "Committed changes successfully"
elif [[ "$prompt" == *"error"* ]]; then
  echo "Error: Mock error response" >&2
  exit 1
else
  echo "Command executed successfully"
fi
`;

    writeFileSync(this.mockPath, mockScript);
    const { chmod } = await import('node:fs/promises');
    await chmod(this.mockPath, 0o755);
  }

  async cleanup(): Promise<void> {
    const { rm } = await import('node:fs/promises');
    await rm(this.mockPath, { force: true });
  }
}
