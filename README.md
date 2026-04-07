# agent-mcp

<img src="assets/claude_code_mcp_logo.png" alt="agent-mcp logo">

[![npm package](https://img.shields.io/npm/v/agent-mcp)](https://www.npmjs.com/package/agent-mcp)
[![View changelog](https://img.shields.io/badge/Explore%20Changelog-brightgreen)](/CHANGELOG.md)

An MCP (Model Context Protocol) server that allows running agent CLIs in one-shot mode with permissions bypassed automatically.

Did you notice that Cursor sometimes struggles with complex, multi-step edits or operations? This server exposes provider-backed MCP tools such as `claude_code`, `codex`, `gemini`, and `qwen`, making those agents directly available for coding tasks while keeping the adapter layer extensible for future CLIs.

<img src="assets/screenshot.png" width="300" alt="Screenshot">

## Overview

This MCP server provides multiple provider-backed tools that can be used by LLMs to interact with agent CLIs. When integrated with Claude Desktop or other MCP clients, it allows LLMs to:

- Run Claude Code with `--dangerously-skip-permissions`
- Run Codex with `codex exec --dangerously-bypass-approvals-and-sandbox`
- Run Gemini with `gemini -p ... -y -o text`
- Run Qwen with `qwen -p ... -y -o text`
- Add more providers by extending the registry in [`src/server.ts`](./src/server.ts)
- Access file editing capabilities directly
- Keep provider-specific execution details in one place

## Benefits

- Claude/Windsurf often have trouble editing files. Claude Code is better and faster at it.
- Codex, Gemini, and Qwen are now available through the same MCP server, so clients can offload tasks without a second server process.
- Multiple commands can be queued instead of direct execution. This saves context space so more important stuff is retained longer, fewer compacts happen.
- File ops, git, or other operations don't need costy models. You can route work to Claude Code, Codex, Gemini, Qwen, and future providers as needed.
- Claude has wider system access and can do things that Cursor/Windsurf can't do (or believe they can't), so whenever they are stuck just ask them "use claude code" and it will usually un-stuck them.
- Agents in Agents rules.

<img src="assets/agents_in_agents_meme.jpg" alt="Agents in Agents Meme">

## Prerequisites

- Node.js v20 or later (Use fnm or nvm to install)
- Claude CLI installed locally if you want to use `claude_code`
- Codex CLI installed locally if you want to use `codex`
- Gemini CLI installed locally if you want to use `gemini`
- Qwen CLI installed locally if you want to use `qwen`

## Configuration

### Environment Variables

- `CLAUDE_CLI_NAME`: Override the Claude CLI binary name or provide an absolute path (default: `claude`). This allows you to use a custom Claude CLI binary. This is useful for:
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

- `QWEN_CLI_NAME`: Override the Qwen CLI binary name or provide an absolute path (default: `qwen`).
  - Simple name: `QWEN_CLI_NAME=qwen-preview`
  - Absolute path: `QWEN_CLI_NAME=/path/to/custom/qwen`
  - Relative paths are rejected, the same as `CLAUDE_CLI_NAME`

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

To use a custom Claude CLI binary name, you can specify the environment variable:

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

To expose Claude Code, Codex, Gemini, and Qwen with custom binaries:

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
        "QWEN_CLI_NAME": "qwen"
      }
    },
```

If you prefer Bun and want the package source to come directly from GitHub instead of npm, install it from the repository and trust it so Bun can run the package build during install:

```bash
bun add -g --trust agent-mcp@github:VanL/agent-mcp
```

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

This server exposes provider-backed tools:

### `claude_code`

Executes a prompt directly using the Claude Code CLI with `--dangerously-skip-permissions`.

**Arguments:**
- `prompt` (string, required): The prompt to send to Claude Code.
- `workFolder` (string, optional): Absolute working directory to use for file, git, and shell work.

### `codex`

Executes a prompt directly using `codex exec --dangerously-bypass-approvals-and-sandbox`.

**Arguments:**
- `prompt` (string, required): The prompt to send to Codex.
- `workFolder` (string, optional): Absolute working directory to use for file, git, and shell work.

### `gemini`

Executes a prompt directly using `gemini -p ... -y -o text`.

**Arguments:**
- `prompt` (string, required): The prompt to send to Gemini.
- `workFolder` (string, optional): Absolute working directory to use for file, git, and shell work.

### `qwen`

Executes a prompt directly using `qwen -p ... -y -o text`.

**Arguments:**
- `prompt` (string, required): The prompt to send to Qwen.
- `workFolder` (string, optional): Absolute working directory to use for file, git, and shell work.

**Example MCP Request:**
```json
{
  "toolName": "agent-mcp:claude_code",
  "arguments": {
    "prompt": "Refactor the function foo in main.py to be async."
  }
}
```

You can call the other providers the same way by switching `toolName` to `agent-mcp:codex`, `agent-mcp:gemini`, or `agent-mcp:qwen`.

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
    -   `"Generate a Python script to parse CSV data and output JSON."`
    -   `"Analyze my_script.py for potential bugs and suggest improvements."`

2.  **File System Operations (Create, Read, Edit, Manage):**
    -   **Creating Files:** `"Your work folder is /Users/steipete/my_project\n\nCreate a new file named 'config.yml' in the 'app/settings' directory with the following content:\nport: 8080\ndatabase: main_db"`
    -   **Editing Files:** `"Your work folder is /Users/steipete/my_project\n\nEdit file 'public/css/style.css': Add a new CSS rule at the end to make all 'h2' elements have a 'color: navy'."`
    -   **Moving/Copying/Deleting:** `"Your work folder is /Users/steipete/my_project\n\nMove the file 'report.docx' from the 'drafts' folder to the 'final_reports' folder and rename it to 'Q1_Report_Final.docx'."`

3.  **Version Control (Git):**
    -   `"Your work folder is /Users/steipete/my_project\n\n1. Stage the file 'src/main.java'.\n2. Commit the changes with the message 'feat: Implement user authentication'.\n3. Push the commit to the 'develop' branch on origin."`

4.  **Running Terminal Commands:**
    -   `"Your work folder is /Users/steipete/my_project/frontend\n\nRun the command 'npm run build'."`
    -   `"Open the URL https://developer.mozilla.org in my default web browser."`

5.  **Web Search & Summarization:**
    -   `"Search the web for 'benefits of server-side rendering' and provide a concise summary."`

6.  **Complex Multi-Step Workflows:**
    -   Automate version bumps, update changelogs, and tag releases: `"Your work folder is /Users/steipete/my_project\n\nFollow these steps: 1. Update the version in package.json to 2.5.0. 2. Add a new section to CHANGELOG.md for version 2.5.0 with the heading '### Added' and list 'New feature X'. 3. Stage package.json and CHANGELOG.md. 4. Commit with message 'release: version 2.5.0'. 5. Push the commit. 6. Create and push a git tag v2.5.0."`

    <img src="assets/multistep_example.png" alt="Complex multi-step operation example" width="50%">

7.  **Repairing Files with Syntax Errors:**
    -   `"Your work folder is /path/to/project\n\nThe file 'src/utils/parser.js' has syntax errors after a recent complex edit that broke its structure. Please analyze it, identify the syntax errors, and correct the file to make it valid JavaScript again, ensuring the original logic is preserved as much as possible."`

8.  **Interacting with GitHub (e.g., Creating a Pull Request):**
    -   `"Your work folder is /Users/steipete/my_project\n\nCreate a GitHub Pull Request in the repository 'owner/repo' from the 'feature-branch' to the 'main' branch. Title: 'feat: Implement new login flow'. Body: 'This PR adds a new and improved login experience for users.'"`

9.  **Interacting with GitHub (e.g., Checking PR CI Status):**
    -   `"Your work folder is /Users/steipete/my_project\n\nCheck the status of CI checks for Pull Request #42 in the GitHub repository 'owner/repo'. Report if they have passed, failed, or are still running."`

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
3. Add mock coverage in `src/__tests__/utils/` and extend the e2e tests with the new tool.

## Troubleshooting

- **"Command not found" (`agent-mcp`):** If installed globally, ensure the npm global bin directory is in your system's PATH. If using `npx`, ensure `npx` itself is working.
- **"Command not found" (provider CLI):** Ensure the underlying CLI is installed correctly and that `CLAUDE_CLI_NAME`, `CODEX_CLI_NAME`, `GEMINI_CLI_NAME`, or `QWEN_CLI_NAME` points to a valid executable when overridden.
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

- `CLAUDE_CLI_PATH`: Absolute path to the Claude CLI executable.
  - Default: Checks `~/.claude/local/claude`, then falls back to `claude` (expecting it in PATH).
- `MCP_CLAUDE_DEBUG`: Set to `true` for verbose debug logging from this MCP server. Default: `false`.

These can be set in your shell environment or within the `env` block of your `mcp.json` server configuration (though the `env` block in `mcp.json` examples was removed for simplicity, it's still a valid way to set them for the server process if needed).

## Contributing

Contributions are welcome! Please refer to the [Local Installation & Development Setup Guide](./docs/local_install.md) for details on setting up your environment.

Submit issues and pull requests to the [GitHub repository](https://github.com/VanL/agent-mcp).

## License

MIT
