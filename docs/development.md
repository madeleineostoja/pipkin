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

Pipkin declares `^1.0.2` for `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui`. Node.js remains `>=24`; Windows is unsupported. The manifest is one complete ordered bundle, not a supported menu of entrypoints. UI uses Pi's native `registerToolRenderer()` API for presentation-only MCP/codemode/discovery adapters; older Pi versions are unsupported.

The root lockfile installs Pi `1.0.2`. Validate with `npm ci`, `npm run check`, and `npm run test`; use `npm ls` to confirm the installed Pi integration and runtime versions, including nested copies. The bundle and managed lifecycle suites use local fixtures, not provider credentials, and do not verify live Figma authentication or remote Codex compaction. The rest of the caret range is a dependency assumption, not a claim of testing every release.

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
