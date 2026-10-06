# Repository Guidelines

## Product and structure

- Pipkin is one root npm package and one complete ordered `package.json#pi.extensions` bundle. Features are runtime owners, not independently distributed products; filtered entrypoint subsets are unsupported.
- Feature source and adjacent tests live in `src/extensions/<feature>/`. Each feature has a Pi-only `index.ts` registration root containing only dependency construction, registration, lifecycle/event hookup, and simple wiring.
- Business behavior and substantial handlers belong in responsibility-named feature modules. Feature tests import those owners, never an `index.ts`; `test/bundle/` owns entrypoint loading and registration provenance.
- Keep tests beside their behavior owner. Add a feature subfolder only for an established cohesive cluster; do not impose universal `internal/`, `src/`, `api/`, or wrapper layers.
- Shared generic modules and adjacent tests live in `src/lib/`. It is a bottom layer with no barrel.
- Bundle integration tests live in `test/bundle/`. User-facing documentation is concept-oriented under `docs/` and `docs/features/`.

## Documentation

- `README.md` is the concise product introduction and navigation surface. Put exact configuration, operational contracts, limits, and internals in their owning concept guides under `docs/`; summarize and link from the README instead of duplicating them.
- Write for progressive disclosure: lead with purpose and ordinary use, then cover limits, recovery, and implementation detail. Use tables for inventories and comparisons, lists for procedures, and prose for concepts and rationale.
- Keep human slash commands, keyboard shortcuts, and model-facing tools in separate inventories. Format commands, tools, paths, configuration keys, and code identifiers as code.
- Give each fact one authoritative documentation owner. Cross-reference that owner when another guide needs context, especially for exact defaults, paths, limits, safety boundaries, and model routing.
- Verify public command and tool inventories against `test/bundle/contract.test.ts` and exact behavioral claims against the owning source before handoff. Update the relevant guide and README summary when public behavior changes.
- Prefer concise paragraphs and stable product terminology. Use **Implement** for the feature and “implementer” only for its worker role.

## Scope

- This is for personal use by one user. When carrying out solution design you do not need to account for general user adoption, configurability, maintaining backwards compatibility, etc
- Windows is unsupported. Do not add Windows-specific compatibility or test accommodations
- Gemini tool-schema compatibility is out of scope. Do not weaken public tool schemas solely for Gemini's function-schema limitations.

## Imports and ownership

- Use relative imports within a feature.
- Import concrete generic helpers through `#lib/*`, for example `#lib/file-lease`.
- `#sandbox/runtime` lets Subagents request Sandbox-owned child-preparation intent and snapshot the parent enabled state/write mode at child creation; it does not encode Subagent roles. Enabled macOS repository-read-only children protect source and Git authorities while discovered package dependency trees remain disposable Bash runtime state; direct write/edit may use canonical temporary roots but remains repository-denied. `#sandbox/bash` lets Processes start Sandbox-owned managed execution leases for the current host; it never exposes Sandbox runtime state or a child process. `#context/retained-output` lets Sandbox and Processes reserve and commit immutable execution captures through an explicit event-bus-keyed Context scope. Context owns authorized raw-ancestry list/read, unique ephemeral child grants, host-assigned attempt provenance, validated promotion leases/export, and close/drain/release; it imports no producer. Subagents prepares child grants on the actual child bus before initialization with unique host-assigned attempt identity; its host-only managed finalization callback receives a promotion lease after producer shutdown flushes and before child disposal/scope release, including failure/stop paths. Native SDK tool allowlists filter actual worker callable catalogues after late registration; public agent lifecycle controls remain parent-only. Subagents owns only fixed Context7 selection/exposure and bounded diagnostics; native MCP owns transport/authentication. Implement consumes Context's typed promotion lease and execution schema through `#context/retained-output`, validates selected completion claims against the granted attempt/worktree, and atomically saves run-owned evidence before disposal/release. No ephemeral reference becomes durable verification. Issued handles survive binding revocation so Context's early shutdown callback can close admission without waiting for later producer flushes. `#subagents/runtime` lets Implement consume the managed agent runtime, and `#subagents/completion` exposes its stateless managed-completion final-action protocol. `#personality/session-name` lets Implement generate active-run session names through Personality's stateless identity capability and emit the narrow event-bus-keyed naming-ownership claim that cancels ordinary naming after a run starts. `#ui/activity` lets Subagents, Implement, and Processes publish bounded generic activity through the UI-owned event capability. `#ui/status` lets status producers publish immediately through the UI-owned stateless footer capability. `#lib/ui/*` resolves shared presentation helpers. Production code must not import another feature's `index.ts` or an unlisted extension internal.
- Direct capability coupling is allowed only when the producer owns the capability, the dependency is narrow and typed, the graph is acyclic, and the import neither registers an extension nor assumes mutable module-singleton identity.
- Add a new cross-feature mapping only after there is a real consumer. Define the narrow source-owned capability, add its `package.json#imports` mapping, cover Pi Jiti/Vitest/TypeScript resolution, document the dependency here and in `docs/architecture.md`, and keep the producer registration root private. UI owns the sole bounded live-work Activity projection, generic footer-status presentation, and presentation-only native MCP/codemode/tool-search renderer adapters; it never owns producer cleanup, terminal delivery, or native execution/discovery/authentication. Feature-owned semantic tool renderers remain with their owners and share generic machinery through `#lib/ui/tool-result-renderer`. Activity contains only queued, running, or waiting records, which producers remove immediately at settlement; its bounded projection keeps descriptions and duration collapsed-visible, with nested subagents, subagent context/usage/cost and latest assistant preview, and process commands expanded-only. It never includes prompts, cwd, raw output, or provider payloads; `docs/features/interface-and-personality.md` owns its exact presentation contract. `#ui/status` is UI-owned and may be consumed by producers such as Sandbox, Readonly, and Papercuts; it never imports them or registers the UI extension. Personality owns its fresh-session Welcome header and identity behavior, including the stateless `#personality/session-name` capability and event-bus-keyed Implement naming-ownership claim consumed by Implement, while UI owns generic presentation infrastructure.
- Keep feature-specific code with its owner. Add a `src/lib` module only when at least two features need it.
- `src/extensions/guidance/` owns concise cross-tool strategy and external-content instruction authority through native structured prompt sections, not a production tool catalogue. Keep Guidance concise and strategic: do not duplicate owning-tool schema semantics, enumerate obvious use cases, or script decisions the model can infer. Pipkin-owned public tools must not add `promptSnippet` or `promptGuidelines`. Sandbox Bash owns the typed execution/presentation/retention contract while reusing native output accumulation; it is not an exact native-definition metadata mirror. Tool-result owners keep complete model-facing prose and bounded selected output in `content`, bounded normalized metadata in `details`, and a feature-owned one-to-three-line semantic `renderResult` summary; Sandbox `bash` may use supported native presentation where accurate, but supplies matching structured execution data.
- Feature descriptions and schemas remain with their owners. Keep public tool parameter roots object-shaped for broad provider interoperability, and use nested unions—discriminated when variants have a natural tag—when action-specific fields or mutually exclusive selections materially improve the contract. Runtime validation owns semantic, bounded, and stateful constraints rather than compensating for an intentionally broad public schema. Every model-supplied property, including nested fields and private managed completions, explains its meaning and material constraints; structural checks enforce presence while semantic usefulness remains a review obligation. Update test-owned inventory/provenance in `test/bundle/` when adding or removing a public tool. Lead tool descriptions with capability and material selection boundaries; keep field-specific meaning and defaults in schemas, cross-tool strategy in Guidance, and recovery in results. Use useful native namespaces; Sandbox `bash` and a small decision-shaping public core are direct, other public tools are deferred/codemode-callable, authorized private `explore` is direct, and private completion is model-only. `docs/configuration.md#native-discovery` owns the exact public exposure inventory. Native discovery and annotations never grant permission. Native Pi exclusively owns MCP configuration/authentication/discovery and `/mcp`; Pipkin has no Reference credential or transport owner.

## Lifecycle

- Pi loads entrypoints through separate Jiti instances. Share pure helpers and explicit capability modules, not mutable module singletons. Sandbox's executable Bash capability rendezvous through a generation-scoped binding keyed by `pi.events`; Sandbox installs it after session runtime construction and revokes it before reset and disposal.
- Start long-lived resources at `session_start` or on demand. Dispose them idempotently at `session_shutdown`.
- Explicitly remove direct `pi.events` listeners during disposal. Stateful cross-entrypoint coordination needs an explicit host identity; the Subagents coordinator, Sandbox child-mode handoff, and Sandbox-owned managed execution lease binding are event-bus-keyed exceptions. Child Sandbox snapshots are immutable for their lifetime: later `/sandbox` changes affect only future children. Kernel enforcement is limited to enabled macOS Sandbox sessions; Linux remains instruction-only. This trusted-agent policy prevents ordinary accidental writes and is not hostile-code isolation.

## Commands

Use `npm` from the repository root.

- Install: `npm install`
- Typecheck: `npm run check`
- Lint: `npm run lint`
- Format: `npm run format`
- Check formatting: `npm run format:check`
- Tests: `npm run test`
- Focused tests by path: `npm run test -- src/extensions/<feature>`
- Focused tests by project: `npm run test -- --project <project>`

Vitest projects run adjacent feature/library tests and the root bundle contract. Feature project names match their `src/extensions/<feature>/` directory; additional projects are `lib`, `bundle`, `implement-unit`, and `implement-integration`. `vitest.config.ts` is the authoritative project registry. Prefer path filtering for ordinary focused work and project filtering when the configured project boundary matters. Keep Implement's serialized project intact; do not flatten all tests into one unisolated realm.

## Testing

- Do not add regression coverage for removed code. Test supported behavior in the remaining code rather than preserving cases tied to deleted logic.

## Development workflow

- To add a feature, create `src/extensions/<feature>/index.ts`, add it in its intentional position to `package.json#pi.extensions`, add adjacent behavior tests, extend `test/bundle/` if public registrations or ordering change, and update the relevant concept guide plus the root README.
- Root registration order is a runtime contract. Sandbox and Readonly lead the bundle; Processes follows LSP and precedes Subagents, which precedes Implement; Papercuts follows Browser.
- Prefer root-level validation before handoff. For TypeScript changes, run the narrowest relevant test and `npm run check`; run bundle tests when manifest entries, registrations, internal imports, or lifecycle ordering change.
- If changing Pi extension APIs or TUI integrations, verify against the local Pi docs referenced in the harness instructions rather than relying on memory.
