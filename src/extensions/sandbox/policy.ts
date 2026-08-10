import { spawn } from "node:child_process";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export type SandboxGit = Readonly<{
  worktreeRoot: string;
  worktreeGitDir: string;
  commonGitDir: string;
}>;

export type SandboxPolicy = Readonly<{
  sessionCwd: string;
  workspaceRoot: string;
  git?: SandboxGit;
  temporaryRoots: readonly string[];
  /** Reviewed tool cache, state, and store paths treated as disposable runtime state. */
  runtimeRoots: readonly string[];
  /** Package dependency trees treated as disposable Bash runtime state. */
  dependencyRoots: readonly string[];
  writableRoots: readonly string[];
  creationRoots: readonly string[];
}>;

export type GitRunResult = Readonly<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}>;

export type GitRunner = (
  cwd: string,
  args: readonly string[],
) => Promise<GitRunResult>;

export class SandboxPolicyError extends Error {
  constructor(message: string) {
    super(`Sandbox: ${message}`);
  }
}

function isUnder(path: string, root: string): boolean {
  const value = relative(root, path);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`));
}

function canonicalExisting(path: string): string {
  const canonical = realpathSync(path);
  if (!lstatSync(canonical).isDirectory()) {
    throw new SandboxPolicyError(`root is not a directory: ${path}`);
  }
  return canonical;
}

export function canonicalRoot(path: string): Readonly<{
  path: string;
  creationRoots: readonly string[];
}> {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new SandboxPolicyError("root must be an absolute path");
  }
  const missing: string[] = [];
  let cursor = path;
  while (true) {
    try {
      let canonical = realpathSync(cursor);
      const missingComponents = missing.reverse();
      if (missingComponents.includes("..")) {
        return canonicalRoot(resolve(canonical, ...missingComponents));
      }
      const creationRoots = missingComponents.map((component) => {
        canonical = resolve(canonical, component);
        return canonical;
      });
      return Object.freeze({
        path: canonical,
        creationRoots: Object.freeze(creationRoots),
      });
    } catch {
      try {
        lstatSync(cursor);
        throw new SandboxPolicyError(`unable to canonicalize root: ${path}`);
      } catch (lstatError) {
        if (lstatError instanceof SandboxPolicyError) {
          throw lstatError;
        }
        if ((lstatError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new SandboxPolicyError(`unable to canonicalize root: ${path}`);
        }
      }
      const parent = dirname(cursor);
      if (parent === cursor) {
        throw new SandboxPolicyError(`unable to canonicalize root: ${path}`);
      }
      missing.push(basename(cursor));
      cursor = parent;
    }
  }
}

export function canonicalPath(path: string): string {
  return canonicalRoot(path).path;
}

export function normalizeRoots(roots: readonly string[]): readonly string[] {
  const normalized: string[] = [];
  for (const root of roots) {
    const canonical = canonicalPath(root);
    if (!normalized.some((current) => current === canonical)) {
      normalized.push(canonical);
    }
  }
  return Object.freeze(
    normalized.filter(
      (root, index, all) =>
        !all.some(
          (parent, parentIndex) =>
            parentIndex !== index && isUnder(root, parent),
        ),
    ),
  );
}

export const runGit: GitRunner = (cwd, args) =>
  new Promise((resolveResult, reject) => {
    let child;
    try {
      child = spawn("git", [...args], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data: Buffer) => (stdout += data));
    child.stderr.on("data", (data: Buffer) => (stderr += data));
    child.once("error", reject);
    child.once("close", (exitCode) =>
      resolveResult({ exitCode, stdout, stderr }),
    );
  });

function isNotWorktree(result: GitRunResult): boolean {
  return (
    result.exitCode === 128 &&
    /not a git repository|must be run in a work tree/i.test(result.stderr)
  );
}

async function resolveGit(
  cwd: string,
  gitRunner: GitRunner,
): Promise<SandboxGit | undefined> {
  let result: GitRunResult;
  try {
    result = await gitRunner(cwd, [
      "rev-parse",
      "--is-inside-work-tree",
      "--show-toplevel",
      "--git-dir",
      "--git-common-dir",
    ]);
  } catch (error) {
    throw new SandboxPolicyError(
      `Git resolution failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (isNotWorktree(result)) {
    return undefined;
  }
  const lines = result.stdout.trim().split(/\r?\n/);
  if (result.exitCode !== 0 || lines.length !== 4 || lines[0] !== "true") {
    throw new SandboxPolicyError(
      `Git resolution failed: ${result.stderr.trim() || "unexpected Git response"}`,
    );
  }
  return Object.freeze({
    worktreeRoot: canonicalExisting(resolve(cwd, lines[1])),
    worktreeGitDir: canonicalExisting(resolve(cwd, lines[2])),
    commonGitDir: canonicalExisting(resolve(cwd, lines[3])),
  });
}

function absoluteDirectory(value: string | undefined): string | undefined {
  if (!value || !isAbsolute(value)) {
    return undefined;
  }
  try {
    return canonicalExisting(value);
  } catch {
    return undefined;
  }
}

type RootCandidate = Readonly<{
  path: string;
  creationRoots: readonly string[];
}>;

type ReviewedRoot = Readonly<{
  value: string;
  expandsTilde?: boolean;
  allowedProtectedRoot?: string;
}>;

function firstNonEmpty(
  ...values: readonly (string | undefined)[]
): string | undefined {
  return values.find((value) => value !== undefined && value !== "");
}

function npmEnvironmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  let result: string | undefined;
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === `npm_config_${name}` && value !== "") {
      result = value;
    }
  }
  return result;
}

function effectivePath(value: string, cwd: string, home?: string): string {
  return home && value.startsWith(`~${sep}`)
    ? resolve(home, value.slice(2))
    : isAbsolute(value)
      ? value
      : resolve(cwd, value);
}

function rootCandidate(value: string): RootCandidate | undefined {
  if (!isAbsolute(value)) {
    return undefined;
  }
  try {
    try {
      if (!statSync(value).isDirectory()) {
        return undefined;
      }
    } catch {}
    return canonicalRoot(value);
  } catch {
    return undefined;
  }
}

function toolRuntimeRootCandidates(
  options: Readonly<{
    env: NodeJS.ProcessEnv;
    home: string;
    sessionCwd: string;
  }>,
): readonly RootCandidate[] {
  const { env, home, sessionCwd } = options;
  const xdgCache = firstNonEmpty(env.XDG_CACHE_HOME);
  const xdgConfig = firstNonEmpty(env.XDG_CONFIG_HOME);
  const xdgData = firstNonEmpty(env.XDG_DATA_HOME);
  const xdgState = firstNonEmpty(env.XDG_STATE_HOME);
  const pnpmHome =
    firstNonEmpty(env.PNPM_HOME) ??
    (xdgData ? join(xdgData, "pnpm") : join(home, "Library", "pnpm"));
  const protectedToolRoots = [
    "/nix",
    "/opt/homebrew",
    "/usr/local/Homebrew",
    firstNonEmpty(env.GH_CONFIG_DIR) ??
      (xdgConfig ? join(xdgConfig, "gh") : join(home, ".config", "gh")),
    xdgData ? join(xdgData, "gh") : join(home, ".local", "share", "gh"),
    env.NIX_CONFIG_HOME !== undefined
      ? env.NIX_CONFIG_HOME
      : xdgConfig
        ? join(xdgConfig, "nix")
        : join(home, ".config", "nix"),
    env.NIX_STATE_HOME !== undefined
      ? env.NIX_STATE_HOME
      : xdgState
        ? join(xdgState, "nix")
        : join(home, ".local", "state", "nix"),
    xdgConfig
      ? join(xdgConfig, "pnpm")
      : join(home, "Library", "Preferences", "pnpm"),
  ]
    .filter((value) => value !== "")
    .map((value) => rootCandidate(effectivePath(value, sessionCwd)))
    .filter((root): root is RootCandidate => root !== undefined);
  const miseData =
    firstNonEmpty(env.MISE_DATA_DIR) ??
    (xdgData ? join(xdgData, "mise") : join(home, ".local", "share", "mise"));
  const expandedProtectedToolRoots = [
    pnpmHome,
    miseData,
    firstNonEmpty(env.MISE_INSTALLS_DIR) ?? join(miseData, "installs"),
    firstNonEmpty(env.MISE_PLUGINS_DIR) ?? join(miseData, "plugins"),
    firstNonEmpty(env.MISE_CONFIG_DIR) ??
      (xdgConfig ? join(xdgConfig, "mise") : join(home, ".config", "mise")),
  ]
    .map((value) => rootCandidate(effectivePath(value, sessionCwd, home)))
    .filter((root): root is RootCandidate => root !== undefined);
  protectedToolRoots.push(...expandedProtectedToolRoots);
  const doesNotOverlapProtectedToolRoot = (
    candidate: RootCandidate,
    allowedProtectedRoot: string | undefined,
  ): boolean => {
    const allowed = allowedProtectedRoot
      ? rootCandidate(effectivePath(allowedProtectedRoot, sessionCwd, home))
          ?.path
      : undefined;
    return !protectedToolRoots.some((protectedRoot) => {
      const reviewedChild =
        protectedRoot.path === allowed &&
        candidate.path !== protectedRoot.path &&
        isUnder(candidate.path, protectedRoot.path);
      return (
        !reviewedChild &&
        (isUnder(candidate.path, protectedRoot.path) ||
          isUnder(protectedRoot.path, candidate.path))
      );
    });
  };
  const nixCache =
    env.NIX_CACHE_HOME !== undefined
      ? env.NIX_CACHE_HOME
      : xdgCache
        ? join(xdgCache, "nix")
        : join(home, ".cache", "nix");
  const pnpmStore =
    npmEnvironmentValue(env, "store_dir") ?? join(pnpmHome, "store");
  const reviewedRoots: readonly ReviewedRoot[] = [
    {
      value: npmEnvironmentValue(env, "cache") ?? join(home, ".npm"),
      expandsTilde: true,
    },
    {
      value: pnpmStore,
      expandsTilde: true,
      allowedProtectedRoot: pnpmHome,
    },
    {
      value:
        npmEnvironmentValue(env, "cache_dir") ??
        (xdgCache
          ? join(xdgCache, "pnpm")
          : join(home, "Library", "Caches", "pnpm")),
      expandsTilde: true,
    },
    {
      value:
        npmEnvironmentValue(env, "state_dir") ??
        (xdgState
          ? join(xdgState, "pnpm")
          : join(home, ".local", "state", "pnpm")),
      expandsTilde: true,
    },
    {
      value: xdgCache ? join(xdgCache, "gh") : join(home, ".cache", "gh"),
    },
    {
      value: xdgState
        ? join(xdgState, "gh")
        : join(home, ".local", "state", "gh"),
    },
    ...(nixCache === "" ? [] : [{ value: nixCache }]),
    {
      value:
        firstNonEmpty(env.MISE_CACHE_DIR) ??
        join(home, "Library", "Caches", "mise"),
      expandsTilde: true,
    },
  ];
  return reviewedRoots.flatMap((reviewed) => {
    const candidate = rootCandidate(
      effectivePath(
        reviewed.value,
        sessionCwd,
        reviewed.expandsTilde ? home : undefined,
      ),
    );
    return candidate &&
      doesNotOverlapProtectedToolRoot(candidate, reviewed.allowedProtectedRoot)
      ? [candidate]
      : [];
  });
}

function ancestorPackageWorkspace(workspaceRoot: string): string | undefined {
  let cursor = dirname(workspaceRoot);
  while (true) {
    try {
      if (statSync(join(cursor, "package.json")).isFile()) {
        return cursor;
      }
    } catch {}
    const parent = dirname(cursor);
    if (parent === cursor) {
      return undefined;
    }
    cursor = parent;
  }
}

function packageDependencyRoot(packageRoot: string): string | undefined {
  const expected = join(packageRoot, "node_modules");
  try {
    const canonical = canonicalExisting(expected);
    return canonical === expected ? canonical : undefined;
  } catch {
    return undefined;
  }
}

async function containsTrackedFiles(
  packageWorkspace: string,
  dependencyRoot: string,
  gitRunner: GitRunner,
): Promise<boolean> {
  const relativeRoot = relative(packageWorkspace, dependencyRoot);
  if (
    relativeRoot === "" ||
    relativeRoot === ".." ||
    relativeRoot.startsWith(`..${sep}`)
  ) {
    return true;
  }
  const tracked = await gitRunner(packageWorkspace, [
    "ls-files",
    "-z",
    "--",
    relativeRoot,
  ]);
  return tracked.exitCode !== 0 || tracked.stdout.length > 0;
}

async function trackedDependencyRoots(
  packageWorkspace: string,
  gitRunner: GitRunner,
): Promise<readonly string[]> {
  const manifests = await gitRunner(packageWorkspace, [
    "ls-files",
    "-z",
    "--",
    "package.json",
    ":(glob)**/package.json",
  ]);
  if (manifests.exitCode !== 0) {
    return [];
  }
  const roots: string[] = [];
  for (const manifest of manifests.stdout.split("\0")) {
    if (!manifest) {
      continue;
    }
    const packageRoot = join(packageWorkspace, dirname(manifest));
    const dependencyRoot = packageDependencyRoot(packageRoot);
    if (
      dependencyRoot &&
      isUnder(dependencyRoot, packageWorkspace) &&
      !(await containsTrackedFiles(packageWorkspace, dependencyRoot, gitRunner))
    ) {
      roots.push(dependencyRoot);
    }
  }
  return normalizeRoots(roots);
}

async function dependencyInstallationRoots(
  workspaceRoot: string,
  gitRunner: GitRunner,
): Promise<readonly string[]> {
  const localRoots = await trackedDependencyRoots(workspaceRoot, gitRunner);
  const candidate = ancestorPackageWorkspace(workspaceRoot);
  if (!candidate) {
    return localRoots;
  }
  const worktrees = await gitRunner(workspaceRoot, [
    "worktree",
    "list",
    "--porcelain",
    "-z",
  ]);
  if (worktrees.exitCode !== 0) {
    return localRoots;
  }
  let packageWorkspace: string;
  try {
    packageWorkspace = canonicalExisting(candidate);
  } catch {
    return localRoots;
  }
  const registered = worktrees.stdout
    .split("\0")
    .filter((field) => field.startsWith("worktree "))
    .map((field) => field.slice("worktree ".length));
  if (
    !registered.some((path) => {
      try {
        return canonicalExisting(path) === packageWorkspace;
      } catch {
        return false;
      }
    })
  ) {
    return localRoots;
  }
  return normalizeRoots([
    ...localRoots,
    ...(await trackedDependencyRoots(packageWorkspace, gitRunner)),
  ]);
}

export async function resolveSandboxPolicy(
  options: Readonly<{
    sessionCwd: string;
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    temporaryDir?: string;
    standardTemporaryRoots?: readonly string[];
    gitRunner?: GitRunner;
  }>,
): Promise<SandboxPolicy> {
  const sessionCwd = canonicalExisting(options.sessionCwd);
  const gitRunner = options.gitRunner ?? runGit;
  const git = await resolveGit(sessionCwd, gitRunner);
  const workspaceRoot = git?.worktreeRoot ?? sessionCwd;
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const temporaryRoots = normalizeRoots(
    [
      absoluteDirectory(env.TMPDIR),
      absoluteDirectory(options.temporaryDir ?? tmpdir()),
      ...(options.standardTemporaryRoots ?? ["/tmp", "/var/tmp"]).map(
        absoluteDirectory,
      ),
    ].filter((root): root is string => root !== undefined),
  );
  const runtimeCandidates = toolRuntimeRootCandidates({
    env,
    home,
    sessionCwd,
  });
  const runtimeRoots = normalizeRoots(
    runtimeCandidates.map((root) => root.path),
  );
  const dependencyRoots = git
    ? await dependencyInstallationRoots(workspaceRoot, gitRunner)
    : [];
  const writableRoots = normalizeRoots([
    workspaceRoot,
    ...(git ? [git.worktreeGitDir, git.commonGitDir] : []),
    ...temporaryRoots,
    ...runtimeRoots,
    ...dependencyRoots,
  ]);
  const recursiveRoots = new Set(writableRoots);
  const creationRoots = Object.freeze([
    ...new Set(
      runtimeCandidates.flatMap((root) =>
        recursiveRoots.has(root.path) ? root.creationRoots.slice(0, -1) : [],
      ),
    ),
  ]);
  return Object.freeze({
    sessionCwd,
    workspaceRoot,
    ...(git ? { git } : {}),
    temporaryRoots,
    runtimeRoots,
    dependencyRoots,
    writableRoots,
    creationRoots,
  });
}

export function pathIsWithin(path: string, root: string): boolean {
  return isUnder(path, root);
}
