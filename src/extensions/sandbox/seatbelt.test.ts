import { describe, expect, it } from "vitest";
import type { SandboxPolicy } from "./policy.js";
import {
  SANDBOX_EXECUTABLE,
  SANDBOX_PROFILE,
  sandboxArguments,
  sandboxParameters,
  sandboxProfile,
} from "./seatbelt.js";

const policy: SandboxPolicy = {
  sessionCwd: "/workspace",
  workspaceRoot: "/workspace",
  temporaryRoots: ["/temporary"],
  runtimeRoots: ["/home/user/cache/store"],
  dependencyRoots: [],
  writableRoots: ["/workspace", "/temporary", "/home/user/cache/store"],
  creationRoots: ["/home/user/cache"],
};

describe("Sandbox Seatbelt profile", () => {
  it("is deny-default with narrowed process, device, shared-memory, and network compatibility", () => {
    expect(SANDBOX_PROFILE).toContain("(deny default)");
    expect(SANDBOX_PROFILE).toContain("(allow file-read*)");
    expect(SANDBOX_PROFILE).toContain("(allow network*)");
    expect(SANDBOX_PROFILE).toContain("(allow process-exec)");
    expect(SANDBOX_PROFILE).toContain(
      '(global-name "com.apple.system.opendirectoryd.libinfo")',
    );
    expect(SANDBOX_PROFILE).toContain(
      '(allow file-write-data file-ioctl\n  (literal "/dev/dtracehelper"))',
    );
    expect(SANDBOX_PROFILE).toContain(
      '(allow file-write-data\n  (literal "/dev/tty")\n  (literal "/dev/fd/1")\n  (literal "/dev/fd/2"))',
    );
    expect(SANDBOX_PROFILE).toContain(
      '(allow file-ioctl (regex #"^/dev/ttys[0-9]+$"))',
    );
    expect(SANDBOX_PROFILE).toContain(
      '(ipc-posix-name-regex #"^/__KMP_REGISTERED_LIB_[0-9]+$")',
    );
    expect(SANDBOX_PROFILE).not.toContain('(import "system.sb")');
    expect(SANDBOX_PROFILE).not.toContain("(allow file-ioctl)\n");
    expect(SANDBOX_PROFILE).not.toContain("(allow ipc-posix-shm)\n");
  });

  it("generates parameterized recursive and exact creation authority", () => {
    const profile = sandboxProfile(policy);
    expect(profile).toContain('(literal (param "root0"))');
    expect(profile).toContain('(subpath (param "root0"))');
    expect(profile).toContain('(literal (param "create0"))');
    expect(profile).not.toContain("/workspace");
    expect(profile).not.toContain("/home/user/cache");
  });

  it("marks a protected invocation's default denial without widening policy", () => {
    const marker = "PIPKIN_ABC123";
    const profile = sandboxProfile(policy, marker);
    expect(profile).toContain(`(deny default (with message "${marker}"))`);
    expect(profile).not.toContain("(deny default)\n");
    expect(() => sandboxProfile(policy, 'PIPKIN_bad"')).toThrow(
      "invalid denial marker",
    );
  });

  it("keeps repository-root literal and descendant denies after every write allow", () => {
    const linked: SandboxPolicy = {
      ...policy,
      git: {
        worktreeRoot: "/tmp/worktree",
        worktreeGitDir: "/tmp/git/worktrees/child",
        commonGitDir: "/tmp/git",
      },
      workspaceRoot: "/tmp/worktree",
      writableRoots: ["/tmp", "/home/user/cache/store"],
      creationRoots: [],
    };
    const profile = sandboxProfile(
      linked,
      "PIPKIN_ABC123",
      "repository-read-only",
    );
    const tail = profile.indexOf(
      '(deny file-write* (with message "PIPKIN_ABC123")',
    );
    expect(tail).toBeGreaterThan(profile.indexOf("(allow file-write*"));
    expect(profile.slice(tail)).not.toContain("(allow file-write*");
    for (const [index, root] of [
      "/tmp/worktree",
      "/tmp/git/worktrees/child",
      "/tmp/git",
    ].entries()) {
      expect(profile).toContain(`(literal (param "protected${index}"))`);
      expect(profile).toContain(`(subpath (param "protected${index}"))`);
      expect(profile).not.toContain(root);
    }
    expect(
      sandboxArguments({
        policy: linked,
        shell: { shell: "/bin/bash", args: ["-s"] },
        marker: "PIPKIN_ABC123",
        writeMode: "repository-read-only",
      }),
    ).toEqual(
      expect.arrayContaining([
        "-D",
        "root0=/temporary",
        "-D",
        "protected0=/tmp/worktree",
        "-D",
        "protected1=/tmp/git/worktrees/child",
        "-D",
        "protected2=/tmp/git",
      ]),
    );
  });

  it("keeps Git writable in workspace-write mode while locking Pipkin configuration", () => {
    const workspaceWrite: SandboxPolicy = {
      ...policy,
      git: {
        worktreeRoot: "/workspace",
        worktreeGitDir: "/workspace/.git",
        commonGitDir: "/workspace/.git",
      },
      configurationRoots: ["/workspace/.pi"],
    };
    const arguments_ = sandboxArguments({
      policy: workspaceWrite,
      shell: { shell: "/bin/bash", args: ["-s"] },
      writeMode: "workspace-write",
    });
    expect(arguments_).toEqual(
      expect.arrayContaining(["-D", "locked0=/workspace/.pi"]),
    );
    expect(arguments_).not.toContain("locked0=/workspace/.git");
    expect(
      sandboxProfile(workspaceWrite, undefined, "workspace-write"),
    ).not.toContain('(param "locked1")');
  });

  it("permits a configured repository descendant but locks Pipkin configuration", () => {
    const configured: SandboxPolicy = {
      ...policy,
      configuredWritableRoots: ["/workspace/generated"],
      configurationRoots: ["/workspace/.pi"],
      writableRoots: ["/workspace", "/workspace/generated", "/temporary"],
    };
    const arguments_ = sandboxArguments({
      policy: configured,
      shell: { shell: "/bin/bash", args: ["-s"] },
      writeMode: "repository-read-only",
    });
    expect(arguments_).toEqual(
      expect.arrayContaining([
        "-D",
        "root2=/workspace/generated",
        "-D",
        "exception0=/workspace/generated",
        "-D",
        "locked0=/workspace/.pi",
      ]),
    );
    expect(
      sandboxProfile(configured, undefined, "repository-read-only"),
    ).toContain('(subpath (param "locked0"))');
  });

  it("keeps safe runtime-root creation and disposable dependency authority", () => {
    const readOnly: SandboxPolicy = {
      ...policy,
      workspaceRoot: "/tmp/checkout",
      runtimeRoots: ["/home/user/missing-cache/store"],
      dependencyRoots: [
        "/tmp/checkout/node_modules",
        "/package-workspace/node_modules",
      ],
      writableRoots: [
        "/tmp/checkout",
        "/temporary",
        "/home/user/missing-cache/store",
        "/tmp/checkout/node_modules",
        "/package-workspace/node_modules",
      ],
      creationRoots: ["/home/user/missing-cache"],
    };
    const profile = sandboxProfile(
      readOnly,
      "PIPKIN_ABC123",
      "repository-read-only",
    );
    const arguments_ = sandboxArguments({
      policy: readOnly,
      shell: { shell: "/bin/bash", args: ["-s"] },
      marker: "PIPKIN_ABC123",
      writeMode: "repository-read-only",
    });

    expect(arguments_).toEqual(
      expect.arrayContaining([
        "-D",
        "root0=/temporary",
        "-D",
        "root1=/home/user/missing-cache/store",
        "-D",
        "root2=/tmp/checkout/node_modules",
        "-D",
        "root3=/package-workspace/node_modules",
        "-D",
        "create0=/home/user/missing-cache",
        "-D",
        "exception0=/tmp/checkout/node_modules",
      ]),
    );
    expect(profile).toContain('(literal (param "create0"))');
    expect(profile).toContain("(require-not\n      (require-any");
    expect(profile).toContain('(subpath (param "exception0"))');
  });

  it("drops repository-contained runtime roots without dropping dependency exceptions", () => {
    const contained: SandboxPolicy = {
      ...policy,
      workspaceRoot: "/workspace",
      runtimeRoots: ["/workspace/cache"],
      dependencyRoots: ["/workspace/node_modules"],
      writableRoots: [
        "/workspace",
        "/temporary",
        "/workspace/cache",
        "/workspace/node_modules",
      ],
      creationRoots: [],
    };
    const arguments_ = sandboxArguments({
      policy: contained,
      shell: { shell: "/bin/bash", args: ["-s"] },
      writeMode: "repository-read-only",
    });

    expect(arguments_).not.toContain("root1=/workspace/cache");
    expect(arguments_).toContain("root1=/workspace/node_modules");
    expect(arguments_).not.toContain("/_tmp_42_probe");
    expect(arguments_).not.toContain("/workspace/../_tmp_42_probe");
  });

  it("binds arbitrary protected paths without interpolating them into the profile", () => {
    const protectedPath = '/tmp/a"back\\slash\n(comment)';
    const unsafe: SandboxPolicy = {
      ...policy,
      workspaceRoot: protectedPath,
      writableRoots: [protectedPath, "/temporary"],
    };
    const profile = sandboxProfile(
      unsafe,
      "PIPKIN_ABC123",
      "repository-read-only",
    );
    const arguments_ = sandboxArguments({
      policy: unsafe,
      shell: { shell: "/bin/bash", args: ["-s"] },
      marker: "PIPKIN_ABC123",
      writeMode: "repository-read-only",
    });

    expect(profile).toContain('(literal (param "protected0"))');
    expect(profile).toContain('(subpath (param "protected0"))');
    expect(profile).not.toContain(protectedPath);
    expect(arguments_).toEqual(
      expect.arrayContaining(["-D", `protected0=${protectedPath}`]),
    );
  });

  it("uses stable, separate parameter arguments and stdin shell launch", () => {
    const args = sandboxArguments({
      policy,
      shell: { shell: "/bin/bash", args: ["-s"] },
      marker: "PIPKIN_ABC123",
    });
    expect(SANDBOX_EXECUTABLE).toBe("/usr/bin/sandbox-exec");
    expect(args.slice(0, 8)).toEqual([
      "-D",
      "root0=/workspace",
      "-D",
      "root1=/temporary",
      "-D",
      "root2=/home/user/cache/store",
      "-D",
      "create0=/home/user/cache",
    ]);
    expect(args).toEqual(
      expect.arrayContaining([
        "-p",
        sandboxProfile(policy, "PIPKIN_ABC123"),
        "/bin/bash",
        "-s",
      ]),
    );
    expect(
      args.filter((value, index) => args[index - 1] === "-D"),
    ).toHaveLength(4);
  });

  it("rejects malformed roots and unrelated creation grants before launch", () => {
    expect(() => sandboxParameters(["relative"])).toThrow(
      "invalid writable roots",
    );
    expect(() => sandboxParameters(["/one", "/one"])).toThrow(
      "invalid writable roots",
    );
    expect(() =>
      sandboxArguments({
        policy: { ...policy, creationRoots: ["/unrelated"] },
        shell: { shell: "/bin/bash", args: ["-s"] },
      }),
    ).toThrow("invalid writable roots");
  });
});
