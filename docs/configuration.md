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

Configuration is snapshotted when each consuming extension is constructed. Run Pi's `/reload` after changing it.

## MCP servers

MCP is optional and global-only. Add `mcp.<name>.url` to `<getAgentDir()>/pipkin/config.json`; project configuration rejects `mcp`. An empty `mcp` map is valid and disables the MCP extension surface.

```json
{
  "mcp": {
    "research": {
      "url": "https://mcp.example.test/v1"
    }
  }
}
```

This is an endpoint-only, strict schema:

| Path             | Required           | Exact contract                                                                           |
| ---------------- | ------------------ | ---------------------------------------------------------------------------------------- |
| `mcp`            | No                 | Object map of server definitions                                                         |
| `mcp.<name>`     | Yes for each entry | Object with only `url`; `<name>` matches `[a-z][a-z0-9_-]*` and is at most 64 characters |
| `mcp.<name>.url` | Yes                | HTTP(S) URL string at most 2,000 characters                                              |

Pipkin performs no endpoint reachability check while parsing configuration. Each server definition is validated independently: an invalid name, malformed definition, unsupported field, or invalid URL omits only that entry while valid siblings remain available. Invalid `mcp` values are rejected, and all unsupported fields in strict server definitions are reported as configuration issues.

No credential, authentication, transport, lifecycle, or provider-specific setting belongs in this schema. Do not put secrets in configuration or URLs; adapter-owned credentials are separate from Pipkin configuration.

Each MCP extension construction reads one immutable global snapshot. Pipkin does not watch the file during a session. Save the configuration and run Pi's `/reload` to apply a revised server map; the new extension instance receives the new snapshot.

## Sandbox writable roots

Sandbox reads `sandbox.writable` from both configuration scopes:

| Scope   | Path                                                                                                         | Allowed fields                                          |
| ------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| Global  | `<getAgentDir()>/pipkin/config.json` (normally `~/.pi/agent/pipkin/config.json`)                             | `nickname`, `models`, `implement`, `sandbox`, and `mcp` |
| Project | `<canonical-workspace>/<CONFIG_DIR_NAME>/pipkin/config.json` (currently `<checkout>/.pi/pipkin/config.json`) | `sandbox` only                                          |

Project configuration is anchored to the resolved workspace; Pipkin does not search ancestors. Put personal persistent roots in the global file, not in a project file or `.pi/settings.json`.

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

These are external user-configuration migration examples: Pipkin neither creates nor changes those paths. They authorize only the selected children, not `~/.local/state`, its siblings, executables, credentials, Git, or Pipkin configuration.

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

BTW uses the current conversation model. Explicit `model` or `thinking` arguments override a public `Agent` invocation only and are not saved.

Pi owns provider credentials and `settings.json`; keep API keys out of Pipkin configuration.

## Nickname

`nickname` is an optional display name used only in Personality's fresh-session greeting. Pipkin collapses whitespace and requires a non-empty, control-free value of at most 40 characters.

## Implement settings

| Setting                       | Default | Valid values                    | Effect                                                              |
| ----------------------------- | ------: | ------------------------------- | ------------------------------------------------------------------- |
| `implement.workerConcurrency` |     `3` | Positive integer, capped at `8` | Maximum independent Implement workstreams that may run concurrently |

Publication remains serialized regardless of worker concurrency. See [Implementation](features/implementation.md).

## Reference credentials

Reference optionally reads `<getAgentDir()>/pipkin/auth.json`, separate from `config.json`:

```json
{
  "context7": "…",
  "github": "…"
}
```

| Key        | Purpose                                                                                |
| ---------- | -------------------------------------------------------------------------------------- |
| `context7` | Context7 documentation requests                                                        |
| `github`   | GitHub code search; repository access determines searchable private or internal source |

Both values are optional non-empty strings. Unrelated keys are ignored. Use a dedicated least-privilege GitHub token. `package_search` always requests public repositories.

Reference does not read GitHub CLI, npm, repository, or environment credentials. Never place real credentials in documentation, repository files, or tool inputs. See [Reference](features/reference.md).

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

Implement state belongs to each checkout. Papercuts resolves the canonical primary worktree so linked worktrees share one registry. Both arrange local exclusion through the repository's common `.git/info/exclude`; neither changes committed `.gitignore`.

## No legacy migration

Current paths are a hard cutover. Pipkin does not read, copy, migrate, or diagnose old `extensions/pi-*` configuration, root `.pi/implement`, `.pi/papercuts.json`, or `.pi/papercuts.lock`. Existing files at those paths remain available for manual inspection only.
