import { realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";

export type McpProjectRootDependencies = Readonly<{
  canonicalize?: (path: string) => string;
  runGit?: (cwd: string) => string;
}>;

/** Resolves only the current worktree, never a convenient ancestor. */
export function resolveMcpProjectRoot(
  cwd: string,
  dependencies: McpProjectRootDependencies = {},
): string | undefined {
  const canonicalize = dependencies.canonicalize ?? realpathSync;
  let canonicalCwd: string;
  try {
    canonicalCwd = canonicalize(cwd);
  } catch {
    return undefined;
  }

  let gitRoot: string;
  try {
    gitRoot = (dependencies.runGit ?? runGit)(canonicalCwd).trim();
  } catch {
    return canonicalCwd;
  }
  if (!gitRoot) {
    return canonicalCwd;
  }

  try {
    return canonicalize(gitRoot);
  } catch {
    return undefined;
  }
}

function runGit(cwd: string): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}
