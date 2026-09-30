# Context

Long sessions accumulate tool output that is no longer useful verbatim. Context replaces eligible output with stable, reasoned stubs while preserving original transcript results for `read_output`. Context also owns immutable execution evidence, independent of outer script results.

## Compaction

Textual compaction always uses the snapshotted `models.low` preset, including manual `/compact`, `/compact <instructions>`, threshold compaction, and overflow recovery. Pi retains its normal summary format, split-turn handling, file-operation list, usage accounting, and retry behavior. If that preset or its provider route cannot complete, Context returns control to Pi's active-model compaction rather than saving a partial summary.

An uninstructed compaction can instead use an opaque server checkpoint only for the exact OpenAI Codex OAuth surface: provider `openai-codex`, API `openai-codex-responses`, the `https://chatgpt.com/backend-api/codex/responses` endpoint, and the same Codex model and ChatGPT account that created it. The protocol identity is `pipkin-codex-compaction-trigger-v1`; the normalized endpoint must match exactly. Native requests use a dedicated HTTP/SSE trigger, `store:false`, preserve configured `x-codex-beta-features` tokens, and add `remote_compaction_v2`. The transcript shows a stable marker, not a readable summary. On the next ordinary request Context validates the persisted checkpoint and replaces only its marker-and-kept-tail provider segment immediately before dispatch.

These checkpoints are not portable. A different provider, model, endpoint, API-key authentication, or ChatGPT account cannot continue one. Return to the original compatible Codex OAuth model/account to recover. Context warns and aborts the active turn through Pi when a persisted native checkpoint is malformed, incompatible, or cannot be uniquely replayed, rather than silently continuing without its authoritative context. Cancellation follows Pi's provider transport; it is not a guarantee that an already-started request or WebSocket send never reaches the server. It also cancels instructed compaction after native authority exists instead of converting opaque context into a lossy text summary. User cancellation launches no fallback. If initial native checkpoint creation fails, Context attempts the ordinary `models.low` textual route and writes a durable tool-style warning that identifies the fallback actually selected: `models.low` when its summary succeeds, or Pi's active-model compaction when it does not. Failures after native authority exists still cancel compaction because a textual summary cannot safely reconstruct the opaque context; those entries render as errors. Context also records a terminal error entry whenever Pi reports that any manual, threshold, or overflow compaction failed or was aborted; it identifies the trigger, whether extension-provided summary content was in use, and whether the interrupted turn would have retried after successful compaction, without persisting the raw provider error. Native routing entries retain their more specific fallback outcome. Failure entries contain only bounded structured status or an allowlisted native reason; raw provider errors, payloads, credentials, and account data are never included. Routes that are not eligible for native compaction continue directly through `models.low`. Durably recorded failure entries remain outside model context.

Context captures the active canonical session projection, including native omission edits, with Pi's effective runtime system prompt and tool declarations kept distinct from persisted system/loadout state. Public Codex `streamSimple` captures the expected SSE payload through `onPayload` and stops before any network request; authentication, headers and endpoint overrides come from Pi's model registry. It preserves the provider's opaque compaction item, including additional provider fields, with real user continuations in their original order. It adds no transcript-string limits, artifact-size caps, continuation-count truncation, or separate compaction deadline; provider context limits and Pi cancellation still apply. Validation covers recognizable checkpoint metadata, route compatibility, branch lineage, a completed compaction artifact, and a unique replay target—not local-file tamper detection.

Context stores checkpoint metadata append-only with Pi's normal compaction entry. Reload, resume, and a fork containing that entry reconstruct its authority; a fork before it has none. Replay derives the exact marker-and-kept-tail segment from the canonical projection at the checkpoint entry. Only one uniquely matching provider-input segment is replaced; later turns remain outside it. Checkpoint-era content changes or omissions that invalidate this segment abort replay instead of discarding native edits. Automatic pruning protects that opaque replay segment and can prune later output. `read_output` continues to retrieve authorized original results across textual and native compaction.

Fixture tests cover no-network payload capture, strict route identity, continuation/artifact preservation, canonical omission/replacement replay, resume/fork, and safe initial fallback versus authoritative refusal. They do not prove the private remote trigger is currently available. No live provider smoke was performed for this migration; that requires separate operator authorization and disposable synthetic context.

## Pruning behavior

A tool result appears in full when produced. At `turn_end` or `agent_before_settle`, Context may propose native content-replacement `context_edit` drafts for successful output that is:

- stale after later user entries;
- superseded by a later edit or write;
- duplicated or covered by a later read; or
- low-risk Bash output already consumed by the assistant.

Every candidate must have been demonstrably consumed by a later completed assistant request. A preceding tool-call message, tool completion, or a failed/aborted response does not establish consumption. In particular, fresh output present at `turn_end` stays full for its first exposure. A competing native replacement is fresh at its edit: older assistant/user entries establish neither consumption nor staleness of its new content. Errors are never eligible.

Drafts target the canonical projection's source entry IDs and replace only content. Pi owns boundary validation, persistence and canonical application; Context returns no separate local message overlay. Context does not change the local model view when drafts are rejected and gives a bounded warning when non-acceptance is observed at the next boundary. Native boundary disk-write rollback is Pi-owned, not a private Context mutation. Native competing omissions/replacements are respected, and already-stubbed results are not edited repeatedly. Original raw results and usage remain unchanged and retrievable after compaction.

Each stub names the reason and source call:

```text
[read result elided: covered by a later read of PATH at user entry 8. Call read_output({reference:"transcript:v1:OPAQUE_ID"}) to retrieve.]
```

| Opportunity  | Selection rule                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Known-cold   | An actual supported boundary before a request warms a real model-transition/compaction prefix; at least 8,000 estimated tokens saved |
| Warm-cache   | Eight user entries since the last warm milestone; at least 32,000 savings and suffix damage/savings <= 1.5                           |
| Changed tail | Suffix damage <= 2,000 estimated tokens                                                                                              |

An ordinary stale result first needs four later user entries and at least 256 estimated tokens. Edits take effect for future requests at supported boundaries, not the former private pre-request timing. A cold opportunity already missed by a warming request is skipped, never carried forward as a stale cold flag. Context never forces another model turn solely to prune. Context does not measure context pressure, trigger compaction, alter compaction settings, or decide when Pi compacts.

## Pruning milestones

Each accepted batch includes a quiet Context-owned milestone with only kind, count, estimated savings and a bounded reason breakdown, for example:

```text
Context pruned: ~18k tokens (6 results)
```

Expanding it shows the reason breakdown. These custom entries stay outside model context. Resume/fork restores warm-policy counters from active-branch milestones; native edits alone own the visible stubs. Historical epoch entries remain renderable, including ones without savings, but their old decisions are neither reapplied nor migrated.

## Retained output

Use `output_list` to recover execution references, including calls made by a script that later threw. It lists only authorized bounded metadata, newest first with stable reference ties. Pagination uses `offset` (default 0) and `limit` (default 25, 1..25); counts and `nextOffset` describe authorized records only. Pruning stubs instead identify original transcript entries with a distinct opaque reference. Both authorization and transcript resolution verify the immutable raw source entry fingerprint, not just its session-local short ID. Copied entries remain accessible in genuine forks even without the origin session file; colliding IDs in unrelated history grant no access. Neither reference is a filesystem path.

| `read_output` input                                        | Effect                                    |
| ---------------------------------------------------------- | ----------------------------------------- |
| `{reference:"REFERENCE"}`                                  | Return bounded original text/image blocks |
| `{reference:"REFERENCE",selector:{lines:"40-80"}}`         | Positive 1-based line or inclusive range  |
| `{reference:"REFERENCE",selector:{tailLines:80}}`          | Newest 1..200 lines                       |
| `{reference:"REFERENCE",selector:{find:"AssertionError"}}` | Case-insensitive literal search           |

Selectors are mutually exclusive and require one textual source. A trimmed search literal is 1..256 UTF-8 bytes; search selects at most ten ordered matches with three context lines and reports omissions. No-match succeeds; invalid/empty slices and mixed/image selections fail. Text responses retain native byte/line bounds. Images remain native blocks in direct and structured content (up to 10 MiB, 4,096×12,000); codemode scripts forward them explicitly with `image(block)`. Successful retrieval is `ok:true` even when the source execution failed. `not_found` does not distinguish missing from unauthorized evidence; selection failures use `invalid_arguments`.

Authorization follows raw active-branch ancestry, not the compacted model projection. Resume, compaction, and forks containing the source anchor retain access; siblings and forks before it do not. Admission reserves origin session/file/branch and call identity before dispatch, so late settlement cannot attach to a switched session. A genuinely entryless capture is accessible only through its exact scope while still entryless. In-memory sessions and workers receive unique ephemeral scopes; worker provenance and host promotion are private capabilities, not automatic parent public-list access.

### Execution presentation

`bash` defaults to `presentation:"output"`. Choose `presentation:"status"` when exit status alone suffices; it suppresses only successful logs in both direct and structured output. Failures retain diagnostics, `isError:true`, actual known exit/signal, ISO timing, and `completed`, `failed`, `cancelled`, or `timed_out` state. `execution_failed`, `cancelled`, and `timed_out` identify command failures. Invalid arguments or blocked calls dispatch no process.

Retention is separate from execution: `retention:"retained"` includes `outputRef` only after immutable persistence; `retention:"failed"` reports `persistence_failed`, no reference, and available output with the true execution state. Bash captures its native bounded tail. Process snapshots retain the full bounded live tail, separately from their smaller display projection; see [Workflow tools](workflow-tools.md#managed-processes). Reading an earlier snapshot never observes newer output or reruns work. Former recall/outcome aliases and translation of old outcome IDs are not supported; raw historical transcripts remain intact.

### Storage and cleanup

Persisted sessions store version-1 sidecars under `<agent-directory>/pipkin/outputs/` (normally `~/.pi/agent/pipkin/outputs/`). Context uses generated scope/record names, exclusive atomic immutable writes, 0700 directories and 0600 files. Each record permits at most 1 MiB decoded text and 16 KiB metadata; encoded reads are capped at 8 MiB before parsing. Records contain bounded execution provenance/state, output completeness/drop information, and command/cwd previews with explicit truncation flags—not environments or arbitrary tool details.

Durable captures survive ordinary shutdown. There is no background GC, quota eviction, or historical migration. Operators may explicitly remove sidecars when they no longer need the evidence, but must account for surviving forks: deleting an origin session file does not prove its evidence is unused. Orphaned records may remain; their presence alone grants no retrieval authority.

Ephemeral captures have no resume promise. Context closes new admission at shutdown without awaiting later producer handlers. Issued handles can still flush; promotion leases retain worker records through export and child disposal. Ephemeral directories are released only when their holders and requested handoff are finished.
