# agent-mcp

<img src="assets/claude_code_mcp_logo.png" alt="agent-mcp logo">

[![npm package](https://img.shields.io/npm/v/agent-mcp)](https://www.npmjs.com/package/agent-mcp)
[![View changelog](https://img.shields.io/badge/Explore%20Changelog-brightgreen)](/CHANGELOG.md)

An MCP (Model Context Protocol) server that exposes a single MCP tool backed by multiple agent CLIs and runs them through one shared async job path.

Did you notice that Cursor sometimes struggles with complex, multi-step edits or operations? This server exposes one provider-backed MCP tool that can target `claude_code`, `codex`, `gemini`, `opencode`, or `qwen`, keeping the adapter layer extensible while avoiding long synchronous calls that hit client timeouts.

<img src="assets/screenshot.png" width="300" alt="Screenshot">

## Overview

This MCP server provides one provider-backed tool that can be used by LLMs to interact with agent CLIs. When integrated with Claude Desktop or other MCP clients, it allows LLMs to:

- Run Claude Code with `--dangerously-skip-permissions`
- Run Codex with `codex exec --dangerously-bypass-approvals-and-sandbox`
- Run Gemini with `gemini -p ... -y -o text`
- Run OpenCode with `opencode run --format json --dangerously-skip-permissions`
- Run Qwen with `qwen -p ... -y -o text`
- Add more providers by extending the registry in [`src/server.ts`](./src/server.ts)
- Access file editing capabilities directly
- Keep provider-specific execution details in one place

## Benefits

- LLM clients often struggle with longer file edits, git operations, and repo workflows. This server lets them hand those jobs to purpose-built agent CLIs.
- Claude Code, Codex, Gemini, OpenCode, and Qwen are available through one MCP tool, so clients can switch providers without standing up separate adapters.
- Multiple commands can be queued instead of direct execution. This saves context space so more important stuff is retained longer and fewer compacts happen.
- File ops, git, and shell work do not need your primary chat model. You can route work to the provider that fits best and keep the adapter layer extensible.
- Agents in Agents rules.

<img src="assets/agents_in_agents_meme.jpg" alt="Agents in Agents Meme">

## Prerequisites

- Node.js v20 or later (Use fnm or nvm to install)
- Claude CLI installed locally if you want to use `claude_code`
- Codex CLI installed locally if you want to use `codex`
- Gemini CLI installed locally if you want to use `gemini`
- OpenCode CLI installed locally if you want to use `opencode`
- Qwen CLI installed locally if you want to use `qwen`

When `agent-mcp` starts, it only exposes the unified `agent` tool if at least one provider CLI can be resolved to a real executable. It prefers absolute paths discovered during install, then any absolute path overrides you provide in config.

## Configuration

### Environment Variables

- `CLAUDE_CLI_NAME`: Override the Claude CLI binary name or provide an absolute path (default: `claude`). Absolute paths are the most reliable option in GUI MCP clients, because those clients often launch the server with a minimal PATH.
  - Using custom Claude CLI wrappers
  - Testing with mocked binaries
  - Running multiple Claude CLI versions side by side

  Supported formats:
  - Simple name: `CLAUDE_CLI_NAME=claude-custom` or `CLAUDE_CLI_NAME=claude-v2`
  - Absolute path: `CLAUDE_CLI_NAME=/path/to/custom/claude`

  Relative paths (e.g., `./claude` or `../claude`) are not allowed and will throw an error.

- `CODEX_CLI_NAME`: Override the Codex CLI binary name or provide an absolute path (default: `codex`).
  - Simple name: `CODEX_CLI_NAME=codex-nightly`
  - Absolute path: `CODEX_CLI_NAME=/path/to/custom/codex`
  - Relative paths are rejected, the same as `CLAUDE_CLI_NAME`

- `GEMINI_CLI_NAME`: Override the Gemini CLI binary name or provide an absolute path (default: `gemini`).
  - Simple name: `GEMINI_CLI_NAME=gemini-nightly`
  - Absolute path: `GEMINI_CLI_NAME=/path/to/custom/gemini`
  - Relative paths are rejected, the same as `CLAUDE_CLI_NAME`

- `OPENCODE_CLI_NAME`: Override the OpenCode CLI binary name or provide an absolute path (default: `opencode`).
  - Simple name: `OPENCODE_CLI_NAME=opencode-nightly`
  - Absolute path: `OPENCODE_CLI_NAME=/path/to/custom/opencode`
  - Relative paths are rejected, the same as `CLAUDE_CLI_NAME`

- `QWEN_CLI_NAME`: Override the Qwen CLI binary name or provide an absolute path (default: `qwen`).
  - Simple name: `QWEN_CLI_NAME=qwen-preview`
  - Absolute path: `QWEN_CLI_NAME=/path/to/custom/qwen`
  - Relative paths are rejected, the same as `CLAUDE_CLI_NAME`

- `OPENCODE_MODEL`: Optional default model override for the `opencode` provider. `agent-mcp` passes it as `opencode run --model <value>`.

- `AGENT_MCP_EXECUTION_TIMEOUT_MS`: Default server-side timeout for provider CLI executions in milliseconds (default: `300000`, or 5 minutes). Set to `0` to disable the adapter timeout entirely for long-running jobs.

- `AGENT_MCP_CLAUDE_MINIMAL_MODE`, `AGENT_MCP_CODEX_MINIMAL_MODE`, `AGENT_MCP_GEMINI_MINIMAL_MODE`, `AGENT_MCP_OPENCODE_MINIMAL_MODE`, `AGENT_MCP_QWEN_MINIMAL_MODE`: Control whether `agent-mcp` runs each provider in a minimal provider-local mode by default. The default is `true` for all of them. Set any of these to `false` to preserve the provider's normal user-level config for that provider.

- `AGENT_MCP_CODEX_ALLOWED_MCP_SERVERS`: Optional comma-separated allowlist of Codex MCP server names to keep enabled while Codex minimal mode is on. By default, `agent-mcp` disables all Codex MCP servers declared in `~/.codex/config.toml` for delegated runs.

- `MCP_CLAUDE_DEBUG`: Enable verbose debug logging for the server and all configured providers.

## Installation & Usage

The recommended way to use this server is by installing it by using `npx`.

```json
    "agent-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "agent-mcp@latest"
      ]
    },
```

To use a custom provider CLI binary name, you can specify the relevant environment variable:

```json
    "agent-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "agent-mcp@latest"
      ],
      "env": {
        "CLAUDE_CLI_NAME": "claude-custom"
      }
    },
```

To expose Claude Code, Codex, Gemini, OpenCode, and Qwen with custom binaries:

```json
    "agent-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "agent-mcp@latest"
      ],
      "env": {
        "CLAUDE_CLI_NAME": "claude-custom",
        "CODEX_CLI_NAME": "codex",
        "GEMINI_CLI_NAME": "gemini",
        "OPENCODE_CLI_NAME": "opencode",
        "QWEN_CLI_NAME": "qwen"
      }
    },
```

If you prefer Bun and want the package source to come directly from GitHub instead of npm, install it from the repository and trust it so Bun can run the package build during install:

```bash
bun add -g --trust agent-mcp@github:VanL/agent-mcp
```

For GitHub or Bun installs, run the install command from a shell where the provider CLIs you want are already in `PATH`. The install step records exact CLI paths, and the server later uses those absolute paths even if the MCP client launches it with a minimal environment.

To update a Bun global install that uses the GitHub source:

```bash
bun add -g --trust agent-mcp@github:VanL/agent-mcp
```

## Important First-Time Setup: Accepting Permissions

Before the MCP server can successfully use a provider tool, run that provider's CLI manually once, authenticate, and accept any required terms or bypass warnings.

### Claude Code

```bash
npm install -g @anthropic-ai/claude-code
```

```bash
claude --dangerously-skip-permissions
```

### Codex

```bash
codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check "hello"
```

### Gemini

```bash
gemini -p "hello" -y -o text
```

### OpenCode

```bash
opencode run --format json --dangerously-skip-permissions --dir "$PWD" "hello"
```

### Qwen

```bash
qwen -p "hello" -y -o text
```

Follow the prompts to accept. Once this is done, the MCP server will be able to use the provider non-interactively.

macOS might ask for all kind of folder permissions the first time the tool runs and the first run then fails. Subsequent runs will work.

## Connecting to Your MCP Client

After setting up the server, you need to configure your MCP client (like Cursor or others that use `mcp.json` or `mcp_config.json`).

### MCP Configuration File

The configuration is typically done in a JSON file. The name and location can vary depending on your client.

#### Cursor

Cursor uses `mcp.json`.

- **macOS:** `~/.cursor/mcp.json`
- **Windows:** `%APPDATA%\\Cursor\\mcp.json`
- **Linux:** `~/.config/cursor/mcp.json`

#### Windsurf

Windsurf users use `mcp_config.json`

- **macOS:** `~/.codeium/windsurf/mcp_config.json`
- **Windows:** `%APPDATA%\\Codeium\\windsurf\\mcp_config.json`
- **Linux:** `~/.config/.codeium/windsurf/mcp_config.json`

(Note: In some mixed setups, if Cursor is also installed, these clients might fall back to using Cursor's `~/.cursor/mcp.json` path. Prioritize the Codeium-specific paths if using the Codeium extension.)

Create this file if it doesn't exist. Add or update the configuration for your MCP server entry:

## Tools Provided

This server exposes one provider-backed tool, but only if at least one provider CLI executable was found:

### `agent`

Runs a provider-backed coding agent through one shared async job path. The server waits for a short period in each MCP call and returns the final result if the job finishes quickly. If it is still running, it returns a `jobId` that you can pass back to the same tool to keep waiting or cancel.

By default, providers are launched in a minimal provider-local mode to avoid inherited MCP, plugin, or extension startup from the main user profile. This keeps delegated runs focused on the requested task and reduces timeout risk from unrelated provider bootstrapping.

**Arguments:**

- `provider` (string, required when starting): One of `claude_code`, `codex`, `gemini`, `opencode`, or `qwen`.
- `prompt` (string, required when starting): The prompt to send to the selected provider.
- `model` (string, optional): Per-call model override in `provider/model` form. Currently supported by `gemini` and `opencode`.
- `workFolder` (string, optional): Absolute working directory to use for file, git, and shell work when starting a new job.
- `timeoutMs` (integer, optional): Maximum server-side execution time in milliseconds for the provider job. Set to `0` to disable the timeout for that job.
- `waitMs` (integer, optional): How long this MCP call should wait before returning. Defaults to `25000`.
- `jobId` (string, optional): Existing job ID to keep waiting on or cancel. Use this instead of `provider` and `prompt`.
- `cancel` (boolean, optional): Set to `true` together with `jobId` to cancel an existing job.

**Example MCP Request:**

```json
{
  "toolName": "agent-mcp:agent",
  "arguments": {
    "provider": "codex",
    "prompt": "Refactor the function foo in main.py to be async.",
    "timeoutMs": 0,
    "waitMs": 25000
  }
}
```

### Examples

Here are some visual examples of the server in action:

<img src="assets/claude_tool_git_example.png" alt="Claude Tool Git Example" width="50%">

<img src="assets/additional_claude_screenshot.png" alt="Additional Claude Screenshot" width="50%">

<img src="assets/cursor-screenshot.png" alt="Cursor Screenshot" width="50%">

### Fixing ESLint Setup

Here's an example of using agent-mcp to interactively fix an ESLint setup by deleting old configuration files and creating a new one:

<img src="assets/eslint_example.png" alt="ESLint file operations example" width="50%">

### Listing Files Example

Here's an example of the Claude Code tool listing files in a directory:

<img src="assets/file_list_example.png" alt="File listing example" width="50%">

## Key Use Cases

This server, through its provider-backed tools, unlocks a wide range of capabilities by giving your AI direct access to agent CLIs. Here are some examples of what you can achieve:

1.  **Code Generation, Analysis & Refactoring:**
    - `"Generate a Python script to parse CSV data and output JSON."`
    - `"Analyze my_script.py for potential bugs and suggest improvements."`

2.  **File System Operations (Create, Read, Edit, Manage):**
    - **Creating Files:** `"Your work folder is /Users/you/my_project\n\nCreate a new file named 'config.yml' in the 'app/settings' directory with the following content:\nport: 8080\ndatabase: main_db"`
    - **Editing Files:** `"Your work folder is /Users/you/my_project\n\nEdit file 'public/css/style.css': Add a new CSS rule at the end to make all 'h2' elements have a 'color: navy'."`
    - **Moving/Copying/Deleting:** `"Your work folder is /Users/you/my_project\n\nMove the file 'report.docx' from the 'drafts' folder to the 'final_reports' folder and rename it to 'Q1_Report_Final.docx'."`

3.  **Version Control (Git):**
    - `"Your work folder is /Users/you/my_project\n\n1. Stage the file 'src/main.java'.\n2. Commit the changes with the message 'feat: Implement user authentication'.\n3. Push the commit to the 'develop' branch on origin."`

4.  **Running Terminal Commands:**
    - `"Your work folder is /Users/you/my_project/frontend\n\nRun the command 'npm run build'."`
    - `"Open the URL https://developer.mozilla.org in my default web browser."`

5.  **Web Search & Summarization:**
    - `"Search the web for 'benefits of server-side rendering' and provide a concise summary."`

6.  **Complex Multi-Step Workflows:**
    - Automate version bumps, update changelogs, and tag releases: `"Your work folder is /Users/you/my_project\n\nFollow these steps: 1. Update the version in package.json to 2.5.0. 2. Add a new section to CHANGELOG.md for version 2.5.0 with the heading '### Added' and list 'New feature X'. 3. Stage package.json and CHANGELOG.md. 4. Commit with message 'release: version 2.5.0'. 5. Push the commit. 6. Create and push a git tag v2.5.0."`

    <img src="assets/multistep_example.png" alt="Complex multi-step operation example" width="50%">

7.  **Repairing Files with Syntax Errors:**
    - `"Your work folder is /path/to/project\n\nThe file 'src/utils/parser.js' has syntax errors after a recent complex edit that broke its structure. Please analyze it, identify the syntax errors, and correct the file to make it valid JavaScript again, ensuring the original logic is preserved as much as possible."`

8.  **Interacting with GitHub (e.g., Creating a Pull Request):**
    - `"Your work folder is /Users/you/my_project\n\nCreate a GitHub Pull Request in the repository 'owner/repo' from the 'feature-branch' to the 'main' branch. Title: 'feat: Implement new login flow'. Body: 'This PR adds a new and improved login experience for users.'"`

9.  **Interacting with GitHub (e.g., Checking PR CI Status):**
    - `"Your work folder is /Users/you/my_project\n\nCheck the status of CI checks for Pull Request #42 in the GitHub repository 'owner/repo'. Report if they have passed, failed, or are still running."`

### Correcting GitHub Actions Workflow

<img src="assets/github_actions_fix_example.png" alt="GitHub Actions workflow fix example" width="50%">

### Complex Multi-Step Operations

This example illustrates `claude_code` handling a more complex, multi-step task, such as preparing a release by creating a branch, updating multiple files (`package.json`, `CHANGELOG.md`), committing changes, and initiating a pull request, all within a single, coherent operation.

<img src="assets/claude_code_multistep_example.png" alt="Claude Code multi-step example" width="50%">

**CRITICAL: Remember to provide Current Working Directory (CWD) context in your prompts for file system or git operations (e.g., `"Your work folder is /path/to/project\n\n...your command..."`).**

## Extending Providers

The server is now organized around a provider registry in [`src/server.ts`](./src/server.ts). To add another provider such as Qwen or Gemini:

1. Add a new provider config with a `toolName`, `cliEnvVar`, and `buildInvocation` function.
2. If the CLI needs structured output capture, add an `extractOutput` function.
3. Add mock coverage in `src/__tests__/utils/` and extend the tests for the unified `agent` tool.

## Troubleshooting

- **"Command not found" (`agent-mcp`):** If installed globally, ensure the npm global bin directory is in your system's PATH. If using `npx`, ensure `npx` itself is working.
- **"Command not found" (provider CLI):** Ensure the underlying CLI is installed correctly and that `CLAUDE_CLI_NAME`, `CODEX_CLI_NAME`, `GEMINI_CLI_NAME`, `OPENCODE_CLI_NAME`, or `QWEN_CLI_NAME` points to a valid executable when overridden.
- **OpenCode model overrides fail:** `opencode models` shows the local model catalog, but not every catalog entry is guaranteed to be usable with your current auth. Use the default model if you want the least-surprising path, or pass `model` explicitly when you know the target provider is configured.
- **Long-running jobs time out:** The provider runtime timeout and the MCP client request timeout are different. `timeoutMs` and `AGENT_MCP_EXECUTION_TIMEOUT_MS` only control the server-side provider job timeout. The unified `agent` tool now runs jobs in the background and waits only up to `waitMs` per MCP call, which avoids hard client limits on a single synchronous `tools/call`. If your client is especially strict, lower `waitMs` and keep polling with `jobId`.
- **Permissions Issues:** Make sure you've run the "Important First-Time Setup" step.
- **JSON Errors from Server:** If `MCP_CLAUDE_DEBUG` is `true`, error messages or logs might interfere with MCP's JSON parsing. Set to `false` for normal operation.
- **ESM/Import Errors:** Ensure you are using Node.js v20 or later.

**For Developers: Local Setup & Contribution**

If you want to develop or contribute to this server, or run it from a cloned repository for testing, please see our [Local Installation & Development Setup Guide](./docs/local_install.md).

## Testing

The project includes comprehensive test suites:

```bash
# Run all tests
npm test

# Run unit tests only
npm run test:unit

# Run e2e tests (with mocks)
npm run test:e2e

# Run e2e tests locally (requires Claude CLI)
npm run test:e2e:local

# Watch mode for development
npm run test:watch

# Coverage report
npm run test:coverage
```

For detailed testing documentation, see our [E2E Testing Guide](./docs/e2e-testing.md).

## Configuration via Environment Variables

The server's behavior can be customized using these environment variables:

- `CLAUDE_CLI_NAME`, `CODEX_CLI_NAME`, `GEMINI_CLI_NAME`, `OPENCODE_CLI_NAME`, `QWEN_CLI_NAME`: Override the executable name or provide an absolute path for each provider CLI.
- `OPENCODE_MODEL`: Set the default OpenCode model override in `provider/model` form.
- `AGENT_MCP_EXECUTION_TIMEOUT_MS`: Set the default server-side execution timeout in milliseconds for all provider tool calls. Use `0` to disable the adapter timeout.
- `AGENT_MCP_CLAUDE_MINIMAL_MODE`, `AGENT_MCP_CODEX_MINIMAL_MODE`, `AGENT_MCP_GEMINI_MINIMAL_MODE`, `AGENT_MCP_OPENCODE_MINIMAL_MODE`, `AGENT_MCP_QWEN_MINIMAL_MODE`: Set any of these to `false` if you want a provider to keep its normal user-level config during delegated runs.
- `AGENT_MCP_CODEX_ALLOWED_MCP_SERVERS`: Comma-separated allowlist of Codex MCP server names to keep enabled while Codex minimal mode stays on.
- `MCP_CLAUDE_DEBUG`: Set to `true` for verbose debug logging from this MCP server. Default: `false`.
- Provider-specific auth variables such as `GEMINI_API_KEY` or `OPENROUTER_API_KEY` should be passed through the MCP server environment when the underlying CLI requires them.

These can be set in your shell environment or within the `env` block of your `mcp.json` server configuration (though the `env` block in `mcp.json` examples was removed for simplicity, it's still a valid way to set them for the server process if needed).

## Contributing

Contributions are welcome! Please refer to the [Local Installation & Development Setup Guide](./docs/local_install.md) for details on setting up your environment.

Submit issues and pull requests to the [GitHub repository](https://github.com/VanL/agent-mcp).

## License

MIT
