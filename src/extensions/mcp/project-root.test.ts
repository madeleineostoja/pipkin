import { describe, expect, it } from "vitest";
import { resolveMcpProjectRoot } from "./project-root.ts";

describe("resolveMcpProjectRoot", () => {
  it("uses the canonical Git worktree root for nested directories", () => {
    const seen: string[] = [];
    expect(
      resolveMcpProjectRoot("/link/repo/packages/app", {
        canonicalize: (path) =>
          ({
            "/link/repo/packages/app": "/repo/packages/app",
            "/repo": "/repo",
          })[path] ?? path,
        runGit: (cwd) => {
          seen.push(cwd);
          return "/repo\n";
        },
      }),
    ).toBe("/repo");
    expect(seen).toEqual(["/repo/packages/app"]);
  });

  it("gives nested paths in one worktree one canonical root", () => {
    const canonicalize = (path: string) =>
      ({
        "/links/repo/packages/a": "/repo/packages/a",
        "/links/repo/packages/b": "/repo/packages/b",
        "/worktree": "/worktree",
      })[path] ?? path;
    const dependencies = { canonicalize, runGit: () => "/worktree\n" };

    expect(resolveMcpProjectRoot("/links/repo/packages/a", dependencies)).toBe(
      "/worktree",
    );
    expect(resolveMcpProjectRoot("/links/repo/packages/b", dependencies)).toBe(
      "/worktree",
    );
  });

  it("uses only canonical cwd outside a usable Git worktree", () => {
    expect(
      resolveMcpProjectRoot("/link/outside", {
        canonicalize: () => "/outside",
        runGit: () => {
          throw new Error("not a repository");
        },
      }),
    ).toBe("/outside");
  });

  it("omits the project when canonicalization fails", () => {
    expect(
      resolveMcpProjectRoot("/missing", {
        canonicalize: () => {
          throw new Error("missing");
        },
      }),
    ).toBeUndefined();
    expect(
      resolveMcpProjectRoot("/repo/nested", {
        canonicalize: (path) => {
          if (path === "/repo") {
            throw new Error("missing root");
          }
          return path;
        },
        runGit: () => "/repo\n",
      }),
    ).toBeUndefined();
  });
});
