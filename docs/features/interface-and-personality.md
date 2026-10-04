# Interface and Personality

Pipkin's interface features stay quiet: UI keeps operational state visible, while Personality makes sessions recognizable later.

## UI

The footer presents a width-aware subset of:

- current directory and Git branch;
- selected model and thinking level, plus the latest successful physical response and its recorded thinking level under a virtual selection;
- active-branch cost across model switches;
- prompt-cache hit rate;
- context-window usage; and
- ordered extension status such as Readonly mode, Sandbox mode, pending Papercuts, or active Implement cleanup.

Metrics use recorded usage on the active branch, including assistant responses, tool/model calls, compaction and branch summaries, and standalone usage such as cache warming. Pi's top-level tool usage already includes nested calls; UI counts it once, never reconstructing usage from renderer details or child-call metadata. Recorded total costs are authoritative, including prompt-cache charges and zero-cost responses; UI does not estimate prices from the selected model. Model-attributed subscription-auth usage is excluded from cost, while unattributed tool/summary costs remain included. Cost disappears when the branch contains only subscription usage (or before first usage with a physical subscription model selected).

Cache hit rate appears after cache activity exists. It is the token-weighted branch average: cache-read tokens divided by input plus cache-read plus cache-write tokens across those recorded usage categories, not an average of per-request percentages. Reasoning tokens are already included in output and are not added again. Context usage comes from Pi's runtime, which uses the latest physical response's limits under virtual selection; an unknown window stays unknown. The virtual selector itself is not treated as a physical model with prices or known limits.

The Catppuccin semantic colors and custom footer field placement remain Pipkin-owned. Pi settings do not recreate this layout.

A long Git branch yields to the complete model/cost/cache/context segment before the optional context-window detail is removed. Sandbox, Readonly, Papercuts, and Implement publish source-owned `normal`, `warning`, or `error` statuses. Papercuts keeps its open-finding footer count and `/papercuts` browser; its [typed tools](workflow-tools.md#papercuts) do not turn that status into an authorized work queue. Implement shows the short warning-yellow `cleaning` status only while cleanup or post-run resource release is pending. Sandbox becomes warning-yellow and shows its active-runtime denial count after a confirmed direct-tool or kernel Bash write denial.

UI also owns the generic bounded Activity view. Processes, Subagents, and Implement publish source-qualified queued, running, or waiting work but keep ownership of their records, lifecycle, inspectors, cleanup, and terminal delivery; they remove settled work immediately. The full-width pending-work box has no history or count. Activity excludes prompts, commands, cwd, raw output, hidden runtime objects, provider payloads, cost, and aggregate token telemetry. A Subagent row may show current context usage and one already-bounded latest-assistant preview.

UI does not replace Pi's editor, working indicator, selectors, or custom-message presentation.

### Tool presentation

MCP tools, native `codemode`, and native `tool_search` use the same compact call identities and short result summaries as Pipkin-owned tools, in the interactive transcript and HTML exports. Expand a tool row with Pi's normal tool-expansion control to inspect details:

| Tool          | Compact view                                                                                                                                | Expanded view                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| MCP tools     | Server/tool identity, bounded argument and text previews, errors, and full-output references when present                                   | Arguments, returned text/resource references, and full-output paths                          |
| `codemode`    | Script state, elapsed time when reported, nested-call outcome counts, per-call tool names/statuses, and full-output references when present | Script, nested-call arguments/statuses/errors/timing/model costs, and returned script output |
| `tool_search` | Query and number of tools loaded, or an error                                                                                               | Arguments, loaded tool names, and returned descriptions                                      |

Codemode's compact roster shows the most recent eight calls in order: `✓` succeeded, `✗` failed, `…` running, and `⊘` cancelled, with matching semantic colors. Scripts, arguments, detailed errors, and returned output stay expanded-only. When earlier calls are omitted, an explicit notice points to expansion; aggregate outcome counts still cover every call.

MCP previews are presentation, not inferred domain summaries. A completed codemode script can contain failed or cancelled nested calls; those outcomes remain visible rather than being presented as successful work. Nested calls do not become separate transcript tool rows, and their complete results are not reconstructed from call metadata. Images remain Pi-owned. Expanded results contain full call arguments/scripts as well as returned text, so HTML exports retain them even though Pi never expands exported call headers. Terminal-control sequences are removed from displayed text without changing the original results. When native truncation occurred, use the reported full-output path for the complete text.

UI only selects renderers through Pi's `registerToolRenderer()` hook. It does not replace execution, discovery, MCP transport/authentication, model-facing content, or structured results. Other native tools and feature-owned semantic renderers retain their presentation; common rendering machinery stays in `src/lib/ui/tool-result-renderer.ts`.

## BTW side questions

Use `/btw <question>` in the TUI with an active authenticated model for a no-tools side answer. The panel keeps one active request; opening another cancels the previous one. Each unpromoted exchange stays ephemeral and is not supplied to later side questions. Escape aborts generation or closes the panel, and arrow keys scroll the Markdown answer. Session replacement and shutdown close the active panel.

After completion, press `s` to promote the full question/answer as one displayed `btw` transcript message. Promotion adds ordinary parent context through steering without triggering a new turn; close/cancel otherwise leaves the parent unchanged.

BTW reads Pi's canonical conversation projection, including native edits, textual compaction and branch summaries. It removes parent system instructions and all historical tool-loadout declarations/deltas before provider normalization, then supplies only BTW's own no-tools instruction and an empty effective tool set. Complete tool exchanges remain evidence; unfinished or orphan exchanges are omitted without invented results.

The full question and readable evidence are passed to the selected model through Pi's model runtime, including virtual models. There is no custom token estimator, history packing, silent truncation or fixed response cap. Provider overflow and other errors appear in the panel; BTW never compacts or mutates the parent to recover. Cancellation does not launch a fallback.

An authoritative opaque Codex checkpoint is unavailable to this side request. BTW excludes its marker/artifact, supplies the readable canonical summaries/tail available, and explicitly states that earlier history cannot be reconstructed. Ordinary parent-native replay is unchanged; see [Context](context.md#compaction).

## Session naming

Personality gives an unnamed session a short title from up to three early non-empty prompts. It uses the `utility` model preset asynchronously, so naming never delays the main agent turn, and writes Pi's canonical session name for `/resume`, terminal titles, and window titles. Bounded branch, changed-area, recent-commit, and recent-session context can disambiguate the request, but the request remains the title's subject. Evidence from recent sessions may support a compact continuity touch such as `Continue …` or `— again`; incidental Git activity does not.

Personality never replaces a manually assigned or existing ordinary-session name. If the utility model cannot run, it derives a local fallback from the initial prompt. Titles use the first non-empty generated line, remove labels and surrounding quotes, and collapse whitespace. Personality asks for concise, complete natural phrases but preserves the canonical generated title rather than imposing a storage-length limit; width-constrained Pi surfaces remain responsible for display fitting. When an automatic title is applied in the TUI, Personality quietly announces it with a small mascot notification.

When an Implement run or restart successfully starts, it claims naming ownership before its asynchronous title lookup. It receives an `Implement …` title based on a bounded excerpt of the root plan; repository context can only disambiguate that authoritative plan and continuity wording is deliberately conservative. The active run owns session identity, so this replaces an earlier name and its Activity title. Invalid or unavailable generation falls back to `Implement run`. Blocked, control, and all-checked no-op commands leave the name unchanged.

See [Configuration](../configuration.md#model-presets) for model routing.

## Fresh-session welcome

On an empty fresh TUI startup or `/new`, Personality shows a compact passive identity card with a small kaomoji mascot, a stable varied greeting, and one friendly context signal. Greetings use the optional configured nickname, local time band, and supported continuity; a stable session seed keeps wording fixed across rerenders. The single subline prioritizes changed files, then a recent meaningful session, then the latest commit, and finally a friendly fallback. It deliberately does not repeat repository, branch, model, cost, or other operational UI facts.

The card collects its bounded recent-session and read-only Git context before installing, so it never flashes a provisional card. Missing history or Git information simply falls back gracefully. It disappears on first accepted input or a session-name update, and never appears on reload, resume, or fork.

See [Nickname](../configuration.md#nickname) for configuration.
