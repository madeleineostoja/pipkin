# Context

Long sessions accumulate tool output that is no longer useful verbatim. Context replaces eligible output with stable, reasoned stubs while preserving the original result for `context_recall`.

## Compaction

Textual compaction always uses the snapshotted `models.low` preset, including manual `/compact`, `/compact <instructions>`, threshold compaction, and overflow recovery. Pi retains its normal summary format, split-turn handling, file-operation list, usage accounting, and retry behavior. If that preset or its provider route cannot complete, Context returns control to Pi's active-model compaction rather than saving a partial summary.

An uninstructed compaction can instead use an opaque server checkpoint only for the exact OpenAI Codex OAuth surface: provider `openai-codex`, API `openai-codex-responses`, the `https://chatgpt.com/backend-api/codex/responses` endpoint, and the same Codex model and ChatGPT account that created it. The transcript shows a stable marker, not a readable summary. On the next ordinary request Context validates the persisted checkpoint and replaces only its marker-and-kept-tail provider segment immediately before dispatch.

These checkpoints are not portable. A different provider, model, endpoint, API-key authentication, or ChatGPT account cannot continue one. Return to the original compatible Codex OAuth model/account to recover. Context warns and leaves an ordinary request unchanged when a persisted native checkpoint is malformed, tampered with, incompatible, or cannot be uniquely replayed. It also cancels instructed compaction after native authority exists instead of converting opaque context into a lossy text summary. Initial native creation may fall back to `models.low`; later native failures fail closed.

Context stores checkpoint metadata append-only with Pi's normal compaction entry. Reload, resume, and a fork containing that entry reconstruct its authority; a fork before it has none. Pruning remains non-destructive and applies persisted decisions before replay, so it does not erase original messages or tool results. `context_recall` continues to retrieve original results across textual and native compaction.

## Pruning behavior

A tool result appears in full when produced. On a later model request, Context may elide successful output that is:

- stale after later user entries;
- superseded by a later edit or write;
- duplicated or covered by a later read; or
- low-risk Bash output already consumed by the assistant.

The original session entry is never changed. Context evaluates deterministic branch-local epochs, persists complete decisions before changing outgoing copies, and replays those decisions after reload, resume, fork, and compaction while source calls remain in active context.

Each stub names the reason and source call:

```text
[read result elided: covered by a later read of PATH at user entry 8. Call context_recall("TOOL_CALL_ID") to retrieve.]
```

| Opportunity  | Selection rule                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------- |
| Known-cold   | First request after a real model transition or Pi compaction; at least 8k estimated token savings |
| Warm-cache   | After eight user entries; at least 32k savings                                                    |
| Changed tail | Small final fallback epoch                                                                        |

An ordinary stale result first needs four later user entries and enough size to matter. Context does not measure context pressure, trigger compaction, alter compaction settings, or decide when Pi compacts.

## Pruning milestones

Each persisted epoch appears as a quiet Context-owned transcript entry, for example:

```text
context · pruned 6 results (~18k tokens) · warm
```

Expanding it shows a bounded reason breakdown. These are custom session entries outside model context. Older epochs without per-decision savings remain replayable without an invented token total.

## Recall

Use the tool-call ID from an elision stub or recallable outcome.

| Request                                                              | Effect                                                        |
| -------------------------------------------------------------------- | ------------------------------------------------------------- |
| `{ "id": "TOOL_CALL_ID" }`                                           | Return the original stored content blocks                     |
| `{ "id": "TOOL_CALL_ID", "selector": { "lines": "40-80" } }`         | Return a positive 1-indexed line or range from one text block |
| `{ "id": "TOOL_CALL_ID", "selector": { "find": "AssertionError" } }` | Search one text block case-insensitively with bounded context |

The selector union makes `lines` and `find` mutually exclusive. Search returns at most ten source-ordered matches with three surrounding lines and reports truncation or omitted matches. A search with no matches succeeds; missing content, invalid ranges, unsupported content shapes, and empty slices are errors.

Recall preserves a bounded source label for terminal presentation but does not add it to model content or alter pruning decisions.

## Bash outcomes

Choose `bash_outcome` for an action or validation when exit status alone answers the question. Choose ordinary Bash for discovery, diagnostics, listings, diffs, warnings, skipped tests, test counts, or any successful output needed for reasoning.

On successful output, `bash_outcome` returns concise status and retains the ordinary bounded result for immediate recall. Inspect that execution through `context_recall` rather than rerunning it solely to recover output. Success without output remains concise; failures remain directly visible. Its optional display label is normalized, control-safe, and limited to 80 Unicode code points.

`bash_outcome` uses Sandbox's ordinary Bash path and does not create another confinement boundary.

## Managed-process outcomes

`get_process_result` and `stop_process` default to bounded visible output. For `get_process_result`, choose `result: { mode: "outcome" }` when only point-in-time status matters; `stop_process` retains its scalar `resultMode`. Successful outcome results return concise status and exact recall guidance. Failed process output remains visible.

Recall can recover that retained snapshot after compaction or process-record eviction, but it cannot recover output produced later or already dropped by retention. Request a later output-mode result for newer output. Tail and literal-search filters require output mode.
