# Workflow tools

Pipkin includes several focused utilities for semantic navigation, overlapping commands, durable friction notes, and transcript-independent side questions.

## LSP

Nine read-only tools in the deferred `lsp` namespace complement text search with language-server relationships and type information. There is no `lsp` dispatcher alias.

| Tool                    | Successful data                          |
| ----------------------- | ---------------------------------------- |
| `lsp_definition`        | Definition `locations`                   |
| `lsp_type_definition`   | Type-definition `locations`              |
| `lsp_implementation`    | Implementation `locations`               |
| `lsp_references`        | Reference `locations`, with declarations |
| `lsp_hover`             | Hover `text`; empty text is valid        |
| `lsp_document_symbols`  | File `symbols`                           |
| `lsp_workspace_symbols` | Workspace `symbols`                      |
| `lsp_diagnostics`       | `diagnostics` and freshness evidence     |
| `lsp_status`            | Configured and live `servers`            |

Position tools take `{file, position, timeout?}`. `position` is either `{line,column}` or `{line,symbol,occurrence?}`; all numeric selectors are positive integers. Symbol selection finds literal text on that line, with occurrence defaulting to the first match. Columns count UTF-16 code units; coordinates are 1-based, and range ends are exclusive. A column may be one past the line end, not beyond it. File tools take `{file,timeout?}`; workspace symbols takes `{query,file?,timeout?}` with a file routing hint; status takes `{}`. Files must be inside the caller's workspace, including after symlink resolution.

Use LSP for focused semantic relationships, text search for literal discovery, and Explore for multi-step mapping. Diagnostics are advisory; project lint, typecheck, tests, and builds remain authoritative.

### Supported languages

| Language                | Files                                                        | Server                                                                 |
| ----------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| TypeScript / JavaScript | `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts` | Packaged `typescript-language-server`, preferring workspace TypeScript |
| Svelte                  | `.svelte`                                                    | Packaged `svelte-language-server`                                      |
| Ruby                    | `.rb`, `.rake`                                               | Project-provisioned `ruby-lsp` from `bin/ruby-lsp` or `PATH`           |

Servers start lazily, share one pool across operations and sessions, and retire after idle time. Requests default to five seconds, require at least 0.1 seconds, and cap at 15; acquisition and querying share one budget. Status inspects all three configured server kinds without launching them: `configured`, `available`, `running`, `state` (`available`, `starting`, `running`, `unavailable`), workspace, and bounded reason where relevant.

Both direct content and codemode receive the same bounded JSON domain result. Success has `ok:true` and `truncated`; lists contain at most 100 items, applicable item text is capped at 2,000 characters, and the entire JSON payload obeys Pi's ordinary byte/line bounds. Locations are `{file,line,column,endLine,endColumn}`; symbols are `{name,kind?,location?}`; diagnostics are `{range:{line,column,endLine,endColumn},severity,message,source?,code?}`. Workspace files are relative where possible; external files and URIs keep their normalized external identity. Truncation never asserts an unverified total count.

Diagnostics run only when requested. There is no save/edit hook, proactive server startup, or unsolicited diagnostic injection. A current empty diagnostic list is a valid result. Timeout with a usable cache (even an empty prior snapshot) succeeds with `freshness:"stale"` and `timedOut:true`, retaining messages and owner `evidence` (`fresh`, `stale`, optional `resultId`). `freshness:"unknown"` does not establish currency. No usable snapshot returns an error, never a clean-file claim. Malformed requested server responses fail with `request_failed` rather than empty semantic data. Invalid pushed diagnostic updates are discarded without replacing cached evidence; a pending request still waits within its deadline for valid data, then returns stale cache or a timeout error.

Failures have `ok:false`, `error:{code,message}` and native `isError:true`; codemode can inspect that data without relying on a thrown exception. Owner codes are `invalid_arguments`, `invalid_position`, `workspace_denied`, `not_found`, `server_unavailable`, `unsupported`, `timeout`, `cancelled`, `request_failed`, and `not_current` (a response superseded or invalidated before it could establish currency). Continue with source search or project tooling when unavailable; do not install dependencies unless asked. Collapsed rows summarize results or freshness; expansion preserves the bounded JSON payload. The model cannot choose an executable, send arbitrary protocol methods, apply edits, or invoke server commands. Language servers are trusted processes outside Sandbox and inherit Pi's environment.

## Managed processes

Use foreground Bash when completion is immediately required. Use managed processes only when useful independent work can continue.

| Tool              | Purpose                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| `process_start`   | Accept a foreground command with a normalized 1..120-code-point description; return its ID, not a completion claim |
| `process_list`    | Recover session-owned IDs and bounded descriptions/state/timing, without commands or output                        |
| `process_inspect` | Immediately capture current state/output                                                                           |
| `process_wait`    | Wait for settlement, a deadline, or caller cancellation                                                            |
| `process_stop`    | Gracefully stop, escalate if needed, and join terminal cleanup                                                     |

The human `/processes` dashboard remains available for live inspection and direct stop controls.

Use `process_wait` only for finite work expected to terminate. Its optional `timeoutSeconds` is positive and finite, capped at 2,147,483.647 seconds. Omission waits until terminal settlement or cancellation; it does not grant unlimited process lifetime. Timeout returns `ok:true`, `waitOutcome:"timed_out"`; cancellation returns `ok:false`, `cancelled`, with the latest snapshot. Neither kills the process. Inspect long-lived servers/watchers with `process_inspect`; stop unneeded work explicitly.

Snapshot operations return matching direct and structured process state/timing/exit/signal, `waitOutcome`, output, truncation/completeness and retention data. `presentation:"output"` is the default; `"status"` suppresses only successful logs. Failed terminal commands retain diagnostics and return `execution_failed`; intentional stopping returns `stopped`, not successful verification. Lookup failures use `not_found`; rejected inputs/capacity/deadlines use `invalid_arguments`. Persistence failure returns `persistence_failed`, no bogus reference, and available diagnostics without relabeling the true process state.

The runtime permits 8 active jobs, 32 public records, and 16 waiters per process. Listing filters session/branch ownership before pagination; `offset` defaults to 0 and `limit` to 25 (1..25), newest first with stable ID ties. Commands/cwd in snapshots are bounded previews with explicit truncation flags. Jobs remain discoverable when the initiating script throws.

Each process retains a 1 MiB live output tail. Presentation shows the normal 80-line tail, bounded to 18 KiB/200 lines; [Context](context.md#retained-output) owns selectors over immutable captures, not a live buffer. Inspect/wait/stop persist point-in-time snapshots before returning references. Running snapshots never change; terminal evidence is persisted even without joining and reused across later observers. It survives runtime eviction and durable-session shutdown. Shutdown stops owned processes through Sandbox leases and flushes terminal evidence before clearing; restart never resurrects OS processes. If bounded cleanup fails, shutdown reports failure, captures available output and known exit/signal diagnostics, and releases its reservations without waiting forever for completion. Cleanup failure remains a nonterminal, incomplete snapshot (`unavailable`), not an achieved stop; subsequent inspect/wait/stop calls preserve that uncertainty and failed status presentation still includes diagnostics.

`/processes` groups Running and Settled work, shows command, working directory, PID, settlement, and exceptional output-integrity information on a process landing page, and provides live merged output. Output follows the bottom until you scroll upward; returning to the bottom resumes following new output.

Commands must remain foreground and non-interactive. Stop work that is no longer needed.

## Papercuts

`record_papercut` is an experimental factual inbox, not a backlog or remediation system. A finding qualifies only when all of these are true:

1. The assigned subject was something else.
2. The agent encountered concrete avoidable friction.
3. It exercised at least one workaround or detour.
4. It completed or safely continued the assigned task.

Qualifying friction may include a flaky documented test handled with a narrower command, an undocumented validation convention, ambiguous output requiring context reconstruction, or redundant manual setup.

Do not record the task or review subject itself, unmet criteria, unresolved correctness or safety problems, inferred architecture, unused suggestions, expected guided steps, adequately documented procedures, one-off agent mistakes, or transient provider failures.

Before recording, use `inspect_papercuts` to check open **and closed** findings. Skip an incident already recorded; reuse the existing key when equivalent friction recurs during a separate task; make a new key only for materially different friction. Records merge by stable key and retain occurrence count, replacing the latest observation while preserving the original title and first-seen time. A collapsed confirmation names the recorded key and outcome; expanding it preserves the complete model-facing confirmation.

`inspect_papercuts` lists compact summaries (key, title, status, occurrences, last seen), filtered by status and paginated up to 25 per request, or retrieves all recorded details by key. It reads the current repository's shared registry without creating or changing it; a missing registry yields an empty list, and an invalid registry or unknown key reports an error. Agents may inspect at the user's request or to deduplicate a qualifying new observation, but must not proactively inspect findings for work. A deduplication check does not authorize discussing or addressing an existing finding.

`/papercuts` shows open and closed findings. Select one and choose **Discuss with agent** to send a user message asking the agent to inspect that key and discuss fixes—not implement them yet. The agent retrieves current details with `inspect_papercuts`; you can also ask about a specific finding directly. Discussion does not authorize implementation. Closing remains a user action and is reversible when a later recurrence reopens the key. The closed-findings view can permanently delete all closed records and their occurrence history after confirmation; open findings are preserved. Findings are candidates for repository guidance or small fixes, never automatic work.

A repository and linked worktrees share one leased registry in the canonical primary worktree:

```text
.pi/pipkin/papercuts.json
.pi/pipkin/papercuts.lock
```

The paths are excluded through common Git `info/exclude`, not committed `.gitignore`. Repository-preserving workers may write only this controlled personal metadata; it grants no source, Git, or orchestration authority.

## BTW

`/btw` asks one ephemeral side question without adding it to the main transcript:

```text
/btw Why did we choose a file lease here?
```

Pipkin sends the current model a bounded view of Pi's canonical session projection and the question, without historical system instructions or tool declarations, then shows the Markdown answer in a disposable surface. Virtual selectors with unknown limits use the model runtime's output defaults instead of a guessed context budget. Each invocation is independent: an unpromoted exchange is neither retained nor supplied to later BTW questions.

After a completed answer, press `s` to promote the complete question and answer into one displayed `btw` transcript message. That message becomes ordinary session context without starting a turn while idle; during a response it is delivered as steering. Press Escape to abort generation or close the completed surface; arrow keys scroll the answer.

BTW has no tools: it cannot inspect files, run commands, or mutate state beyond what is already in supplied context. Use Explore when the side task needs tools. Session replacement and shutdown dispose the active surface. BTW requires an interactive session, active model, and usable authentication.
