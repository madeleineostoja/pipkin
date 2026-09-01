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

## MCP servers

MCP is optional. Add personal servers to `<getAgentDir()>/pipkin/config.json` and checkout-specific servers to `<canonical-root>/<CONFIG_DIR_NAME>/pipkin/config.json` (currently `<checkout>/.pi/pipkin/config.json`). An empty `mcp` map is valid. Project MCP configuration is read only in trusted sessions, never by searching ancestor directories.

```json
{
  "mcp": {
    "research": {
      "url": "https://mcp.example.test/v1",
      "oauth": {
        "clientName": "Approved Client"
      }
    }
  }
}
```

This is a strict endpoint and OAuth client-metadata schema:

| Path                          | Required           | Exact contract                                                                                                                                  |
| ----------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp`                         | No                 | Object map of server definitions                                                                                                                |
| `mcp.<name>`                  | Yes for each entry | Object with `url` and optional `oauth`; `<name>` matches `[a-z][a-z0-9_-]*`, is at most 64 characters, and cannot begin `project__`             |
| `mcp.<name>.url`              | Yes                | HTTP(S) URL string at most 2,000 characters                                                                                                     |
| `mcp.<name>.oauth`            | No                 | Object containing only `clientName`                                                                                                             |
| `mcp.<name>.oauth.clientName` | Yes with `oauth`   | Literal Dynamic Client Registration `client_name`, trimmed, without control characters or environment interpolation, and at most 256 characters |

Pipkin performs no endpoint reachability check while parsing configuration. Each server definition is validated independently: an invalid name, malformed definition, unsupported field, invalid URL, or invalid OAuth client name omits only that entry while valid siblings remain available. Invalid `mcp` values are rejected, and all unsupported fields in strict server definitions are reported as configuration issues.

`oauth.clientName` overrides the non-secret literal client name that the adapter advertises during Dynamic Client Registration for that server. It does not provide a pre-registered client ID, secret, access token, or refresh token. Configure only the identity required by the provider; changing it may require `/mcp logout <server>` before authenticating again.

No credential, token, transport, lifecycle, or other provider-specific setting belongs in this schema. Do not put secrets in configuration or URLs; adapter-owned credentials are separate from Pipkin configuration.

At session start Pipkin parses both scopes independently, preserving valid siblings and scope-labelled issues. A valid trusted-project entry replaces a global entry with the same logical name; an invalid project sibling leaves the valid global server intact. Global servers keep their configured adapter name. Project servers are supplied to the adapter as `project__<slug>_<digest>__<logical-name>` (at most 112 characters):

- `<slug>` starts with the lowercased canonical-root basename. Each maximal run outside `[a-z0-9]` becomes `_`; surrounding `_` characters are removed; the result is truncated to 24 characters; and an `_` newly left at the end by truncation is removed. An empty result becomes `project`.
- `<digest>` is the first 12 lowercase hexadecimal characters of SHA-256 over the UTF-8 canonical absolute root string.

These names deliberately key adapter-owned credentials and metadata: global names share credentials, while project names isolate credentials and their URL binding. Moving or recloning a checkout changes its generated name, so authenticate again if needed.

Pipkin resolves the current canonical Git worktree root, or canonical current directory outside a usable worktree; it never searches a different ancestor. Snapshots are immutable for the session and Pipkin does not watch files. Save changes and run `/reload` to reconstruct the map and adapter. [MCP](features/mcp.md) documents the visible operational consequences of these adapter identities.

## Sandbox writable roots

Sandbox reads `sandbox.writable` from both configuration scopes:

| Scope   | Path                                                                                                         | Allowed fields                                          |
| ------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| Global  | `<getAgentDir()>/pipkin/config.json` (normally `~/.pi/agent/pipkin/config.json`)                             | `nickname`, `models`, `implement`, `sandbox`, and `mcp` |
| Project | `<canonical-workspace>/<CONFIG_DIR_NAME>/pipkin/config.json` (currently `<checkout>/.pi/pipkin/config.json`) | `sandbox` and `mcp`                                     |

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
