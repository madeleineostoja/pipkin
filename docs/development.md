# Development

Pipkin is developed and released as one root npm package. Run commands from the repository root with npm.

| Purpose                 | Command                                    |
| ----------------------- | ------------------------------------------ |
| Install dependencies    | `npm install`                              |
| Typecheck               | `npm run check`                            |
| Lint                    | `npm run lint`                             |
| Check formatting        | `npm run format:check`                     |
| Apply formatting        | `npm run format`                           |
| Run all tests           | `npm run test`                             |
| Test one feature path   | `npm run test -- src/extensions/<feature>` |
| Test one Vitest project | `npm run test -- --project <project>`      |

## Runtime baseline

Pipkin declares `^0.99.0` for `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui`. Node.js remains `>=24`; Windows is unsupported. The manifest is one complete ordered bundle, not a supported menu of entrypoints.

| Verification environment                         | Pi integration packages        | Other Pi runtime packages                            | Node.js   |
| ------------------------------------------------ | ------------------------------ | ---------------------------------------------------- | --------- |
| Intended root installation (`package-lock.json`) | AI, coding-agent, TUI `0.99.1` | agent-core, codemode, MCP, Chord, telemetry `0.99.1` | `24.20.0` |
| Controlled minimum installation                  | AI, coding-agent, TUI `0.99.0` | agent-core, codemode, MCP, Chord, telemetry `0.99.0` | `24.20.0` |

The pre-cutover baseline above used TypeScript `5.7.3`, Vitest `4.1.10`, and the now-retired adapter; unrelated root dependencies retained their lockfile versions. Native MCP/discovery cutover is tested against the intended root installation, not a new minimum-version claim. Both installations were typechecked and tested, including complete bundle loading/binding, native factory coexistence, virtual-model dispatch, managed final-action completion, queued/handled steering, cancellation, cleanup-before-wait delivery, and fixture-based native Codex compaction/replay. These are verified versions; the rest of the caret range is a dependency assumption, not a claim of testing every release. No live credential/provider operation or remote Codex compaction smoke was performed.

To repeat minimum-version verification in a disposable checkout:

1. Save `package.json` and `package-lock.json` outside the checkout. Install the intended root lockfile first with `npm ci`.
2. Temporarily pin the three Pi dev dependencies to `0.99.0`. Override those same packages throughout the tree using npm's `$<dependency-name>` references, and override `@earendil-works/pi-agent-core`, `@earendil-works/pi-codemode`, `@earendil-works/pi-mcp`, `@earendil-works/chord`, and `@earendil-works/pi-telemetry` to `0.99.0`.
3. Run `npm install` using the saved root lockfile as the starting point; do not ignore the lockfile and accidentally upgrade unrelated dependencies. Check `npm ls` for every package listed above, including nested copies.
4. Run `npm run check` and `npm run test`. The bundle and managed lifecycle tests use local fixtures, not provider credentials.
5. Restore both manifests in a `finally`/shell exit trap and run `npm ci`. Check that the intended versions are installed again. Never commit the temporary pins or fixture lockfile.

Pi's public SDK lifecycle includes `bindExtensions()` before prompting and `session_shutdown` before child disposal. Managed completion remains a directly declared, model-only final action; callers join cleanup before receiving terminal delivery. See [native capabilities and discovery](architecture.md#native-capabilities-and-discovery) for native factory ownership and test-owned inventory. Local fake MCP tests exercise native transport/discovery and hidden-tool denial; they do not verify live Figma authentication. Context obtains the lazy Codex API through Pi's host-mapped `@earendil-works/pi-ai/compat` export, without a package-local Pi dependency or native ESM bridge. The bundle suite loads an isolated managed-install layout with only runtime dependencies and proves capture alone does not fetch.

## Test the boundary you changed

`npm run test` runs explicit Vitest projects for adjacent feature tests, shared-library tests, Implement's serialized suites, and the bundle contract under `test/bundle/`.

For a focused change:

1. Run the nearest adjacent test file, path, or project.
2. Run `npm run check` for TypeScript changes.
3. Run the bundle project when changing entrypoints, registrations, internal imports, lifecycle order, or the root manifest.
4. Finish with the root checks proportionate to the change.

```sh
npm run test -- --project bundle
```

The bundle suite uses Pi's installed loader against `package.json#pi.extensions`. Do not replace it with direct file imports: loader identity and ordered registration are product contracts.

Feature tests import responsibility-named behavior modules, never `index.ts`. Keep tests beside their owner and preserve their Vitest filename suffix and project assignment when moving them.

## Add or change a feature

A new feature requires:

1. a thin Pi registration root at `src/extensions/<feature>/index.ts`;
2. intentional placement in `package.json#pi.extensions`;
3. adjacent behavior and behavior tests in responsibility-named modules;
4. updated bundle expectations for public registrations or ordering; and
5. an updated concept guide and README summary.

Add a feature subfolder only for an established cohesive cluster. Keep feature-specific code with its owner, move generic code to `src/lib/` only after two features need it, and use an explicit narrow mapping for cross-feature imports. Production code must not import another feature's `index.ts` or an undeclared internal path.

Read [Architecture](architecture.md) and repository `AGENTS.md` before changing lifecycle, shared state, extension APIs, or bundle order.
