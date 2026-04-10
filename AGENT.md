# AGENT.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Purpose

This is the source code for `agent-mcp` - a provider-backed MCP server that allows running agent CLIs like Claude Code and Codex in one-shot mode with permissions bypassed automatically. When you're asked to edit the tool descriptions or provider behavior, update `src/server.ts`.

## Key Files

- `src/server.ts`: The main server implementation containing the provider registry, tool descriptions, and CLI execution behavior
- `package.json`: Package configuration and dependencies
- `start.sh`/`start.bat`: Scripts to start the server

## Development Commands

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Start the server
npm run start

# Development mode with auto-reloading
npm run dev
```

## Tool Description

The tool descriptions live in `src/server.ts`. When asked to update a tool description or add a new provider, update the provider registry and the generated descriptions in `setupToolHandlers`.

## Architecture Notes

- This MCP server provides multiple tools, currently including `claude_code` and `codex`
- The server handles execution via the `spawnAsync` function and provider-specific invocation builders
- Error handling and timeout management are implemented for reliability
- Working directory can be specified via the `workFolder` parameter

## Environment Variables

- `CLAUDE_CLI_NAME`: Override the Claude CLI executable name or absolute path
- `CODEX_CLI_NAME`: Override the Codex CLI executable name or absolute path
- `MCP_CLAUDE_DEBUG`: Set to `true` for verbose debug logging

## Best Practices

- Always test changes locally before committing
- Maintain compatibility with the Model Context Protocol spec
- Keep error messages informative for troubleshooting
- Document any changes to the API or configuration options
- Pure updates to the readme and/or adding new images do not require a version bump.
- **Comprehensive Staging for README Image Updates:** When updating `README.md` to include new images, ensure that prompts for `claude_code` explicitly instruct it to stage _both_ the modified `README.md` file _and_ all new image files (e.g., from the `assets/` directory). Committing the `README.md` without its new image assets is a common pitfall.
- **Clarity in Multi-Step Git Prompts:** For complex, multi-step `claude_code` prompts involving Git operations (like creating branches, committing multiple files, and pushing/creating PRs):
  - Clearly list all files to be staged in the commit (text files, new image assets, etc.).
- **Automatic Push on PR Branches:** When the user asks to commit changes while on a pull request branch, Claude should automatically push the changes to the remote after committing. This ensures PR updates are immediately visible for review.
