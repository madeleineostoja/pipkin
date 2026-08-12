import { spawn } from "node:child_process";
import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import type { ConfigIssue } from "#lib/config";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
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
  /** Standard disposable cache roots available to managed Bash and processes. */
  runtimeRoots: readonly string[];
  /** Package dependency trees treated as disposable Bash runtime state. */
  dependencyRoots: readonly string[];
  /** Explicit user-configured roots, retained independently from runtime roots. */
  configuredWritableRoots?: readonly string[];
  configuredRootProvenance?: readonly Readonly<{
    path: string;
    scope: "global" | "project";
  }>[];
  configuredIssues?: readonly ConfigIssue[];
  /** Pi/Pipkin configuration remains read-only even when repository writes are narrowed. */
  configurationRoots?: readonly string[];
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

function xdgBaseDirectory(value: string | undefined, fallback: string): string {
  return value && isAbsolute(value) ? value : fallback;
}

function cacheRootCandidate(value: string): RootCandidate | undefined {
  if (!isAbsolute(value)) {
    return undefined;
  }
  const normalized = resolve(value);
  const root = parse(normalized).root;
  let cursor = root;
  for (const component of normalized
    .slice(root.length)
    .split(sep)
    .filter(Boolean)) {
    cursor = join(cursor, component);
    try {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        return undefined;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return undefined;
      }
      break;
    }
  }
  try {
    return canonicalRoot(normalized);
  } catch {
    return undefined;
  }
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

const MAX_CONFIGURED_ROOTS = 256;

type ConfiguredInput = Readonly<{
  global?: readonly string[];
  project?: readonly string[];
  issues?: readonly ConfigIssue[];
  globalConfigPath?: string;
  projectConfigPath?: string;
}>;

type ConfiguredRoot = Readonly<{ path: string; scope: "global" | "project" }>;

function pathOverlaps(left: string, right: string): boolean {
  return isUnder(left, right) || isUnder(right, left);
}

function existingDirectoryWithoutLinks(path: string): string | undefined {
  if (!isAbsolute(path)) {
    return undefined;
  }
  const root = parse(path).root;
  let cursor = root;
  for (const component of path.slice(root.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    try {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        return undefined;
      }
    } catch {
      return undefined;
    }
  }
  try {
    return realpathSync(cursor);
  } catch {
    return undefined;
  }
}

function configuredPattern(
  pattern: string,
  scope: "global" | "project",
  home: string,
):
  | Readonly<{
      base: string;
      before: readonly string[];
      wildcard: boolean;
      leaf: string;
    }>
  | string {
  if (
    !pattern ||
    pattern.includes("\0") ||
    /\p{C}/u.test(pattern) ||
    /[?[\]{}!()]/.test(pattern)
  ) {
    return "contains unsupported path syntax";
  }
  let base: string;
  let parts: string[];
  if (scope === "global") {
    if (
      pattern === "~" ||
      (!pattern.startsWith("/") && !pattern.startsWith("~/"))
    ) {
      return "must be an absolute path or begin with ~/";
    }
    if (pattern.startsWith("~/")) {
      base = home;
      parts = pattern.slice(2).split("/");
    } else {
      base = parse(pattern).root;
      parts = pattern.slice(base.length).split("/");
    }
  } else {
    if (isAbsolute(pattern)) {
      return "must be relative to the workspace";
    }
    base = "";
    parts = pattern.split("/");
  }
  if (parts.some((part) => !part || part === "." || part === "..")) {
    return "contains an empty or traversal segment";
  }
  const leaf = parts.at(-1)!;
  if (leaf === "*" || leaf.includes("*")) {
    return "final segment must be a non-empty literal";
  }
  const wildcardIndices = parts.flatMap((part, index) =>
    part === "*" ? [index] : [],
  );
  if (
    wildcardIndices.length > 1 ||
    parts.some((part) => part.includes("*") && part !== "*")
  ) {
    return "supports at most one complete * segment";
  }
  if (wildcardIndices[0] === parts.length - 1) {
    return "final segment must be a non-empty literal";
  }
  return {
    base,
    before: parts.slice(0, -1),
    wildcard: wildcardIndices.length === 1,
    leaf,
  };
}

function expandedConfiguredCandidates(
  pattern: string,
  scope: "global" | "project",
  workspaceRoot: string,
  home: string,
): Readonly<{
  candidates: readonly string[];
  reason?: string;
  issues?: readonly string[];
}> {
  const parsed = configuredPattern(pattern, scope, home);
  if (typeof parsed === "string") {
    return { candidates: [], reason: parsed };
  }
  const base = scope === "global" ? parsed.base : workspaceRoot;
  const wildcard = parsed.before.indexOf("*");
  const fixed = wildcard < 0 ? parsed.before : parsed.before.slice(0, wildcard);
  const parent =
    fixed.length === 0
      ? existingDirectoryWithoutLinks(base)
      : existingDirectoryWithoutLinks(join(base, ...fixed));
  if (!parent) {
    return {
      candidates: [],
      reason: "parent directory does not exist or contains a symlink",
    };
  }
  if (wildcard < 0) {
    return { candidates: [join(parent, parsed.leaf)] };
  }
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return { candidates: [], reason: "could not read wildcard parent" };
  }
  const suffix = parsed.before.slice(wildcard + 1);
  const boundedEntries = entries.slice(0, MAX_CONFIGURED_ROOTS + 1);
  const candidates: string[] = [];
  const issues: string[] = [];
  let suffixFailure = false;
  for (const entry of boundedEntries) {
    const child = existingDirectoryWithoutLinks(join(parent, entry));
    if (!child) {
      continue;
    }
    const suffixParent =
      suffix.length === 0
        ? child
        : existingDirectoryWithoutLinks(join(child, ...suffix));
    if (!suffixParent) {
      suffixFailure = true;
      continue;
    }
    candidates.push(join(suffixParent, parsed.leaf));
  }
  if (suffixFailure) {
    issues.push("literal parent after * does not exist or contains a symlink");
  }
  if (entries.length > MAX_CONFIGURED_ROOTS) {
    issues.push("wildcard discovery exceeds bounded entry limit");
  }
  return { candidates, ...(issues.length ? { issues } : {}) };
}

function canonicalConfiguredCandidate(candidate: string): string | undefined {
  const parent = existingDirectoryWithoutLinks(dirname(candidate));
  if (!parent) {
    return undefined;
  }
  const leaf = basename(candidate);
  try {
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return undefined;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return undefined;
    }
  }
  return join(parent, leaf);
}

function protectedDirectory(path: string | undefined): string | undefined {
  if (!path || !isAbsolute(path)) {
    return undefined;
  }
  try {
    return canonicalRoot(path).path;
  } catch {
    return undefined;
  }
}

function globalCandidateIsSafe(
  candidate: string,
  options: Readonly<{
    home: string;
    workspaceRoot: string;
    git?: SandboxGit;
    temporaryRoots: readonly string[];
    configurationRoots: readonly string[];
    env: NodeJS.ProcessEnv;
  }>,
): boolean {
  const pathDirectories = (options.env.PATH ?? "")
    .split(":")
    .map(protectedDirectory)
    .filter((value): value is string => value !== undefined);
  const xdgConfig = protectedDirectory(
    xdgBaseDirectory(
      options.env.XDG_CONFIG_HOME,
      join(options.home, ".config"),
    ),
  );
  const directional = [
    ...options.temporaryRoots,
    ...pathDirectories,
    ...(xdgConfig ? [xdgConfig] : []),
    ...(process.platform === "darwin"
      ? [join(options.home, "Library", "Preferences")]
      : []),
  ];
  if (candidate === parse(candidate).root || isUnder(options.home, candidate)) {
    return false;
  }
  if (pathOverlaps(candidate, options.workspaceRoot)) {
    return false;
  }
  if (
    [
      ...(options.git
        ? [options.git.worktreeGitDir, options.git.commonGitDir]
        : []),
      ...options.configurationRoots,
    ].some((root) => pathOverlaps(candidate, root))
  ) {
    return false;
  }
  return !directional.some(
    (root) => candidate === root || isUnder(root, candidate),
  );
}

function standardRuntimeRootCandidates(
  options: Readonly<{
    env: NodeJS.ProcessEnv;
    home: string;
    sessionCwd: string;
    workspaceRoot: string;
    git?: SandboxGit;
    temporaryRoots: readonly string[];
    configurationRoots: readonly string[];
  }>,
): readonly RootCandidate[] {
  const { env, home, sessionCwd } = options;
  const values = [
    effectivePath(
      npmEnvironmentValue(env, "cache") ?? join(home, ".npm"),
      sessionCwd,
      home,
    ),
    xdgBaseDirectory(env.XDG_CACHE_HOME, join(home, ".cache")),
    ...(process.platform === "darwin" ? [join(home, "Library", "Caches")] : []),
  ];
  return values.flatMap((value) => {
    const candidate = cacheRootCandidate(value);
    return candidate && globalCandidateIsSafe(candidate.path, options)
      ? [candidate]
      : [];
  });
}

async function configuredRoots(
  configured: ConfiguredInput | undefined,
  context: Readonly<{
    workspaceRoot: string;
    git?: SandboxGit;
    home: string;
    temporaryRoots: readonly string[];
    env: NodeJS.ProcessEnv;
    gitRunner: GitRunner;
    configurationRoots: readonly string[];
  }>,
): Promise<
  Readonly<{ roots: readonly ConfiguredRoot[]; issues: readonly ConfigIssue[] }>
> {
  const roots: ConfiguredRoot[] = [];
  let expansions = 0;
  const issues: ConfigIssue[] = [...(configured?.issues ?? [])].slice(0, 32);
  const issue = (
    scope: "global" | "project",
    index: number,
    message: string,
  ) => {
    if (issues.length < 32) {
      issues.push({ scope, path: `sandbox.writable.${index}`, message });
    }
  };
  for (const scope of ["global", "project"] as const) {
    for (const [index, pattern] of (configured?.[scope] ?? []).entries()) {
      const expansion = expandedConfiguredCandidates(
        pattern,
        scope,
        context.workspaceRoot,
        context.home,
      );
      if (expansion.reason) {
        issue(scope, index, expansion.reason);
        continue;
      }
      for (const message of expansion.issues ?? []) {
        issue(scope, index, message);
      }
      for (const rawCandidate of expansion.candidates) {
        if (expansions >= MAX_CONFIGURED_ROOTS) {
          issue(
            scope,
            index,
            `exceeds ${MAX_CONFIGURED_ROOTS} concrete root limit`,
          );
          break;
        }
        expansions += 1;
        const candidate = canonicalConfiguredCandidate(rawCandidate);
        if (!candidate) {
          issue(
            scope,
            index,
            "target contains a symlink or is not a directory",
          );
          continue;
        }
        let safe = false;
        if (scope === "global") {
          safe = globalCandidateIsSafe(candidate, context);
          if (!safe) {
            issue(scope, index, "overlaps protected filesystem authority");
          }
        } else if (
          !context.git ||
          candidate === context.workspaceRoot ||
          !isUnder(candidate, context.workspaceRoot) ||
          context.configurationRoots.some((root) =>
            pathOverlaps(candidate, root),
          ) ||
          [context.git.worktreeGitDir, context.git.commonGitDir].some((root) =>
            pathOverlaps(candidate, root),
          )
        ) {
          issue(
            scope,
            index,
            "must be an ignored untracked directory strictly inside this Git workspace",
          );
        } else {
          const relativeCandidate = relative(context.workspaceRoot, candidate);
          try {
            const ignored = await context.gitRunner(context.workspaceRoot, [
              "check-ignore",
              "-q",
              "--no-index",
              "--",
              relativeCandidate,
            ]);
            const tracked = await context.gitRunner(context.workspaceRoot, [
              "ls-files",
              "-z",
              "--",
              relativeCandidate,
            ]);
            safe =
              ignored.exitCode === 0 &&
              tracked.exitCode === 0 &&
              tracked.stdout.length === 0;
          } catch {
            safe = false;
          }
          if (!safe) {
            issue(
              scope,
              index,
              "must be ignored by Git and contain no tracked files",
            );
          }
        }
        if (safe && !roots.some((root) => root.path === candidate)) {
          roots.push({ path: candidate, scope });
        }
      }
    }
  }
  return Object.freeze({
    roots: Object.freeze(roots.map((root) => Object.freeze({ ...root }))),
    issues: Object.freeze(issues.map((issue) => Object.freeze({ ...issue }))),
  });
}

export async function resolveSandboxPolicy(
  options: Readonly<{
    sessionCwd: string;
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    temporaryDir?: string;
    standardTemporaryRoots?: readonly string[];
    gitRunner?: GitRunner;
    configured?: ConfiguredInput;
    configurationForWorkspace?: (workspaceRoot: string) => ConfiguredInput;
  }>,
): Promise<SandboxPolicy> {
  const sessionCwd = canonicalExisting(options.sessionCwd);
  const gitRunner = options.gitRunner ?? runGit;
  const git = await resolveGit(sessionCwd, gitRunner);
  const workspaceRoot = git?.worktreeRoot ?? sessionCwd;
  const env = options.env ?? process.env;
  const home = canonicalExisting(options.homeDir ?? homedir());
  const temporaryRoots = normalizeRoots(
    [
      absoluteDirectory(env.TMPDIR),
      absoluteDirectory(options.temporaryDir ?? tmpdir()),
      ...(options.standardTemporaryRoots ?? ["/tmp", "/var/tmp"]).map(
        absoluteDirectory,
      ),
    ].filter((root): root is string => root !== undefined),
  );
  const configuredInput =
    options.configured ?? options.configurationForWorkspace?.(workspaceRoot);
  const configurationRoots = Object.freeze(
    [configuredInput?.globalConfigPath, configuredInput?.projectConfigPath]
      .map((path) => path && protectedDirectory(dirname(dirname(path))))
      .filter((path): path is string => path !== undefined),
  );
  const runtimeCandidates = standardRuntimeRootCandidates({
    env,
    home,
    sessionCwd,
    workspaceRoot,
    ...(git ? { git } : {}),
    temporaryRoots,
    configurationRoots,
  });
  const runtimeRoots = normalizeRoots(
    runtimeCandidates.map((root) => root.path),
  );
  const dependencyRoots = git
    ? await dependencyInstallationRoots(workspaceRoot, gitRunner)
    : [];
  const configured = await configuredRoots(configuredInput, {
    workspaceRoot,
    git,
    home,
    temporaryRoots,
    env,
    gitRunner,
    configurationRoots,
  });
  const configuredWritableRoots = Object.freeze(
    configured.roots.map((root) => root.path),
  );
  const coreWritableRoots = normalizeRoots([
    workspaceRoot,
    ...(git ? [git.worktreeGitDir, git.commonGitDir] : []),
    ...temporaryRoots,
    ...runtimeRoots,
    ...dependencyRoots,
  ]);
  const writableRoots = Object.freeze([
    ...coreWritableRoots,
    ...configuredWritableRoots.filter(
      (root) => !coreWritableRoots.includes(root),
    ),
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
    configuredWritableRoots,
    configuredRootProvenance: configured.roots,
    configuredIssues: configured.issues,
    configurationRoots,
    writableRoots,
    creationRoots,
  });
}

export function pathIsWithin(path: string, root: string): boolean {
  return isUnder(path, root);
}
