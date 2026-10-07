# Agents

Pipkin provides repository-preserving **Explore** for multi-step codebase discovery and **Review** for independent assessment of a concrete artifact, not implementation workers. Use a separate context when it helps ownership, not merely because the primary session is long. Use LSP for one known-symbol question and ordinary reads for a couple of obvious files. Children do not inherit the parent conversation: supply a self-contained prompt with the objective, scope, relevant context and artifact paths, and expected output.

## Start, recover, then join

The six public tools use the `agents` namespace. [Native discovery](../configuration.md#native-discovery) owns direct/deferred exposure and setup:

| Tool            | Purpose                                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `agent_start`   | Start `type:"Explore"` or `type:"Review"` with a complete `prompt` and optional safe `description`, exact `model`, or `thinking` override |
| `agent_list`    | Recover public session-owned IDs, newest first; optional `offset` (default 0) and `limit` (default 25, 1..25)                             |
| `agent_inspect` | Immediate snapshot; optional `includeProgress` (default false)                                                                            |
| `agent_wait`    | Join an `id` through cleanup; optional positive finite `timeoutSeconds` and `includeProgress`                                             |
| `agent_steer`   | Send an `id` a nonempty `message`; report Pi's actual `queued` or `handled` delivery                                                      |
| `agent_stop`    | Cancel an owned `id` and join cleanup                                                                                                     |

For example, start with `agent_start`:

```json
{
  "type": "Explore",
  "prompt": "Trace how review policy reaches publication. Cite relevant files and tests.",
  "description": "Map review policy"
}
```

Continue independent work, then call `agent_wait({id:"explore-1"})` when the result becomes a dependency. An immediate join is appropriate when nothing else can proceed. Use inspection deliberately, not polling.

Accepted jobs belong to the session, not the initiating script. If a codemode script starts a job and then throws without printing its ID, `agent_list` recovers it without repeating the work. Lists and snapshots never return prompts, raw tool output, private Implement workers, or another session's IDs. An omitted description uses a role label, not a prompt excerpt. Pagination filters ownership before slicing and returns `nextOffset` only when more owned records exist.

Results carry `ok`, an `agent` snapshot (ID, role, safe description, state, known timing, and `cleanup:"pending"|"complete"`), and relevant operation data. Final success returns `result:{text,truncated}` only after cleanup; text uses Pi's existing default byte/line bounds. Requested `progress:{text,truncated,partial:true}` is untrusted partial work, not a final answer. Its truncation flag includes clipped assistant excerpts, omitted records, and section limits. Failed or stopped jobs return `ok:false` with their snapshot and requested progress. Completed agents remain final-result only.

Errors use `not_found`, `invalid_arguments`, `unavailable`, `cancelled`, `agent_failed`, or `stopped`. Missing and unowned IDs have the same `not_found` result. These schema-bearing errors are inspectable data in codemode, not necessarily thrown exceptions.

## Waiting, steering, and lifetime

Wait timeout returns `ok:true,waitOutcome:"timed_out"` and leaves the child running. Cancellation returns `ok:false,waitOutcome:"cancelled"` and cancels only the waiter. Omitted timeout waits until settlement or cancellation; the finite timeout maximum is 2,147,483.647 seconds. A later wait retrieves the same retained result without rerunning work.

Stop initiates cancellation and joins actual cleanup. If the caller aborts while cleanup is pending, the snapshot reports `state:"stopping",cleanup:"pending"`, not fabricated terminal cleanup. Use `agent_wait` subsequently to observe settlement. Session replacement/shutdown stops and settles owned agents; ordinary script completion or failure does not.

`queued` steering enters after the child's current assistant turn finishes its tools. `handled` means a child extension consumed the message; neither claims immediate model execution. Unknown or settled jobs cannot be steered.

## `/agents`

The dashboard presents one scannable roster with status glyphs, hierarchy, current description, and elapsed time. Live agent groups appear before retained history without separate section headings. Selecting an agent opens a landing page with status, elapsed time, available context and cost, and a bounded failure reason when relevant. From there you can view Activity, view a completed Result, stop running work directly, or return to the roster.

Activity is a full-width chronological timeline: assistant prose is rendered as Markdown; tool calls are compact summaries with bounded arguments and status; steering is quoted; and retry and compaction events remain visible. It never replays complete tool output. Steerable agents have an inline bordered guidance editor beneath the timeline: type normally, use Enter to send and Shift+Enter for a new line; arrows scroll the timeline. Escape returns to the landing page.

A completed agent’s Result is a separate scrollable Markdown page containing its complete final result. Activity deliberately excludes that final result. Public failures are notified once and remain inspectable while the parent session lives.

The shared live Activity projection removes settled rows immediately. It keeps descriptions and elapsed time visible when collapsed; nested exploration and context/usage/cost appear on expansion. See the [Activity presentation contract](interface-and-personality.md#ui) for limits and ownership exclusions.

Implement owns its scheduler-managed agents. `/agents` shows only their non-selectable active count, not individually controllable workers. Public lifecycle tools cannot inspect or control them. Child sessions are in-memory and never appear in `/resume`; no child resume durability is promised.

## Worker capabilities and restrictions

Tool-using workers explicitly load native codemode/tool-search factories, activate them with supported child settings/loadout, and complete `bindExtensions()`. They load the entire ordered Pipkin bundle, independent of a user's accidental global native activation. Each child has its own event bus and isolated extension, Browser, and Processes state.

The SDK tool allowlist filters actual registered/callable tools, including deferred tools and later registration. Workers inherit authorized parent active tools and deferred/codemode capabilities, subject to role and caller exclusions. All six public agent operations are denied. Repository-preserving children also deny callable `edit` and `write`; guessed names and discovery cannot bypass policy. Private `pi_managed_complete` stays directly declared, model-only, exactly-once and final-action, separate from public domain JSON.

Eligible Review and Implement workers receive directly declared private synchronous `explore({question,breadth?})`, using the `low` preset and `quick|medium|very thorough` breadth (default `medium`). Explore and nested children cannot receive or execute it recursively. It returns bounded research text, terminal status, truncation, and relevant failure/partial progress. Failed or stopped exploration includes the same explicitly partial, untrusted progress excerpt in direct content and structured results; it is not a successful final answer. Parent cancellation and sustained inactivity stop the nested child; pending synchronous calls abort normally. Session-owned asynchronous work does not disappear when a script returns or fails.

Each worker receives a unique ephemeral Context output scope and host-assigned attempt provenance before initialization, keyed to its actual event bus. Workers can list/read their own captures, not sibling captures or private parent evidence. A host-held promotion lease survives producer shutdown; the managed finalization callback runs after shutdown flushes and before child disposal/scope release, on success, failure, stop, and cancellation. Handoff failures reject required completion but still dispose/release resources. [Context](context.md#retained-output) owns record bounds, retention and authorization; [Implement](implementation.md#verification-and-execution-artifacts) consumes this one private handoff to validate selected completion references and own durable run artifacts, not this scope mechanism. No incidental worker-output archive or parent public access is added.

Where Bash is available, use output/status presentation according to the needed result, managed processes only while independent work continues, and `output_list`/`read_output` for immutable evidence. Explore and Review may record qualifying incidental friction through `papercut_record`; this grants no source, dependency, or Git mutation.

### Native documentation

Workers select only the existing native server named `context7`. No entry means no documentation endpoint, with other research capabilities unaffected. Trusted project configuration replaces the global selected entry wholesale; untrusted project files are not read. Invalid, disabled, or hidden choices do not fall back to a different server or credential.

The native hidden default exposes only `resolve-library-id` and `query-docs`, deferred and intersected with user-hidden choices. Generated native tool label/namespace metadata is checked; unrelated servers (including Figma), resource tools, and newly announced unknown tools remain unreachable. Native Pi owns transport, command/environment/header resolution, credential storage and shutdown. Workers have no MCP management/login commands. Auth-needed documentation remains unavailable until the user authenticates natively in the parent; workers do not launch login flows or copy credentials. See [Configuration](../configuration.md#worker-documentation) for setup.

## Filesystem and models

Public agents share the invoking filesystem, not isolated Git worktrees. Do not edit files owned by a public child. [Implement](implementation.md) provides workspace isolation and controlled publication.

Enabled macOS Sandbox children snapshot repository-read-only mode at creation: source/Git writes are denied while supported temporary/cache/dependency runtime writes remain available to Bash. Later `/sandbox` changes affect future children only. Linux remains instruction-only; this is trusted-agent accidental-write protection, not hostile-code isolation. [Safety](safety.md) owns enforcement details and Readonly's unchanged confirmation workflow.

| Role                                                       | Preset   |
| ---------------------------------------------------------- | -------- |
| Explore, including nested exploration                      | `low`    |
| Review; Implement planning and review                      | `high`   |
| Implement implementation, revision, reconciliation, repair | `medium` |

Known exact public overrides apply to one invocation only. Virtual selections use Pi's supported runtime dispatch without an additional router or selector-specific limits. See [Configuration](../configuration.md#model-presets).

Pipkin does not provide arbitrary delegation, recursive Explore, custom agent-definition files, persistent child memory, a public dependency scheduler, or public worktree creation.
