# Calvras agent runtime

Calvras runs workspace tools on its local Node server. The shared composer selects **Ask first**, **Work automatically**, or **Full access**. A permission request replaces the composer with a specific question and **Allow once**, **Allow for this task**, and **Deny** choices. After a decision, the conversation continues.

## Permissions

| Mode | Behavior |
| --- | --- |
| Ask first | Reads and agent bookkeeping can proceed; edits, execution, destructive operations, and external access require approval. |
| Work automatically | Routine workspace changes proceed; arbitrary shell commands, destructive operations, and external access require approval. |
| Full access | Routine workspace work and commands proceed; destructive operations and external access still require approval. |

Approval is enforced by the server before executing a tool. Once tokens are single-use and bound to the exact action. Task grants apply to the approved routine tool type; destructive and external actions retain individual approval requirements. Denying an action blocks retrying that exact action during the session. Stop aborts active commands and workers and clears outstanding approvals.

Normal file tools validate workspace paths and block secret files, traversal, and symlink escapes. Environment management exposes variable names and redacts values in results. Checkpoints and project state live outside the workspace under the user's Calvras application-data directory. Browser contexts are separated by project; navigation redirects and subresources require the approved origin unless external browser networking was explicitly authorized.

**This is not an operating-system sandbox.** Commands execute with the user's account permissions. File-tool restrictions cannot constrain arbitrary approved programs, package scripts, MCP servers, or child processes. Approve those according to their actual behavior. Checkpoints are local recovery aids, not a replacement for version control or backups.

## Agent behavior and tools

The agent works in short tool/observation cycles, streams progress and command output, retains compact context, detects repeated operations, and runs relevant verification before reporting completion. Errors return tool feedback so the next cycle can change approach. A model-generated plan, explanation, test, or refactor depends on a configured inference provider; execution results come from the corresponding real workspace tool.

The authoritative tool names and risk categories are in `src/lib/tool-catalog.ts`. Executors provide:

- File inspection, search, creation, edits, patches, formatting, multi-file changes, edit undo, checkpoints, and rollback.
- TypeScript/JavaScript AST and language-service symbol navigation, definitions, references, hover information, diagnostics, dependency mapping, import organization, and framework/project detection.
- Commands, background processes, development servers, streamed logs, dependency installation, project test/lint/typecheck/build scripts, and Git operations.
- Chromium navigation, selectors, form input, screenshots, DOM inspection, console-error collection, and responsive width/overflow measurements.
- Project memory, task lists, operation logs, model-assisted generation and explanations, documentation retrieval, approved GitHub/deployment operations, and explicitly configured MCP connections.

Project memory and unfinished task information persist locally. Active processes, browser contexts, MCP connections, and worker jobs are session resources. Restarting the app does not resume an interrupted operating-system process or restore a worker's in-flight model request. Repository `AGENTS.md` rules are included in agent context.

## Three workers

The main agent can delegate while the conversation remains available. One worker runs per role, with additional assignments queued for that role:

| Role | Assignment |
| --- | --- |
| `builder` | Implement scoped changes and verify them. |
| `verifier` | Inspect and run checks; edits require an assignment explicitly authorizing repairs. |
| `researcher` | Read workspace material and retrieve approved documentation; workspace mutations are blocked. |

Workers use the same configured inference service and server permission checks. They cannot spawn additional workers. Concurrent edits are serialized, and browser operations within a project are serialized. The implementation is a bounded set of model/tool jobs, not separate isolated operating-system sandboxes.

## Provider setup

Configure supported providers in Calvras settings, or set server environment variables before starting the app:

- `OPENROUTER_API_KEY`
- `GEMINI_API_KEY`
- `HUGGINGFACE_API_KEY` or `HF_TOKEN`

Environment values take precedence over locally saved provider settings. Saved keys are in the user's Calvras application-data `providers.json`, not source code or the project workspace. They are a local settings file, not an OS credential vault. Model selection uses the selected quick/balanced/thorough profile, available providers, image support, bounded fallback, and cooldowns. At least one valid provider is needed for live agent reasoning. Provider availability, rate limits, model capability, and account quotas affect results and latency.

## MCP setup

Connections are created only through an approved `configure_mcp` action. Repository files do not automatically start MCP servers. Give the connection a `name` and a `config`, for example:

```json
{
  "type": "configure_mcp",
  "name": "local-tools",
  "config": {
    "transport": "stdio",
    "command": "C:/Program Files/nodejs/node.exe",
    "args": ["C:/trusted-tools/server.js"],
    "timeoutMs": 30000
  }
}
```

HTTP connections use `{"transport":"http","url":"https://your-server.example/mcp"}` with optional `headers`. The client implements initialization, tool listing, calls, JSON and streamed responses, timeouts, and HTTP sessions. Stdio commands run without a shell; on Windows, use an executable such as `node.exe` rather than assuming a shell wrapper will run. Only explicitly supplied server environment values and basic process-path variables are forwarded. Use `list_mcp_tools` and `call_mcp_tool` with the configured name. Configure credentials required by that server explicitly. Stop or connection replacement closes the client.

## Verification and requirements

Install dependencies and the browser binary:

```sh
npm install
npx playwright install chromium
```

Run the runtime-focused suite and Electron build:

```sh
npx vitest run src/test/file-tools.test.ts src/test/command-tools.test.ts src/test/code-intelligence.test.ts src/test/browser-tools.test.ts src/test/mcp-client.test.ts src/test/permissions.test.ts src/test/worker-pool.test.ts src/test/runtime-advanced.test.ts src/test/runtime-coverage.test.ts
npm run build:electron
```

Browser tests use a real local HTTP fixture and Chromium. MCP tests use actual stdio/HTTP fixture servers. API tests verify approval, denial, token consumption/substitution protection, origin checks, and executor coverage. Passing fixture tests does not prove every external provider, project package script, MCP server, GitHub account, or deployment target is configured correctly.

## Practical limits

- Code intelligence primarily understands TypeScript and JavaScript. Other languages receive file/text tooling rather than a full language server.
- Semantic search ranks actual file excerpts using the model. It is bounded and is not a persistent embedding/vector index.
- Static security findings are pattern checks, not a comprehensive security audit.
- Responsive checks measure overflow and create screenshots. They do not establish pixel-perfect equivalence to a reference design.
- Formatting, tests, builds, dependency installs, Git, and deployment depend on the selected project's available runtimes and scripts. The app reports missing setup and execution failures.
- GitHub writes, deployment, external documentation, and MCP require network access and applicable credentials or provider setup. GitHub uses server-side `GITHUB_TOKEN` when supplied. Deployment runs an explicitly supplied, approved command.
- Model work is bounded by context, step, and timeout limits. Completion claims must reflect actual tool and verification results; unresolved failures remain visible.
