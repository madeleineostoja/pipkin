import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSandboxDenialRecorder } from "./denials.js";
import { createSandboxSessionState } from "./state.js";
import { createSandboxToolGate } from "./tool-gate.js";

const directories: string[] = [];

afterEach(() => {
  while (directories.length) {
    rmSync(directories.pop()!, { force: true, recursive: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pipkin-sandbox-gate-"));
  directories.push(root);
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  const temporaryRoot = join(root, "temporary");
  mkdirSync(workspace);
  mkdirSync(outside);
  mkdirSync(temporaryRoot);
  const state = createSandboxSessionState();
  const denials = createSandboxDenialRecorder();
  state.reset({
    sessionCwd: realpathSync(workspace),
    workspaceRoot: realpathSync(workspace),
    temporaryRoots: [realpathSync(temporaryRoot)],
    runtimeRoots: [],
    dependencyRoots: [],
    writableRoots: [realpathSync(workspace), realpathSync(temporaryRoot)],
    creationRoots: [],
  });
  return {
    denials,
    outside: realpathSync(outside),
    state,
    temporaryRoot: realpathSync(temporaryRoot),
    workspace: realpathSync(workspace),
  };
}

describe("Sandbox direct-tool gate", () => {
  it("blocks enabled macOS direct writes outside the effective workspace and temporary targets", () => {
    const { denials, outside, state, workspace } = fixture();
    const gate = createSandboxToolGate({ state, denials, supportedMac: true });
    expect(
      gate({ toolName: "write", input: { path: "inside.txt" } }, {} as never),
    ).toBeUndefined();
    expect(
      gate(
        { toolName: "edit", input: { path: join(outside, "outside.txt") } },
        {} as never,
      ),
    ).toEqual({
      block: true,
      reason: `Sandbox: direct writes must stay in the workspace or a temporary root. Effective target: ${join(outside, "outside.txt")}`,
    });
    expect(workspace).toBe(state.policy()?.workspaceRoot);
    expect(denials.snapshot()).toMatchObject({
      count: 1,
      recent: [
        {
          kind: "direct",
          tool: "edit",
          requestedPath: join(outside, "outside.txt"),
          target: join(outside, "outside.txt"),
        },
      ],
    });
  });

  it("allows enabled macOS direct writes under canonical temporary roots", () => {
    const { denials, state, temporaryRoot } = fixture();
    const gate = createSandboxToolGate({ state, denials, supportedMac: true });
    expect(
      gate(
        { toolName: "write", input: { path: join(temporaryRoot, "reply.md") } },
        {} as never,
      ),
    ).toBeUndefined();
    expect(denials.snapshot().count).toBe(0);
  });

  it("does not gate Linux or explicitly disabled macOS sessions", () => {
    const { denials, outside, state } = fixture();
    const event = { toolName: "write", input: { path: join(outside, "file") } };
    expect(
      createSandboxToolGate({ state, denials, supportedMac: false })(
        event,
        {} as never,
      ),
    ).toBeUndefined();
    state.setEnabled(false);
    expect(
      createSandboxToolGate({ state, denials, supportedMac: true })(
        event,
        {} as never,
      ),
    ).toBeUndefined();
    expect(denials.snapshot().count).toBe(0);
  });

  it("denies repository mutation for enabled repository-read-only children", () => {
    const { denials, state } = fixture();
    state.reset(state.policy(), undefined, "repository-read-only");
    expect(
      createSandboxToolGate({ state, denials, supportedMac: true })(
        { toolName: "write", input: { path: "inside.txt" } },
        {} as never,
      ),
    ).toMatchObject({
      block: true,
      reason: expect.stringContaining("repository-read-only"),
    });
  });

  it("fails closed after macOS policy initialization failure", () => {
    const state = createSandboxSessionState();
    const denials = createSandboxDenialRecorder();
    state.reset(
      undefined,
      "Sandbox: initialization failed: Git resolution failed.",
    );
    expect(
      createSandboxToolGate({ state, denials, supportedMac: true })(
        { toolName: "write", input: { path: "file" } },
        {} as never,
      ),
    ).toEqual({
      block: true,
      reason: "Sandbox: initialization failed: Git resolution failed.",
    });
    expect(denials.snapshot()).toMatchObject({
      count: 1,
      recent: [
        {
          kind: "direct",
          tool: "write",
          requestedPath: "file",
          reason: "Sandbox: initialization failed: Git resolution failed.",
        },
      ],
    });
  });
});
