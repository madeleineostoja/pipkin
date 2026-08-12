import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalRoot,
  SandboxPolicyError,
  resolveSandboxPolicy,
} from "./policy.js";
import { sandboxArguments } from "./seatbelt.js";

const directories: string[] = [];

afterEach(() => {
  while (directories.length) {
    rmSync(directories.pop()!, { force: true, recursive: true });
  }
});

function directory(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `pipkin-sandbox-${name}-`));
  directories.push(root);
  return root;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

describe("Sandbox policy", () => {
  it("uses a non-Git cwd as the workspace and retains absent reviewed cache roots", async () => {
    const root = directory("plain");
    const home = join(root, "home");
    mkdirSync(home);
    const policy = await resolveSandboxPolicy({
      sessionCwd: root,
      homeDir: home,
      temporaryDir: root,
      standardTemporaryRoots: [],
      env: {
        npm_config_cache: join(home, "missing-npm"),
        XDG_CACHE_HOME: join(home, "missing-xdg"),
      },
    });
    expect(policy.workspaceRoot).toBe(realpathSync(root));
    expect(policy.git).toBeUndefined();
    expect(policy.runtimeRoots).toEqual([
      join(realpathSync(home), "missing-npm"),
      join(realpathSync(home), "Library", "pnpm", "store"),
      join(realpathSync(home), "missing-xdg", "pnpm"),
      join(realpathSync(home), ".local", "state", "pnpm"),
      join(realpathSync(home), "missing-xdg", "gh"),
      join(realpathSync(home), ".local", "state", "gh"),
      join(realpathSync(home), "missing-xdg", "nix"),
      join(realpathSync(home), "Library", "Caches", "mise"),
    ]);
  });

  it("records exact missing ancestors needed to create reviewed cache roots", async () => {
    const root = directory("missing-cache-ancestors");
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    const temporary = join(root, "temporary");
    mkdirSync(workspace);
    mkdirSync(home);
    mkdirSync(temporary);
    const canonicalHome = realpathSync(home);
    const npmParent = join(canonicalHome, "cache-parent");
    const npm = join(npmParent, "npm");

    expect(canonicalRoot(join(home, "cache-parent", "npm"))).toEqual({
      path: npm,
      creationRoots: [npmParent, npm],
    });
    expect(canonicalRoot(`${home}/missing/../normalized-cache`)).toEqual({
      path: join(canonicalHome, "normalized-cache"),
      creationRoots: [join(canonicalHome, "normalized-cache")],
    });

    const policy = await resolveSandboxPolicy({
      sessionCwd: workspace,
      homeDir: home,
      temporaryDir: temporary,
      standardTemporaryRoots: [],
      env: { npm_config_cache: join(home, "cache-parent", "npm") },
    });
    expect(policy.writableRoots).toContain(npm);
    expect(policy.creationRoots).toEqual([
      npmParent,
      join(canonicalHome, "Library"),
      join(canonicalHome, "Library", "pnpm"),
      join(canonicalHome, "Library", "Caches"),
      join(canonicalHome, ".local"),
      join(canonicalHome, ".local", "state"),
      join(canonicalHome, ".cache"),
    ]);
  });

  it("resolves a repository subdirectory and its Git administration", async () => {
    const root = directory("repository");
    git(root, ["init"]);
    const child = join(root, "child");
    mkdirSync(child);
    const policy = await resolveSandboxPolicy({
      sessionCwd: child,
      temporaryDir: root,
      standardTemporaryRoots: [],
      env: {},
    });
    expect(policy.workspaceRoot).toBe(realpathSync(root));
    expect(policy.git).toEqual({
      worktreeRoot: realpathSync(root),
      worktreeGitDir: realpathSync(join(root, ".git")),
      commonGitDir: realpathSync(join(root, ".git")),
    });
  });

  it("resolves linked worktree administration without granting the primary checkout", async () => {
    const root = directory("worktree");
    const linked = join(dirname(root), `${basename(root)}-linked`);
    directories.push(linked);
    const temporary = directory("linked-temporary");
    const home = directory("linked-home");
    git(root, ["init"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "Test"]);
    execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], {
      cwd: root,
      stdio: "pipe",
    });
    git(root, ["worktree", "add", "-b", "linked", linked]);
    const policy = await resolveSandboxPolicy({
      sessionCwd: linked,
      homeDir: home,
      temporaryDir: temporary,
      standardTemporaryRoots: [],
      env: {},
    });
    expect(policy.workspaceRoot).toBe(realpathSync(linked));
    expect(policy.git?.worktreeGitDir).not.toBe(policy.git?.commonGitDir);
    expect(policy.git?.commonGitDir).toBe(realpathSync(join(root, ".git")));
    expect(policy.writableRoots).toEqual(
      expect.arrayContaining([
        realpathSync(linked),
        policy.git!.commonGitDir,
        realpathSync(temporary),
      ]),
    );
    expect(policy.writableRoots).not.toContain(policy.git!.worktreeGitDir);
    expect(policy.writableRoots).not.toContain(realpathSync(root));
  });

  it("grants dependency runtime state from the active and containing package workspaces", async () => {
    const root = directory("nested-worktree");
    const linked = join(root, ".pi", "worktrees", "linked");
    const temporary = directory("nested-temporary");
    const home = directory("nested-home");
    const rootModules = join(root, "node_modules");
    const linkedModules = join(linked, "node_modules");
    const packageRoot = join(root, "packages", "feature");
    const packageModules = join(packageRoot, "node_modules");
    const escapedPackageRoot = join(root, "packages", "escaped");
    const escapedModules = join(escapedPackageRoot, "node_modules");
    const escapedTarget = directory("escaped-modules");
    git(root, ["init"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "Test"]);
    writeFileSync(join(root, "package.json"), '{"private":true}\n');
    writeFileSync(join(root, ".gitignore"), ".pi/\nnode_modules/\n");
    mkdirSync(rootModules);
    mkdirSync(packageModules, { recursive: true });
    mkdirSync(escapedPackageRoot, { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), '{"private":true}\n');
    writeFileSync(
      join(escapedPackageRoot, "package.json"),
      '{"private":true}\n',
    );
    symlinkSync(escapedTarget, escapedModules);
    git(root, ["add", "package.json", ".gitignore", "packages"]);
    git(root, ["commit", "-m", "initial"]);
    git(root, ["worktree", "add", "-b", "linked", linked]);
    mkdirSync(linkedModules);

    const policy = await resolveSandboxPolicy({
      sessionCwd: linked,
      homeDir: home,
      temporaryDir: temporary,
      standardTemporaryRoots: [],
      env: {},
    });

    expect(policy.workspaceRoot).toBe(realpathSync(linked));
    const expectedRoots = [rootModules, linkedModules, packageModules].map(
      (path) => realpathSync(path),
    );
    expect(policy.writableRoots).toEqual(
      expect.arrayContaining([
        realpathSync(rootModules),
        realpathSync(packageModules),
      ]),
    );
    expect(policy.dependencyRoots).toEqual(
      expect.arrayContaining(expectedRoots),
    );
    expect(policy.writableRoots).not.toContain(realpathSync(root));
    expect(policy.writableRoots).not.toContain(realpathSync(escapedTarget));
    const readOnlyArguments = sandboxArguments({
      policy,
      shell: { shell: "/bin/bash", args: ["-s"] },
      writeMode: "repository-read-only",
    });
    const readOnlyRoots = readOnlyArguments.filter((value) =>
      /^root\d+=/.test(value),
    );
    expect(readOnlyRoots).toEqual(
      expect.arrayContaining(
        expectedRoots.map((root) => expect.stringContaining(root)),
      ),
    );
  });

  it("rejects dependency roots containing tracked source", async () => {
    const root = directory("tracked-dependencies");
    const nested = join(root, "packages", "nested");
    const rootModules = join(root, "node_modules");
    const nestedModules = join(nested, "node_modules");
    git(root, ["init"]);
    mkdirSync(rootModules);
    mkdirSync(nestedModules, { recursive: true });
    writeFileSync(join(root, "package.json"), '{"private":true}\n');
    writeFileSync(join(nested, "package.json"), '{"private":true}\n');
    writeFileSync(join(rootModules, "tracked.js"), "root\n");
    writeFileSync(join(nestedModules, "tracked.js"), "nested\n");
    git(root, ["add", "-f", "."]);

    const policy = await resolveSandboxPolicy({
      sessionCwd: root,
      temporaryDir: root,
      standardTemporaryRoots: [],
      env: {},
    });

    expect(policy.dependencyRoots).toEqual([]);
  });

  it("rejects dependency roots that relabel source or external directories through symlinks", async () => {
    for (const target of ["source", "external"] as const) {
      const root = directory(`dependency-link-${target}`);
      const source = join(root, "source");
      const external = directory(`dependency-link-${target}-external`);
      mkdirSync(source);
      git(root, ["init"]);
      writeFileSync(join(root, "package.json"), '{"private":true}\n');
      git(root, ["add", "package.json"]);
      symlinkSync(
        target === "source" ? source : external,
        join(root, "node_modules"),
      );

      const policy = await resolveSandboxPolicy({
        sessionCwd: root,
        temporaryDir: root,
        standardTemporaryRoots: [],
        env: {},
      });

      expect(policy.dependencyRoots).toEqual([]);
    }
  });

  it("normalizes the configured and standard temporary roots", async () => {
    const workspace = directory("temporary-workspace");
    const temporary = directory("temporary-root");
    const standardTemporary = directory("standard-temporary-root");
    const alias = join(dirname(temporary), `${basename(temporary)}-alias`);
    directories.push(alias);
    symlinkSync(temporary, alias);
    const policy = await resolveSandboxPolicy({
      sessionCwd: workspace,
      homeDir: directory("temporary-home"),
      temporaryDir: alias,
      standardTemporaryRoots: [standardTemporary],
      env: { TMPDIR: alias },
    });
    const canonicalTemporary = realpathSync(temporary);
    expect(policy.temporaryRoots).toEqual([
      canonicalTemporary,
      realpathSync(standardTemporary),
    ]);
    expect(
      policy.temporaryRoots.filter((root) => root === canonicalTemporary),
    ).toHaveLength(1);
  });

  it("grants only reviewed tool cache and state purposes and their final effective roots", async () => {
    const root = directory("reviewed-caches");
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    const temporary = join(root, "temporary");
    const npm = join(root, "npm");
    const xdgCache = join(root, "xdg-cache");
    const ghCache = join(xdgCache, "gh");
    const nixCache = join(root, "nix-cache");
    const miseCache = join(root, "mise-cache");
    const xdgState = join(root, "xdg-state");
    const ghState = join(xdgState, "gh");
    const pnpmStore = join(home, "Library", "pnpm", "store");
    const pnpmCache = join(home, "Library", "Caches", "pnpm");
    for (const path of [
      workspace,
      home,
      temporary,
      npm,
      ghCache,
      nixCache,
      miseCache,
      ghState,
      pnpmStore,
      pnpmCache,
    ]) {
      mkdirSync(path, { recursive: true });
    }
    const policy = await resolveSandboxPolicy({
      sessionCwd: workspace,
      homeDir: home,
      temporaryDir: temporary,
      standardTemporaryRoots: [],
      env: {
        npm_config_cache: npm,
        XDG_CACHE_HOME: xdgCache,
        XDG_STATE_HOME: xdgState,
        NIX_CACHE_HOME: nixCache,
        MISE_CACHE_DIR: miseCache,
        PNPM_HOME: join(home, "pnpm-bin"),
      },
    });
    const canonicalRootPath = realpathSync(root);
    const canonicalRoots = [
      realpathSync(npm),
      join(canonicalRootPath, "home", "pnpm-bin", "store"),
      join(canonicalRootPath, "xdg-cache", "pnpm"),
      join(canonicalRootPath, "xdg-state", "pnpm"),
      realpathSync(ghCache),
      realpathSync(ghState),
      realpathSync(nixCache),
      realpathSync(miseCache),
    ];
    expect(policy.runtimeRoots).toEqual(canonicalRoots);
    expect(policy.writableRoots).toEqual(
      expect.arrayContaining([
        realpathSync(workspace),
        realpathSync(temporary),
        ...canonicalRoots,
      ]),
    );
    expect(policy.writableRoots).not.toContain(realpathSync(home));
    expect(policy.writableRoots).not.toContain(realpathSync(xdgCache));
    expect(policy.writableRoots).not.toContain(
      realpathSync(join(home, "Library", "pnpm")),
    );
    expect(policy.writableRoots).not.toContain(
      realpathSync(join(home, "Library", "Caches")),
    );
    expect(policy.writableRoots).not.toContain(
      join(realpathSync(home), ".cargo"),
    );
    expect(policy.writableRoots).not.toContain(
      join(realpathSync(home), "pnpm-bin"),
    );
    expect(policy.writableRoots).not.toContain(
      join(realpathSync(home), ".config", "gh"),
    );
    expect(policy.writableRoots).not.toContain(
      join(realpathSync(home), ".local", "share", "gh"),
    );
  });

  it("honors effective npm, pnpm, and Nix runtime overrides", async () => {
    const root = directory("runtime-overrides");
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    const temporary = join(root, "temporary");
    mkdirSync(workspace);
    mkdirSync(home);
    mkdirSync(temporary);
    const policy = await resolveSandboxPolicy({
      sessionCwd: workspace,
      homeDir: home,
      temporaryDir: temporary,
      standardTemporaryRoots: [],
      env: {
        npm_config_cache: "ignored-npm-cache",
        NPM_CONFIG_CACHE: "npm-cache",
        PNPM_HOME: "~/pnpm-home",
        npm_config_cache_dir: "pnpm-cache",
        npm_config_state_dir: "pnpm-state",
        NIX_CACHE_HOME: "nix-cache",
        MISE_CACHE_DIR: "~/mise-cache",
      },
    });
    const canonicalWorkspace = realpathSync(workspace);

    expect(policy.runtimeRoots).toEqual(
      expect.arrayContaining([
        join(canonicalWorkspace, "npm-cache"),
        join(realpathSync(home), "pnpm-home", "store"),
        join(canonicalWorkspace, "pnpm-cache"),
        join(canonicalWorkspace, "pnpm-state"),
        join(canonicalWorkspace, "nix-cache"),
        join(realpathSync(home), "mise-cache"),
      ]),
    );
    expect(policy.runtimeRoots).not.toContain(
      join(canonicalWorkspace, "ignored-npm-cache"),
    );
    expect(policy.runtimeRoots).not.toContain(join(realpathSync(home), ".npm"));
  });

  it("treats bare tilde as a relative npm path", async () => {
    const root = directory("bare-tilde");
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    mkdirSync(workspace);
    mkdirSync(home);

    const policy = await resolveSandboxPolicy({
      sessionCwd: workspace,
      homeDir: home,
      temporaryDir: workspace,
      standardTemporaryRoots: [],
      env: { npm_config_cache: "~" },
    });

    expect(policy.runtimeRoots).toContain(join(realpathSync(workspace), "~"));
    expect(policy.runtimeRoots).not.toContain(realpathSync(home));
  });

  it("grants gh and Nix default runtime roots without durable config, data, or state", async () => {
    const root = directory("gh-roots");
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    const temporary = join(root, "temporary");
    mkdirSync(workspace);
    mkdirSync(home);
    mkdirSync(temporary);
    const canonicalHome = realpathSync(home);
    const ghCache = join(canonicalHome, ".cache", "gh");
    const nixCache = join(canonicalHome, ".cache", "nix");
    const ghState = join(canonicalHome, ".local", "state", "gh");

    const policy = await resolveSandboxPolicy({
      sessionCwd: workspace,
      homeDir: home,
      temporaryDir: temporary,
      standardTemporaryRoots: [],
      env: {},
    });

    expect(policy.runtimeRoots).toEqual(
      expect.arrayContaining([ghCache, nixCache]),
    );
    expect(policy.writableRoots).toEqual(
      expect.arrayContaining([ghCache, nixCache, ghState]),
    );
    expect(policy.writableRoots).not.toContain(
      join(canonicalHome, ".config", "gh"),
    );
    expect(policy.writableRoots).not.toContain(
      join(canonicalHome, ".local", "share", "gh"),
    );
    expect(policy.writableRoots).not.toContain(
      join(canonicalHome, ".config", "nix"),
    );
    expect(policy.writableRoots).not.toContain(
      join(canonicalHome, ".local", "state", "nix"),
    );
  });

  it("rejects runtime overrides that overlap system or tool installations", async () => {
    const root = directory("protected-runtime-overrides");
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    const tools = join(root, "tools");
    mkdirSync(workspace);
    mkdirSync(home);
    mkdirSync(join(tools, "installs"), { recursive: true });
    mkdirSync(join(tools, "plugins"), { recursive: true });

    const policy = await resolveSandboxPolicy({
      sessionCwd: workspace,
      homeDir: home,
      temporaryDir: workspace,
      standardTemporaryRoots: [],
      env: {
        npm_config_cache: "/opt/homebrew",
        NIX_CACHE_HOME: "/nix",
        MISE_CACHE_DIR: tools,
        MISE_INSTALLS_DIR: join(tools, "installs"),
        MISE_PLUGINS_DIR: join(tools, "plugins"),
      },
    });

    expect(policy.runtimeRoots).not.toContain("/opt/homebrew");
    expect(policy.runtimeRoots).not.toContain("/nix");
    expect(policy.runtimeRoots).not.toContain(realpathSync(tools));
  });

  it("does not replace a defined-empty Nix cache with the default root", async () => {
    const root = directory("empty-nix-cache");
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    mkdirSync(workspace);
    mkdirSync(home);

    const policy = await resolveSandboxPolicy({
      sessionCwd: workspace,
      homeDir: home,
      temporaryDir: workspace,
      standardTemporaryRoots: [],
      env: { NIX_CACHE_HOME: "" },
    });

    expect(policy.runtimeRoots).not.toContain(
      join(realpathSync(home), ".cache", "nix"),
    );
  });

  it("omits tool runtime roots that overlap protected config, data, or state", async () => {
    const root = directory("gh-overlap");
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    const config = join(home, ".config", "gh");
    const data = join(home, ".local", "share", "gh");
    const cacheAlias = join(root, "cache-alias");
    mkdirSync(workspace);
    mkdirSync(config, { recursive: true });
    mkdirSync(data, { recursive: true });
    symlinkSync(dirname(config), cacheAlias);

    const policy = await resolveSandboxPolicy({
      sessionCwd: workspace,
      homeDir: home,
      temporaryDir: workspace,
      standardTemporaryRoots: [],
      env: {
        GH_CONFIG_DIR: "",
        XDG_CACHE_HOME: cacheAlias,
        XDG_STATE_HOME: join(home, ".local", "share"),
      },
    });

    expect(policy.writableRoots).not.toContain(realpathSync(config));
    expect(policy.writableRoots).not.toContain(realpathSync(data));
    expect(policy.writableRoots).not.toContain(
      join(realpathSync(cacheAlias), "nix"),
    );
  });

  it("canonicalizes aliases and collapses covered roots", async () => {
    const root = directory("aliases");
    const alias = join(dirname(root), `${basename(root)}-alias`);
    symlinkSync(root, alias);
    const policy = await resolveSandboxPolicy({
      sessionCwd: alias,
      temporaryDir: root,
      standardTemporaryRoots: [],
      env: { npm_config_cache: join(root, "cache") },
    });
    expect(policy.sessionCwd).toBe(realpathSync(root));
    expect(policy.writableRoots).toContain(realpathSync(root));
    expect(policy.writableRoots).not.toContain(
      join(realpathSync(root), "cache"),
    );
  });

  it("omits dangling and looping cache symlinks without creating absent roots", async () => {
    const root = directory("cache-links");
    const home = join(root, "home");
    const dangling = join(home, "dangling");
    const parent = join(home, "parent");
    const pnpmStore = join(home, "Library", "pnpm", "store");
    const pnpmCache = join(home, "Library", "Caches", "pnpm");
    mkdirSync(home);
    mkdirSync(dirname(pnpmStore), { recursive: true });
    mkdirSync(dirname(pnpmCache), { recursive: true });
    symlinkSync(join(root, "missing"), dangling);
    symlinkSync(join(root, "missing-parent"), parent);
    symlinkSync(join(root, "missing-store"), pnpmStore);
    symlinkSync("pnpm", pnpmCache);
    const policy = await resolveSandboxPolicy({
      sessionCwd: root,
      homeDir: home,
      temporaryDir: root,
      standardTemporaryRoots: [],
      env: {
        npm_config_cache: dangling,
        XDG_CACHE_HOME: join(parent, "cache"),
      },
    });
    expect(policy.runtimeRoots).not.toContain(dangling);
    expect(policy.runtimeRoots).not.toContain(join(parent, "cache"));
    expect(policy.runtimeRoots).not.toContain(pnpmStore);
    expect(policy.runtimeRoots).not.toContain(pnpmCache);
    expect(policy.runtimeRoots).toEqual([
      join(realpathSync(home), ".local", "state", "pnpm"),
      join(realpathSync(home), ".local", "state", "gh"),
      join(realpathSync(home), "Library", "Caches", "mise"),
    ]);
    expect(existsSync(join(home, ".npm"))).toBe(false);
  });

  it("resolves ignored project exact and wildcard roots, including absent leaves", async () => {
    const root = directory("configured-project");
    const apps = join(root, "apps");
    mkdirSync(join(apps, "one"), { recursive: true });
    mkdirSync(join(apps, "two"), { recursive: true });
    mkdirSync(join(root, "cache"));
    git(root, ["init"]);
    writeFileSync(join(root, ".gitignore"), "cache/\napps/*/.svelte-kit\n");
    git(root, ["add", ".gitignore"]);
    const policy = await resolveSandboxPolicy({
      sessionCwd: root,
      homeDir: directory("configured-project-home"),
      temporaryDir: directory("configured-project-tmp"),
      standardTemporaryRoots: [],
      env: {},
      configured: { project: ["cache", "apps/*/.svelte-kit"] },
    });
    expect(policy.configuredWritableRoots).toEqual([
      join(realpathSync(root), "cache"),
      join(realpathSync(join(apps, "one")), ".svelte-kit"),
      join(realpathSync(join(apps, "two")), ".svelte-kit"),
    ]);
  });

  it("resolves literal wildcard suffixes and rejects missing or linked parents", async () => {
    const root = directory("configured-wildcard-suffix");
    const apps = join(root, "apps");
    const linked = join(root, "linked");
    mkdirSync(join(apps, "ready", "build"), { recursive: true });
    mkdirSync(join(apps, "missing"), { recursive: true });
    mkdirSync(linked);
    symlinkSync(linked, join(apps, "linked"));
    git(root, ["init"]);
    writeFileSync(join(root, ".gitignore"), "apps/*/build/dist\n");
    git(root, ["add", ".gitignore"]);

    const policy = await resolveSandboxPolicy({
      sessionCwd: root,
      homeDir: directory("configured-wildcard-suffix-home"),
      temporaryDir: directory("configured-wildcard-suffix-tmp"),
      standardTemporaryRoots: [],
      env: {},
      configured: { project: ["apps/*/build/dist"] },
    });

    expect(policy.configuredWritableRoots).toEqual([
      join(realpathSync(join(apps, "ready", "build")), "dist"),
    ]);
    expect(policy.configuredIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "sandbox.writable.0",
          message: expect.stringContaining("literal parent after *"),
        }),
      ]),
    );
  });

  it("bounds wildcard discovery without silently extending authority", async () => {
    const root = directory("configured-wildcard-limit");
    const apps = join(root, "apps");
    mkdirSync(apps);
    for (let index = 0; index < 257; index += 1) {
      mkdirSync(join(apps, `app-${index}`));
    }
    git(root, ["init"]);
    writeFileSync(join(root, ".gitignore"), "apps/*/.cache\n");
    git(root, ["add", ".gitignore"]);
    const policy = await resolveSandboxPolicy({
      sessionCwd: root,
      homeDir: directory("configured-wildcard-limit-home"),
      temporaryDir: directory("configured-wildcard-limit-tmp"),
      standardTemporaryRoots: [],
      env: {},
      configured: { project: ["apps/*/.cache"] },
    });
    expect(policy.configuredWritableRoots).toHaveLength(256);
    expect(policy.configuredIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("wildcard discovery exceeds"),
        }),
      ]),
    );
  });

  it("rejects home ancestors and absent PATH entries while allowing a narrow child", async () => {
    const root = directory("configured-global-overlap");
    const homeParent = join(root, "homes");
    const home = join(homeParent, "user");
    const workspace = join(root, "workspace");
    const tools = join(root, "tools");
    const store = join(tools, "store");
    mkdirSync(home, { recursive: true });
    mkdirSync(workspace);
    mkdirSync(store, { recursive: true });
    git(workspace, ["init"]);
    const policy = await resolveSandboxPolicy({
      sessionCwd: workspace,
      homeDir: home,
      temporaryDir: directory("configured-global-overlap-tmp"),
      standardTemporaryRoots: [],
      env: { PATH: join(realpathSync(tools), "bin") },
      configured: {
        global: [
          realpathSync(homeParent),
          realpathSync(tools),
          realpathSync(store),
        ],
      },
    });
    expect(policy.configuredIssues).toHaveLength(2);
    expect(policy.configuredWritableRoots).toEqual([realpathSync(store)]);
  });

  it("freezes configured provenance and parser and resolver issues", async () => {
    const root = directory("configured-immutable");
    const generated = join(root, "generated");
    mkdirSync(generated);
    git(root, ["init"]);
    writeFileSync(join(root, ".gitignore"), "generated/\n");
    git(root, ["add", ".gitignore"]);
    const parserIssue = {
      scope: "global" as const,
      path: "sandbox",
      message: "bad",
    };
    const policy = await resolveSandboxPolicy({
      sessionCwd: root,
      homeDir: directory("configured-immutable-home"),
      temporaryDir: directory("configured-immutable-tmp"),
      standardTemporaryRoots: [],
      env: {},
      configured: {
        project: ["generated", "../escape"],
        issues: [parserIssue],
      },
    });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.configuredRootProvenance)).toBe(true);
    expect(Object.isFrozen(policy.configuredRootProvenance?.[0])).toBe(true);
    expect(Object.isFrozen(policy.configuredIssues)).toBe(true);
    expect(Object.isFrozen(policy.configuredIssues?.[0])).toBe(true);
    expect(Object.isFrozen(policy.configuredIssues?.[1])).toBe(true);
  });

  it("rejects unsafe configured candidates while retaining a narrow global child", async () => {
    const root = directory("configured-safety");
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const tools = join(root, "tools");
    const store = join(tools, "store");
    const linked = join(root, "linked");
    mkdirSync(home);
    mkdirSync(workspace);
    mkdirSync(store, { recursive: true });
    mkdirSync(linked);
    symlinkSync(linked, join(home, "link"));
    git(workspace, ["init"]);
    const policy = await resolveSandboxPolicy({
      sessionCwd: workspace,
      homeDir: home,
      temporaryDir: directory("configured-safety-tmp"),
      standardTemporaryRoots: [],
      env: { PATH: tools },
      configured: {
        global: [
          "/",
          "~",
          realpathSync(tools),
          realpathSync(store),
          "~/link/child",
          "relative",
        ],
        project: ["../escape"],
      },
    });
    expect(policy.configuredWritableRoots).toEqual([realpathSync(store)]);
    expect(policy.configuredIssues?.length).toBeGreaterThanOrEqual(5);
  });

  it("does not turn a genuine Git error into a non-Git policy", async () => {
    const root = directory("git-error");
    await expect(
      resolveSandboxPolicy({
        sessionCwd: root,
        standardTemporaryRoots: [],
        gitRunner: async () => ({
          exitCode: 1,
          stdout: "",
          stderr: "broken Git",
        }),
      }),
    ).rejects.toBeInstanceOf(SandboxPolicyError);
  });
});
