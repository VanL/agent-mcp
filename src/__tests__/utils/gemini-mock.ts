import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

/**
 * Mock Gemini CLI for testing.
 */
export class GeminiMock {
  private mockPath: string;

  constructor(binaryName: string = "gemini") {
    this.mockPath = join("/tmp", "agent-cli-test-mock", binaryName);
  }

  async setup(): Promise<void> {
    const dir = dirname(this.mockPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const mockScript = `#!/bin/bash
# Mock Gemini CLI for testing

prompt=""

while [[ $# -gt 0 ]]; do
  case $1 in
    -p|--prompt|-o|--output-format)
      if [[ "$1" == "-p" ]] || [[ "$1" == "--prompt" ]]; then
        prompt="$2"
      fi
      shift 2
      ;;
    -y|--yolo)
      shift
      ;;
    *)
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
    const { chmod } = await import("node:fs/promises");
    await chmod(this.mockPath, 0o755);
  }

  async cleanup(): Promise<void> {
    const { rm } = await import("node:fs/promises");
    await rm(this.mockPath, { force: true });
  }
}
