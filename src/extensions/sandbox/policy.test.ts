import { execFileSync } from "node:child_process";
import {
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

function runtimeFixture(name: string) {
  const root = directory(name);
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  const temporary = join(root, "temporary");
  mkdirSync(workspace);
  mkdirSync(home);
  mkdirSync(temporary);
  return { root, workspace, home, temporary };
}

describe("Sandbox policy", () => {
  it("grants npm and standardized cache roots, including absent cache parents", async () => {
    const { home, temporary, workspace } = runtimeFixture("standard-caches");
    const npm = join(home, "cache-parent", "npm");
    const policy = await resolveSandboxPolicy({
      sessionCwd: workspace,
      homeDir: home,
      temporaryDir: temporary,
      standardTemporaryRoots: [],
      env: {
        npm_config_cache: join(realpathSync(home), "cache-parent", "npm"),
        XDG_CACHE_HOME: join(realpathSync(home), "cache-parent", "xdg"),
      },
    });
    const canonicalHome = realpathSync(home);
    const expected = [
      join(canonicalHome, "cache-parent", "npm"),
      join(canonicalHome, "cache-parent", "xdg"),
      ...(process.platform === "darwin"
        ? [join(canonicalHome, "Library", "Caches")]
        : []),
    ];

    expect(canonicalRoot(npm)).toEqual({
      path: expected[0],
      creationRoots: [join(canonicalHome, "cache-parent"), expected[0]],
    });
    expect(policy.runtimeRoots).toEqual(expected);
    expect(policy.creationRoots).toEqual([
      join(canonicalHome, "cache-parent"),
      ...(process.platform === "darwin"
        ? [join(canonicalHome, "Library")]
        : []),
    ]);
    expect(
      sandboxArguments({
        policy,
        shell: { shell: "/bin/bash", args: ["-s"] },
        writeMode: "repository-read-only",
      }),
    ).toEqual(
      expect.arrayContaining(
        expected.map((root, index) => `root${index + 1}=${root}`),
      ),
    );
  });

  it("uses default XDG cache and macOS cache roots without granting state", async () => {
    const { home, temporary, workspace } = runtimeFixture("default-caches");
    const policy = await resolveSandboxPolicy({
      sessionCwd: workspace,
      homeDir: home,
      temporaryDir: temporary,
      standardTemporaryRoots: [],
      env: {},
    });
    const canonicalHome = realpathSync(home);
    const expected = [
      join(canonicalHome, ".npm"),
      join(canonicalHome, ".cache"),
      ...(process.platform === "darwin"
        ? [join(canonicalHome, "Library", "Caches")]
        : []),
    ];

    expect(policy.runtimeRoots).toEqual(expected);
    expect(policy.writableRoots).not.toContain(
      join(canonicalHome, ".local", "state"),
    );
    expect(policy.writableRoots).not.toContain(
      join(canonicalHome, "Library", "pnpm", "store"),
    );
  });

  it("falls back to the default cache root for a relative XDG cache value", async () => {
    const { home, temporary, workspace } = runtimeFixture("relative-xdg-cache");
    const policy = await resolveSandboxPolicy({
      sessionCwd: workspace,
      homeDir: home,
      temporaryDir: temporary,
      standardTemporaryRoots: [],
      env: { XDG_CACHE_HOME: "relative-cache" },
    });

    expect(policy.runtimeRoots).toContain(join(realpathSync(home), ".cache"));
    expect(policy.runtimeRoots).not.toContain(
      join(workspace, "relative-cache"),
    );
  });

  it("retains default configuration protection for a relative XDG config value", async () => {
    const { home, temporary, workspace } = runtimeFixture(
      "relative-xdg-config",
    );
    const config = join(home, ".config");
    mkdirSync(config);
    const policy = await resolveSandboxPolicy({
      sessionCwd: workspace,
      homeDir: home,
      temporaryDir: temporary,
      standardTemporaryRoots: [],
      env: {
        XDG_CACHE_HOME: config,
        XDG_CONFIG_HOME: "relative-config",
      },
      configured: { global: [config, home] },
    });

    expect(policy.runtimeRoots).not.toContain(realpathSync(config));
    expect(policy.configuredWritableRoots).toEqual([]);
  });

  it("keeps npm's case-insensitive effective cache precedence", async () => {
    const { home, temporary, workspace } = runtimeFixture("npm-cache");
    const selected = join(realpathSync(home), "selected-npm");
    const policy = await resolveSandboxPolicy({
      sessionCwd: workspace,
      homeDir: home,
      temporaryDir: temporary,
      standardTemporaryRoots: [],
      env: {
        npm_config_cache: join(home, "ignored-npm"),
        NPM_CONFIG_CACHE: selected,
      },
    });

    expect(policy.runtimeRoots).toContain(
      join(realpathSync(home), "selected-npm"),
    );
    expect(policy.runtimeRoots).not.toContain(
      join(realpathSync(home), "ignored-npm"),
    );
  });

  it("fails closed for cache roots overlapping workspace, Git, configuration, home, root, and PATH", async () => {
    const { home, temporary, workspace } = runtimeFixture("unsafe-caches");
    const tools = join(dirname(workspace), "tools");
    const config = join(home, ".config");
    mkdirSync(join(tools, "bin"), { recursive: true });
    mkdirSync(config);
    git(workspace, ["init"]);
    const policy = await resolveSandboxPolicy({
      sessionCwd: workspace,
      homeDir: home,
      temporaryDir: temporary,
      standardTemporaryRoots: [],
      env: {
        npm_config_cache: workspace,
        XDG_CACHE_HOME: join(workspace, ".git"),
        PATH: tools,
        XDG_CONFIG_HOME: config,
      },
      configured: {
        globalConfigPath: join(home, ".pi", "agent", "pipkin", "config.json"),
      },
    });

    expect(policy.runtimeRoots).toEqual(
      process.platform === "darwin"
        ? [join(realpathSync(home), "Library", "Caches")]
        : [],
    );
    for (const root of [
      workspace,
      join(workspace, ".git"),
      tools,
      config,
      home,
      "/",
    ]) {
      expect(policy.writableRoots).not.toContain(root);
    }
  });

  it("allows a selected cache child below PATH while denying the executable authority itself", async () => {
    const { home, temporary, workspace } = runtimeFixture("narrow-cache");
    const tools = join(dirname(workspace), "tools");
    const cache = join(tools, "cache");
    mkdirSync(cache, { recursive: true });
    const policy = await resolveSandboxPolicy({
      sessionCwd: workspace,
      homeDir: home,
      temporaryDir: temporary,
      standardTemporaryRoots: [],
      env: {
        PATH: realpathSync(tools),
        XDG_CACHE_HOME: realpathSync(cache),
        npm_config_cache: realpathSync(tools),
      },
    });

    expect(policy.runtimeRoots).toContain(realpathSync(cache));
    expect(policy.runtimeRoots).not.toContain(realpathSync(tools));
  });

  it("rejects cache paths with a symlinked existing component", async () => {
    const { home, root, temporary, workspace } = runtimeFixture("cache-links");
    const target = directory("cache-link-target");
    const linked = join(root, "linked-cache");
    symlinkSync(target, linked);
    const policy = await resolveSandboxPolicy({
      sessionCwd: workspace,
      homeDir: home,
      temporaryDir: temporary,
      standardTemporaryRoots: [],
      env: { npm_config_cache: linked, XDG_CACHE_HOME: linked },
    });

    expect(policy.runtimeRoots).not.toContain(realpathSync(target));
  });

  it("does not discover pnpm, gh, Nix, or mise state and stores", async () => {
    const { home, root, temporary, workspace } =
      runtimeFixture("no-vendor-state");
    const xdgCache = join(root, "cache");
    const xdgState = join(root, "state");
    const pnpmStore = join(home, "Library", "pnpm", "store");
    const ghState = join(xdgState, "gh");
    const pnpmState = join(xdgState, "pnpm");
    mkdirSync(xdgCache);
    mkdirSync(pnpmStore, { recursive: true });
    mkdirSync(pnpmState, { recursive: true });
    const policy = await resolveSandboxPolicy({
      sessionCwd: workspace,
      homeDir: home,
      temporaryDir: temporary,
      standardTemporaryRoots: [],
      env: {
        XDG_CACHE_HOME: realpathSync(xdgCache),
        XDG_STATE_HOME: xdgState,
        PNPM_HOME: join(home, "pnpm-bin"),
        NIX_CACHE_HOME: join(root, "nix-cache"),
        MISE_CACHE_DIR: join(root, "mise-cache"),
      },
    });

    expect(policy.runtimeRoots).toContain(join(realpathSync(root), "cache"));
    expect(policy.writableRoots).not.toEqual(
      expect.arrayContaining([pnpmStore, ghState, pnpmState]),
    );
    expect(policy.runtimeRoots).not.toEqual(
      expect.arrayContaining([
        join(realpathSync(root), "nix-cache"),
        join(realpathSync(root), "mise-cache"),
      ]),
    );
  });

  it("admits an explicit persistent global child without granting state siblings", async () => {
    const { home, temporary, workspace } = runtimeFixture("configured-state");
    const state = join(home, ".local", "state");
    const gh = join(state, "gh");
    const pnpm = join(state, "pnpm");
    mkdirSync(gh, { recursive: true });
    mkdirSync(pnpm, { recursive: true });
    const policy = await resolveSandboxPolicy({
      sessionCwd: workspace,
      homeDir: home,
      temporaryDir: temporary,
      standardTemporaryRoots: [],
      env: {},
      configured: { global: ["~/.local/state/gh"] },
    });

    expect(policy.configuredWritableRoots).toEqual([realpathSync(gh)]);
    expect(policy.writableRoots).not.toContain(realpathSync(state));
    expect(policy.writableRoots).not.toContain(realpathSync(pnpm));
  });

  it("resolves a repository subdirectory and its Git administration", async () => {
    const root = directory("repository");
    git(root, ["init"]);
    const child = join(root, "child");
    mkdirSync(child);
    const policy = await resolveSandboxPolicy({
      sessionCwd: child,
      homeDir: directory("repository-home"),
      temporaryDir: directory("repository-temporary"),
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
    git(root, ["commit", "--allow-empty", "-m", "initial"]);
    git(root, ["worktree", "add", "-b", "linked", linked]);
    const policy = await resolveSandboxPolicy({
      sessionCwd: linked,
      homeDir: home,
      temporaryDir: temporary,
      standardTemporaryRoots: [],
      env: {},
    });
    expect(policy.git?.worktreeGitDir).not.toBe(policy.git?.commonGitDir);
    expect(policy.git?.commonGitDir).toBe(realpathSync(join(root, ".git")));
    expect(policy.writableRoots).toEqual(
      expect.arrayContaining([realpathSync(linked), realpathSync(temporary)]),
    );
    expect(policy.writableRoots).not.toContain(realpathSync(root));
  });

  it("grants only valid untracked dependency trees to repository-read-only Bash", async () => {
    const root = directory("dependencies");
    const modules = join(root, "node_modules");
    const temporary = directory("dependencies-temporary");
    const home = directory("dependencies-home");
    git(root, ["init"]);
    mkdirSync(modules);
    writeFileSync(join(root, "package.json"), '{"private":true}\n');
    writeFileSync(join(root, ".gitignore"), "node_modules/\n");
    git(root, ["add", "package.json", ".gitignore"]);
    const policy = await resolveSandboxPolicy({
      sessionCwd: root,
      homeDir: home,
      temporaryDir: temporary,
      standardTemporaryRoots: [],
      env: {},
    });

    expect(policy.dependencyRoots).toEqual([realpathSync(modules)]);
    expect(
      sandboxArguments({
        policy,
        shell: { shell: "/bin/bash", args: ["-s"] },
        writeMode: "repository-read-only",
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`=${realpathSync(modules)}`),
      ]),
    );
  });

  it("rejects dependency roots containing tracked source or symlink targets", async () => {
    const root = directory("tracked-dependencies");
    const external = directory("dependency-external");
    git(root, ["init"]);
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "package.json"), '{"private":true}\n');
    writeFileSync(join(root, "node_modules", "tracked.js"), "source\n");
    git(root, ["add", "-f", "."]);
    const tracked = await resolveSandboxPolicy({
      sessionCwd: root,
      homeDir: directory("tracked-home"),
      temporaryDir: directory("tracked-temporary"),
      standardTemporaryRoots: [],
      env: {},
    });
    expect(tracked.dependencyRoots).toEqual([]);

    const linkedRoot = directory("linked-dependencies");
    git(linkedRoot, ["init"]);
    writeFileSync(join(linkedRoot, "package.json"), '{"private":true}\n');
    git(linkedRoot, ["add", "package.json"]);
    symlinkSync(external, join(linkedRoot, "node_modules"));
    const linked = await resolveSandboxPolicy({
      sessionCwd: linkedRoot,
      homeDir: directory("linked-home"),
      temporaryDir: directory("linked-temporary"),
      standardTemporaryRoots: [],
      env: {},
    });
    expect(linked.dependencyRoots).toEqual([]);
  });

  it("normalizes aliases among temporary roots", async () => {
    const { home, temporary, workspace } = runtimeFixture("temporary-roots");
    const alias = join(dirname(temporary), `${basename(temporary)}-alias`);
    directories.push(alias);
    symlinkSync(temporary, alias);
    const policy = await resolveSandboxPolicy({
      sessionCwd: workspace,
      homeDir: home,
      temporaryDir: alias,
      standardTemporaryRoots: [temporary],
      env: { TMPDIR: alias },
    });
    expect(policy.temporaryRoots).toEqual([realpathSync(temporary)]);
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

  it("rejects unsafe configured candidates while retaining a narrow global child", async () => {
    const { home, root, temporary, workspace } =
      runtimeFixture("configured-safety");
    const tools = join(root, "tools");
    const store = join(tools, "store");
    mkdirSync(store, { recursive: true });
    git(workspace, ["init"]);
    const policy = await resolveSandboxPolicy({
      sessionCwd: workspace,
      homeDir: home,
      temporaryDir: temporary,
      standardTemporaryRoots: [],
      env: { PATH: tools },
      configured: {
        global: [
          "/",
          "~",
          realpathSync(tools),
          realpathSync(store),
          "relative",
        ],
        project: ["../escape"],
      },
    });
    expect(policy.configuredWritableRoots).toEqual([realpathSync(store)]);
    expect(policy.configuredIssues?.length).toBeGreaterThanOrEqual(4);
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
