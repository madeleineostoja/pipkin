# Architecture

Pipkin is one product with several runtime owners. Split entrypoints make registration, lifecycle, ordering, and failure boundaries explicit; they are not separately supported packages.

## Ordered bundle

The root manifest loads one complete bundle:

1. Sandbox
2. Readonly
3. Context
4. UI
5. Personality
6. Guidance
7. LSP
8. Processes
9. Subagents
10. Implement
11. Web Fetch
12. Browser
13. Papercuts
14. BTW

Order is a runtime contract. Sandbox and Readonly form the safety prefix. Processes follows LSP and precedes Subagents; Subagents precedes Implement because Implement consumes its managed runtime. Web Fetch follows Implement while retaining separate ownership of direct public-URL retrieval. Browser follows Web Fetch and owns lazy, isolated rendered-page state without sharing Web Fetch, Processes, or UI internals. Papercuts follows Browser.

The bundle integration suite loads the actual manifest through Pi's loader and verifies inventory, public registration ownership, source provenance, startup and reload behavior, internal imports, and safety ordering.

## Source ownership

Each feature owns a Pi-only registration root at `src/extensions/<feature>/index.ts`. It constructs dependencies, registers with Pi, attaches lifecycle or event handlers, and performs simple wiring. Business behavior and substantial handlers live in responsibility-named modules beside their tests.

Feature subfolders represent cohesive clusters, not a universal template. Implement currently has a `scheduler/` cluster; features do not gain generic `internal/`, `src/`, `api/`, or wrapper layers for symmetry.

Generic modules used by at least two features live in `src/lib/`. There is no barrel: consumers import concrete capabilities through `#lib/*`.

## Cross-feature capabilities

Cross-feature coupling is explicit, narrow, typed, and producer-owned.

| Capability                  | Owner          | Consumers                                | Purpose                                                                                                                          |
| --------------------------- | -------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `#sandbox/runtime`          | Sandbox        | Subagents                                | Snapshot Sandbox state and requested child write mode at child creation                                                          |
| `#sandbox/bash`             | Sandbox        | Processes                                | Start a managed execution lease without exposing Sandbox state or child processes                                                |
| `#context/retained-output`  | Context        | Sandbox, Processes, Subagents, Implement | Bind explicit host scopes, reserve/commit immutable execution evidence, authorize retrieval, and prepare private child promotion |
| `#subagents/runtime`        | Subagents      | Implement                                | Run trusted managed agents                                                                                                       |
| `#subagents/completion`     | Subagents      | Implement                                | Share the stateless managed-completion final-action protocol                                                                     |
| `#personality/session-name` | Personality    | Implement                                | Generate session names and carry the event-bus-keyed Implement naming-ownership claim                                            |
| `#ui/activity`              | UI             | Processes, Subagents, Implement          | Publish bounded source-qualified live activity                                                                                   |
| `#ui/status`                | UI             | Status producers                         | Publish immediate footer status without transferring producer ownership                                                          |
| `#lib/ui/*`                 | Shared library | UI consumers                             | Reuse concrete presentation helpers                                                                                              |

Consumers never import another feature's registration root. A new mapping requires a real consumer, an acyclic dependency, a narrow producer-owned type, a `package.json#imports` declaration, Pi Jiti/Vitest/TypeScript resolution coverage, and updates to this guide and `AGENTS.md`.

Guidance contributes concise cross-tool strategy and external-content authority through native structured prompt sections. It has no production tool catalogue. Native namespace/exposure metadata owns discovery; `test/bundle/inventory.ts` owns expected public inventory and provenance. Feature descriptions and schemas retain capability details; result owners retain recovery instructions.

UI owns generic presentation, not producer state, cleanup, or terminal delivery. Activity is a bounded live-work projection: producers publish only queued, running, or waiting records and remove them immediately at settlement. It omits prompts, commands, cwd, raw output, hidden runtime objects, provider payloads, cost, and aggregate token telemetry; Subagents may project current context usage and one bounded latest-assistant preview. Personality owns voice and identity, including the asynchronous-context fresh-session welcome and naming generation; Implement owns active-run lifecycle and applies its authoritative name. UI remains the sole Pipkin footer owner.

## Native capabilities and discovery

Native Pi exclusively owns MCP, including `/mcp` in unconfigured sessions, native `mcp.json`, discovery, and authentication. Pipkin has no adapter, credential abstraction, synthetic identity, environment bridge, or replacement research dispatcher. [Configuration](configuration.md#manual-cutover) owns manual cutover and the live Figma operator gate.

LSP registers nine deferred `lsp_*` operations with closed inputs and schema-matched structured results, not a dispatcher alias. Registration/projection belongs to `lsp/tool.ts` and `lsp/contracts.ts`; normalization, document synchronization, protocol cancellation, workspace/server routing, and the shared lazy pool remain single runtime owners. No operation registers background diagnostic delivery or on-save checks. [Workflow tools](features/workflow-tools.md#lsp) owns coordinates, freshness, limits, and error codes.

Sandbox `bash` is direct. Other public Pipkin operations are deferred and callable through native codemode, with useful namespaces (`execution`, `lsp`, `browser`, `web`, `agents`, `implement`, `papercuts`). Private `explore` is deferred only in authorized worker sessions; `pi_managed_complete` is model-only. User-enabled native tools remain intact. Native callable-catalogue filtering, not discovery or annotation hints, is the authorization boundary. The CLI supplies native factories; SDK hosts explicitly supply them and bind extensions. [Configuration](configuration.md#native-discovery) owns parent settings, diagnostic delivery, and the current slow-startup limitation.

## Separate loaders and explicit coordination

Pi loads entrypoints through separate Jiti instances. Shared pure helpers and typed protocols are safe; mutable module-singleton identity across loader graphs is not.

Stateful cross-entrypoint coordination uses an explicit host identity:

- Subagents' coordinator, Sandbox's child-mode handoff, and Personality's Implement naming-ownership claim are keyed by Pi's event bus.
- Sandbox installs its managed-execution lease binding only after constructing the session runtime and revokes it during shutdown.
- Context installs an event-bus-keyed output-scope binding at session start. Producers freeze scope/branch/source identity before dispatch and retain issued handles across binding revocation. Context imports no producer; the former Context-to-Sandbox edge is absent.
- Subagents prepares a Context child grant on the actual child event bus before initialization, with a unique host-assigned attempt ID. The child takes a unique ephemeral scope. After producer shutdown flushes, a host-only managed finalization callback can export validated records via its promotion lease, before child disposal and scope release. All settlement and initialization-failure paths release resources; handoff failure rejects required completion. Parent provenance grants no public worker-output access. Implement consumes the single managed finalization handoff to validate selected execution claims through the granted Context lease and save artifact-relative v11 verification/output under its run hierarchy. Host-observed candidate provenance does not attest later changes; reported inspections, checks not run, and reader-only terminal v10 prose remain distinct. Promotion failure rejects reliance without preventing disposal or lease release.
- Each child receives a distinct event bus, isolated Processes runtime, in-memory SessionManager, full ordered bundle, explicitly activated native codemode/tool-search, and an SDK allowlist that filters the actual callable catalogue even after late registration. Public agent controls are never callable in workers; private completion stays model-only. Subagents' native MCP selection exposes only approved Context7 documentation metadata with hidden-default policy and no unrelated extension registrations or worker authentication commands.
- Child Sandbox policy is a spawn-time snapshot, not live synchronization.

On enabled macOS sessions, repository-read-only children deny source and Git writes after dynamic Seatbelt allows, while exempting discovered package `node_modules` trees as disposable Bash runtime state and validated configured generated roots. Direct `write` and `edit` may use only canonical temporary roots and those configured generated roots, never tracked source, Git, or Pipkin configuration. Linux has no kernel enforcement. This is trusted-agent accidental-write protection, not hostile-code isolation.

## Shared concurrent files

`src/lib/file-lease.ts` provides OS-backed leases over persistent regular-file anchors. Probing is diagnostic only and never grants mutation authority; the native adapter fails closed when it cannot provide the contract.

`src/lib/git.ts` serializes updates to the repository's common `.git/info/exclude`. Checkout-local features call `ensureGitInfoExclude()` instead of editing the file directly or inventing another lock.

## Lifecycle and state

Long-lived resources start at `session_start` or on demand and dispose idempotently at `session_shutdown`. Features remove direct `pi.events` listeners during disposal. Sandbox bindings and pending child handoffs are also disposed idempotently. Context closes new output admission without awaiting later producer shutdown handlers; issued reservations and promotion leases drain independently. Durable sidecars are not deleted at shutdown; ephemeral scopes release only after captures, requested handoff, and disposal. [Context](features/context.md#storage-and-cleanup) owns storage limits and operator cleanup.

State belongs to the narrowest durable owner:

- UI and agent activity belongs to the session;
- Implement state belongs to a checkout;
- Papercuts belongs to the canonical primary worktree;
- repository policy belongs under Pi's project configuration directory in `pipkin/` (currently `.pi/pipkin/`);
- personal model routing, native Pi credentials, and logs belong under Pi's agent directory.

See [Configuration and state](configuration.md) for concrete paths.

## Testing boundaries

Feature and shared-library tests stay beside their behavior owners and never import an entrypoint. Root Vitest projects isolate suites and preserve Implement's serialized execution policy.

`test/bundle/` owns the assembled-product contract. It catches failures isolated imports cannot: Pi loader resolution, extension inventory, registration provenance, lifecycle order, and unsupported package topology.
