# Workflow tools

Pipkin includes several focused utilities for semantic navigation, overlapping commands, durable friction notes, and transcript-independent side questions.

## LSP

The read-only `lsp` tool complements text search with language-server relationships and type information.

| Action              | Question answered                                                    |
| ------------------- | -------------------------------------------------------------------- |
| `definition`        | Where is this symbol defined?                                        |
| `type_definition`   | Where is its type defined?                                           |
| `implementation`    | What implements this contract?                                       |
| `references`        | Where is it used?                                                    |
| `hover`             | What type or documentation does the server know here?                |
| `document_symbols`  | What symbols are in this file?                                       |
| `workspace_symbols` | Where is a symbol with this name in the workspace?                   |
| `diagnostics`       | What diagnostics does the server report for this file?               |
| `status`            | Which servers are discovered, running, cooling down, or unavailable? |

Each call places one action-specific object under `request`. Position queries use a workspace-relative or absolute `file` with 1-indexed `line` and `column`. When symbol text is known, `symbol` can replace the column and `occurrence` selects a repeated instance.

Use LSP for focused semantic relationships, text search for literal discovery, and Explore for multi-step mapping. Diagnostics are advisory; project lint, typecheck, tests, and builds remain authoritative.

### Supported languages

| Language                | Files                                                        | Server                                                                 |
| ----------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| TypeScript / JavaScript | `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts` | Packaged `typescript-language-server`, preferring workspace TypeScript |
| Svelte                  | `.svelte`                                                    | Packaged `svelte-language-server`                                      |
| Ruby                    | `.rb`, `.rake`                                               | Project-provisioned `ruby-lsp` from `bin/ruby-lsp` or `PATH`           |

Servers start lazily, are shared per workspace, and retire after idle time. Requests default to five seconds and cap at 15. Results are bounded to 100 locations, symbols, or diagnostics and 2,000 hover characters; rendered lists also use Pi's ordinary tool-result limits.

Unavailable servers and unsupported capabilities return non-fatal fallback results. Collapsed rows identify the operation, target, and available result count; expanding a row preserves the complete bounded semantic output. The model cannot choose an executable, send arbitrary protocol methods, apply edits, or invoke server commands. Language servers are trusted processes outside Sandbox and inherit Pi's environment.

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
