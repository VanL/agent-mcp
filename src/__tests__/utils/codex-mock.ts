import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

/**
 * Mock Codex CLI for testing.
 */
export class CodexMock {
  private mockPath: string;

  constructor(binaryName: string = "codex") {
    this.mockPath = join("/tmp", "agent-cli-test-mock", binaryName);
  }

  async setup(): Promise<void> {
    const dir = dirname(this.mockPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const mockScript = `#!/bin/bash
# Mock Codex CLI for testing

prompt=""
output_file=""

while [[ $# -gt 0 ]]; do
  case $1 in
    exec|--dangerously-bypass-approvals-and-sandbox|--skip-git-repo-check)
      shift
      ;;
    -C|-o|--color)
      if [[ "$1" == "-o" ]]; then
        output_file="$2"
      fi
      shift 2
      ;;
    *)
      prompt="$1"
      shift
      ;;
  esac
done

if [[ "$prompt" == *"create"* ]] || [[ "$prompt" == *"Create"* ]]; then
  response="Created file successfully"
elif [[ "$prompt" == *"git"* ]] && [[ "$prompt" == *"commit"* ]]; then
  response="Committed changes successfully"
elif [[ "$prompt" == *"error"* ]]; then
  echo "Error: Mock error response" >&2
  exit 1
else
  response="Command executed successfully"
fi

echo "$response"

if [[ -n "$output_file" ]]; then
  printf "%s" "$response" > "$output_file"
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
