# Configuration and state

Pipkin keeps personal preferences under Pi's agent directory and checkout-owned policy or state beside the checkout that owns it. Pi remains responsible for model credentials.

## Quick setup

Create `<getAgentDir()>/pipkin/config.json`. With Pi's default agent directory, the path is `~/.pi/agent/pipkin/config.json`.

```json
{
  "nickname": "Mads",
  "models": {
    "utility": { "model": "provider/fast-model", "thinking": "minimal" },
    "low": { "model": "provider/low-cost-model", "thinking": "low" },
    "medium": { "model": "provider/coding-model", "thinking": "medium" },
    "high": { "model": "provider/reasoning-model", "thinking": "high" }
  },
  "implement": {
    "workerConcurrency": 3
  }
}
```

Only `models` is required for the complete model-powered feature set. `nickname` and `implement` are optional. Pipkin rejects unknown top-level keys.

Configuration is snapshotted at each consuming feature's documented lifecycle boundary. Run Pi's `/reload` after changing it.

## Native discovery

Merge this fragment into Pi's `settings.json`; do not overwrite unrelated settings or model presets:

```json
{
  "defaultTools": ["+codemode", "+tool_search"],
  "codemode": { "mode": "on" }
}
```

Keep the native built-in extensions enabled and the native declaration budget. Sandbox `bash` stays directly declared, and user-enabled native tools such as `read`, `edit`, and `write` remain intact. Other public Pipkin tools are deferred: native `tool_search` can discover and activate them for direct calls, and native `codemode` can call them without activation. Private managed completion is directly declared but model-only. Discovery and annotation hints never grant permission.

At least one discovery path must be active. Pipkin currently checks once at the first turn, after the initial native startup wait; a slow MCP connection can outlast that wait, so the check can warn prematurely. This remains unresolved: Pi 0.99.1 exposes neither native connection state nor a startup-settlement notification to extensions, so turn timing cannot establish actual settlement. Setup warnings use UI notifications when available and stderr in print/JSON sessions, leaving protocol stdout untouched. Pipkin does not rewrite settings, crash, or enable every tool as a fallback. SDK hosts must supply the supported native factories and complete `bindExtensions()`; the CLI supplies them normally.

## MCP servers

Native Pi exclusively owns MCP configuration, transport, authentication, discovery, and `/mcp`, even with no servers configured. Pipkin has no MCP proxy or `/mcp-auth` command. Configure `mcpServers` in `<getAgentDir()>/mcp.json` or trusted project `.pi/mcp.json`. Native project entries replace same-named global entries wholesale. Native OAuth credentials stay in `<getAgentDir()>/mcp-auth.json`; Pi owns their lifecycle.

### Setup

1. Configure servers in native `mcp.json`, then run `/reload` or start a new session.
2. Use `/mcp` to inspect configuration and connection state. For authorized authentication, use the native manager or `/mcp login <server>` (`pi mcp login <server>` from a shell). Anonymous and API-key servers use ordinary native MCP configuration; OAuth uses native login.

Consult [Pi's MCP guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md) for exact settings and authentication procedures. Never put secrets in repository files, URLs, or tool arguments. Pipkin does not edit MCP configuration or credentials.

### Worker documentation

Tool-using SDK workers explicitly load and activate native codemode/tool-search and the full Pipkin bundle. They select only `mcpServers.context7` from the actual agent-directory `mcp.json`, or a wholesale replacement in the child's natively trusted `.pi/mcp.json`. Untrusted project files are not read. No entry means no worker documentation endpoint; invalid or disabled selected entries do not fall back to another configuration.

Only native `resolve-library-id` and `query-docs` tools are eligible for deferred access, narrowed by user-hidden choices. Workers inherit no unrelated servers, resource operations, MCP management commands or interactive login flows. Native Pi retains command/environment/header resolution and ordinary agent-directory OAuth storage; Pipkin copies no credentials or transports. Auth-needed documentation reports bounded unavailability without failing the entire child. Authenticate manually with native `/mcp` in the parent, then start a new worker. [Agents](features/agents.md#native-documentation) owns callable restrictions and lifecycle.

### Figma operator gate

Live Figma use is **blocked/unverified** until the operator, with explicit authorization, registers/configures/logs in using the separately supplied current guide and makes a real permitted Figma tool call through native Pi. Record only pass/fail and a non-secret explanation. Native Pi supports a configured `oauth.clientId` and matching callback URL to skip dynamic registration; use the working name, matching callback, and returned authentication method from that guide. Tests with a local fake server do not verify Figma. Failed or unperformed verification remains blocked/unverified: no proxy, fallback server, credential change, or workaround is authorized by this gate.

## Sandbox writable roots

Sandbox reads `sandbox.writable` from both configuration scopes:

| Scope   | Path                                                                                                         | Allowed fields                                   |
| ------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| Global  | `<getAgentDir()>/pipkin/config.json` (normally `~/.pi/agent/pipkin/config.json`)                             | `nickname`, `models`, `implement`, and `sandbox` |
| Project | `<canonical-workspace>/<CONFIG_DIR_NAME>/pipkin/config.json` (currently `<checkout>/.pi/pipkin/config.json`) | `sandbox`                                        |

Project configuration is anchored to the resolved workspace: the canonical Git worktree root even when Pi starts in a subdirectory, or the canonical current directory outside Git. Pipkin does not search other ancestors. Put personal persistent roots in the global file, not in a project file or `.pi/settings.json`.

```json
{
  "sandbox": {
    "writable": [
      "~/.local/state/gh",
      "~/.local/state/pnpm",
      "~/Library/pnpm/store"
    ]
  }
}
```

These are writable-root examples: Pipkin neither creates nor changes those paths. They authorize only the selected children, not `~/.local/state`, its siblings, executables, credentials, Git, or Pipkin configuration.

An entry is an exact path or has one complete `*` segment before a non-empty literal final directory (`apps/*/.svelte-kit`). Global entries are absolute after an optional leading `~/`; project entries are workspace-relative. `**`, partial wildcards, `?`, classes, braces, extglobs, negation, empty, `.` or `..` segments, controls, and absolute project paths are invalid. Every parent must already be a real directory without symlinks; the final literal directory may be absent. Wildcards expand only existing immediate children and never create authority by themselves.

Files are limited to 64 KiB; each scope permits 64 entries of at most 1,024 characters, and both scopes resolve at most 256 concrete roots. Present malformed files, wrong-scope fields, invalid entries, and failed validation produce bounded, scope-labeled `/sandbox` diagnostics while valid sibling fields and entries still apply. Missing project files are silent. Configuration is snapshotted at session construction: run Pi's `/reload` after a change; Pipkin does not watch files mid-session.

Configured project roots must be ignored and untracked, and remain narrow repository-read-only exceptions. Git and Pi/Pipkin configuration always remain read-only. Global roots cannot overlap the workspace, configuration, Git administration, home/root, temporary roots, direct `PATH` directories, effective XDG configuration, or macOS preferences; a deliberately selected narrow child such as `~/Library/pnpm/store` is allowed when safe. `/sandbox` reports the configured-root count and bounded configuration problems without listing every path.

## Model presets

Each preset requires:

- a non-empty `provider/model` reference; and
- a Pi-supported thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.

| Preset    | Roles                                                                        |
| --------- | ---------------------------------------------------------------------------- |
| `utility` | Session and Implement-run naming                                             |
| `low`     | Explore agents, including nested exploration, and Context textual compaction |
| `medium`  | Implement implementation, revision, reconciliation, and whole-plan repair    |
| `high`    | Review agents and Implement planning and review                              |

All four preset keys must be present; unknown preset keys are rejected. Pipkin does not silently substitute another provider for a missing or malformed preset. All presets may reference the same model if tiered routing is unnecessary.

BTW uses the current conversation model. Explicit `model` or `thinking` arguments override a public `agent_start` invocation only and are not saved.

Pi owns provider credentials and `settings.json`; keep API keys out of Pipkin configuration.

## Nickname

`nickname` is an optional display name used only in Personality's fresh-session greeting. Pipkin collapses whitespace and requires a non-empty, control-free value of at most 40 characters.

## Implement settings

| Setting                       | Default | Valid values                    | Effect                                                              |
| ----------------------------- | ------: | ------------------------------- | ------------------------------------------------------------------- |
| `implement.workerConcurrency` |     `3` | Positive integer, capped at `8` | Maximum independent Implement workstreams that may run concurrently |

Publication remains serialized regardless of worker concurrency. See [Implementation](features/implementation.md).

## Native research setup

For parent-session research, manually configure an existing Context7 server in native `mcp.json` and authenticate through native Pi if required. Pipkin never provisions Context7. Use the user's existing `gh` authentication for GitHub work, `npm search --json <query>` for package discovery, and file/LSP capabilities for local source evidence. Web Fetch and Browser retain their distinct public-URL and rendered-state boundaries. Worker documentation inheritance is a separate worker-runtime contract, not implied by parent setup.

## Durable state

Checkout-owned state lives under Pi's project configuration directory in `pipkin/` (currently `.pi/pipkin/`):

```text
<checkout>/.pi/pipkin/
  implement/
    checkout.lock
    checkout.owner.json
    runs/<run-id>/
      execution-plan.json
      source-corpus.json
      run-state.json
      artifacts/
    worktrees/<run-id>/
    trash/
  papercuts.json
  papercuts.lock
```

This tree shows the durable ownership layout; terminal cleanup may remove owned worktrees and trash entries.

Implement state belongs to each checkout. Papercuts resolves the canonical primary worktree so linked worktrees share one registry. Its read-only `papercut_list` and `papercut_get` operations never initialize that registry; [Workflow tools](features/workflow-tools.md#papercuts) owns inspection authority and recording contracts. Both arrange local exclusion through the repository's common `.git/info/exclude`; neither changes committed `.gitignore`.
