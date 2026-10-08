import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createEventBus,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOutputScope,
  bindOutputScope,
  inheritedOutputScope,
  type CaptureData,
} from "#context/retained-output";
import {
  SubagentRuntime,
  MANAGED_COMPLETION_TOOL_NAME,
} from "#subagents/runtime";
import {
  createManagedSessionHarness,
  MANAGED_TEST_PROVIDER,
  MANAGED_TEST_MODEL,
} from "#test/managed-session";
import { promoteVerification } from "./verification.js";
import { RuntimeSubagentClient } from "./subagents.js";
import { workstreamImplementerResultSchema } from "./result-schemas.js";
import { checkoutPaths, loadRunState } from "./store.js";
import { createLifecycleFixture } from "./lifecycle-test-support.js";
import { inspectImplementRun } from "./inspection-tool.js";
import { Check } from "typebox/value";
import { InspectResultSchema } from "./inspection-schema.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
const data: CaptureData = {
  execution: {
    state: "completed",
    exitCode: 0,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
  },
  text: "selected output",
  truncated: false,
  outputComplete: true,
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "implement-verification-"));
  roots.push(root);
  execFileSync("git", ["init", root]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--allow-empty",
    "-m",
    "test: initial",
  ]);
  const ctx = {
    sessionManager: SessionManager.inMemory(root),
    cwd: root,
  } as never;
  const scope = createOutputScope(join(root, "outputs"), ctx, {
    parentScopeId: randomUUID(),
    attemptId: randomUUID(),
  });
  const lease = scope.promotionLease();
  return { root, ctx, scope, lease };
}
async function capture(
  f: ReturnType<typeof fixture>,
  value = data,
  cwd = f.root,
) {
  const result = await f.scope
    .reserve(f.ctx, {
      sourceTool: "bash",
      callId: randomUUID(),
      cwd,
      command: "npm test",
    })
    .commit(value);
  if (result.retention !== "retained") {
    throw new Error("Fixture capture failed");
  }
  return result.outputRef;
}
function promote(
  f: ReturnType<typeof fixture>,
  outputRef: string,
  claimedOutcome: "passed" | "failed" = "passed",
  runDirectory = join(f.root, "run"),
) {
  return promoteVerification({
    verification: [
      { kind: "execution", label: "Tests", outputRef, claimedOutcome },
    ],
    lease: f.lease,
    cwd: f.root,
    runDirectory,
    workerId: "worker",
  });
}

describe("durable selected execution evidence", () => {
  it("copies selected validated output before private scope destruction with provenance and candidate uncertainty", async () => {
    const f = fixture();
    const outputRef = await capture(f, {
      ...data,
      truncated: true,
      outputComplete: false,
      droppedBytes: 12,
    });
    const [record] = await promote(f, outputRef);
    expect(record).toMatchObject({
      kind: "execution",
      outcome: "passed",
      attemptId: f.scope.origin.attemptId,
      candidateCoverage: "not_attested",
      truncated: true,
      droppedBytes: 12,
    });
    f.scope.close();
    f.lease.release();
    f.scope.release();
    expect(existsSync(join(f.scope.root, f.scope.origin.scopeId))).toBe(false);
    if (record?.kind !== "execution") {
      throw new Error("Missing promoted execution");
    }
    const saved = JSON.parse(
      readFileSync(join(f.root, "run", record.artifactPath), "utf8"),
    );
    expect(saved.output).toBe(data.text);
    expect(saved.verification).toEqual(record);
    expect(JSON.stringify(saved)).not.toContain(outputRef);
    expect(JSON.stringify(saved)).not.toContain(f.root);
  });

  it("roundtrips execution descriptors through v12 state and downstream inspection", async () => {
    const run = await createLifecycleFixture();
    roots.push(run.root);
    const captured = fixture();
    const reference = await capture(captured);
    const records = await promote(
      captured,
      reference,
      "passed",
      join(checkoutPaths(run.root).runs, "run-1"),
    );
    await run.store.update(run.store.read().revision, (state) => {
      state.workstreams.source["first-stream"]!.baseSha = "base-sha";
      state.candidates.candidate = {
        id: "candidate",
        workstream: { kind: "source", id: "first-stream" },
        baseSha: "base-sha",
        commitSha: "candidate-sha",
        treeSha: "tree-sha",
        implementationEvidence: { summary: "Checked", verification: records },
      };
      return state;
    });
    captured.scope.close();
    captured.lease.release();
    captured.scope.release();
    expect(loadRunState(run.store.path)).toEqual(run.store.read());
    const inspection = inspectImplementRun(run.root, { runId: "run-1" });
    expect(Check(InspectResultSchema, inspection)).toBe(true);
    expect(inspection).toMatchObject({
      ok: true,
      run: {
        verification: [
          {
            kind: "execution",
            outcome: "passed",
            candidateCoverage: "not_attested",
            attemptId: captured.scope.origin.attemptId,
          },
        ],
        artifacts: expect.arrayContaining([
          expect.objectContaining({
            kind: "execution",
            retained: true,
            path: expect.stringMatching(/^artifacts\/verification\//),
          }),
        ]),
      },
    });
  });

  it("rejects foreign attempts/worktrees, nonterminal/stopped receipts, false passing claims and corruption", async () => {
    const f = fixture();
    const other = fixture();
    await expect(promote(f, await capture(other))).rejects.toThrow("not found");
    await expect(
      promote(f, await capture(f, data, other.root)),
    ).rejects.toThrow("different worktree");
    await expect(promote(f, "missing")).rejects.toThrow("not found");
    for (const execution of [
      {
        ...data.execution,
        state: "running" as const,
        endedAt: undefined,
        exitCode: null,
      },
      { ...data.execution, state: "stopped" as const, exitCode: 0 },
      { ...data.execution, state: "failed" as const, exitCode: 1 },
    ]) {
      await expect(
        promote(f, await capture(f, { ...data, execution })),
      ).rejects.toThrow("terminal captured execution");
    }
    await expect(promote(f, await capture(f), "failed")).rejects.toThrow(
      "terminal captured execution",
    );
    expect(
      (
        await promote(
          f,
          await capture(f, {
            ...data,
            execution: { ...data.execution, state: "failed", exitCode: 1 },
          }),
          "failed",
        )
      )[0],
    ).toMatchObject({ outcome: "failed" });
    const corrupt = await capture(f);
    const files = readdirSync(join(f.scope.root, f.scope.origin.scopeId));
    const file = files.find((file) =>
      readFileSync(
        join(f.scope.root, f.scope.origin.scopeId, file),
        "utf8",
      ).includes(corrupt),
    )!;
    writeFileSync(join(f.scope.root, f.scope.origin.scopeId, file), "{}");
    await expect(promote(f, corrupt)).rejects.toThrow();
    f.lease.release();
    f.scope.release();
    other.lease.release();
    other.scope.release();
  });

  it.each([
    "completed",
    "promotion_failed",
    "invalid_receipt",
    "stopped",
    "inspection",
  ] as const)(
    "managed finalization flushes then promotes selected evidence then disposes: %s",
    async (mode) => {
      const failPromotion = mode === "promotion_failed";
      const controller = new AbortController();
      const f = fixture();
      const run = await createLifecycleFixture();
      roots.push(run.root);
      execFileSync("git", ["init", run.root]);
      execFileSync("git", [
        "-C",
        run.root,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "test: initial",
      ]);
      const workerCwd = join(f.root, "worker");
      execFileSync("git", [
        "-C",
        run.root,
        "worktree",
        "add",
        "--detach",
        workerCwd,
      ]);
      const parentCwd = join(run.root, "src");
      mkdirSync(parentCwd);
      const targetStatus = () =>
        execFileSync(
          "git",
          [
            "-C",
            run.root,
            "status",
            "--porcelain",
            "--untracked-files=all",
            "--",
            ".",
            ":(exclude).pi",
          ],
          { encoding: "utf8" },
        );
      const initialTargetStatus = targetStatus();
      const bus = createEventBus();
      const off = bindOutputScope(bus, f.scope);
      const order: string[] = [];
      let reference = "",
        childScopeId = "";
      const runDirectory = join(checkoutPaths(run.root).runs, "run-1");
      const harness = await createManagedSessionHarness(
        [
          fauxAssistantMessage(fauxToolCall("capture", {})),
          () =>
            fauxAssistantMessage(
              fauxToolCall(MANAGED_COMPLETION_TOOL_NAME, {
                outcome: "changed",
                summary: "Checked",
                verification:
                  mode === "inspection"
                    ? [
                        {
                          kind: "inspection",
                          label: "Contract",
                          evidence: "Observed rejection path.",
                        },
                      ]
                    : [
                        {
                          kind: "execution",
                          label: "Tests",
                          outputRef: reference,
                          claimedOutcome: "passed",
                        },
                      ],
              }),
            ),
        ],
        {
          extensionFactories: [
            (pi) => {
              let scope: ReturnType<typeof createOutputScope>;
              pi.on("session_start", (_event, ctx) => {
                scope = inheritedOutputScope(pi.events, ctx)!;
                childScopeId = scope.origin.scopeId;
              });
              pi.on("session_shutdown", () => {
                expect(
                  existsSync(join(runDirectory, "artifacts", "verification")),
                ).toBe(false);
                order.push("shutdown");
                if (failPromotion) {
                  // Make the host-owned artifacts location unavailable, not a worker path.
                  writeFileSync(
                    join(
                      run.root,
                      ".pi",
                      "pipkin",
                      "implement",
                      "runs",
                      "run-1",
                      "artifacts",
                    ),
                    "blocked",
                  );
                }
              });
              pi.registerTool({
                name: "capture",
                label: "Capture",
                description: "Capture fixture execution",
                parameters: Type.Object({}),
                async execute(_id, _input, _signal, _update, ctx) {
                  const receipt = await scope
                    .reserve(ctx, {
                      sourceTool: "bash",
                      callId: "capture",
                      cwd: workerCwd,
                    })
                    .commit(
                      mode === "invalid_receipt"
                        ? {
                            ...data,
                            execution: {
                              ...data.execution,
                              state: "failed",
                              exitCode: 1,
                            },
                          }
                        : data,
                    );
                  if (receipt.retention !== "retained") {
                    throw new Error("Capture failed");
                  }
                  reference = receipt.outputRef;
                  expect(f.scope.list(f.ctx).outputs).toEqual([]);
                  if (mode === "stopped") {
                    controller.abort();
                  }
                  return {
                    content: [{ type: "text", text: reference }],
                    details: undefined,
                  };
                },
              });
            },
          ],
        },
      );
      const pi = {
        events: bus,
        sendMessage() {},
        getActiveTools: () => ["capture"],
      };
      const runtime = new SubagentRuntime(pi as never, {
        createSession: async (options) => {
          const created = await harness.createSession(options);
          const dispose = created.session.dispose.bind(created.session);
          vi.spyOn(created.session, "dispose").mockImplementation(() => {
            order.push("dispose");
            const evidence = join(runDirectory, "artifacts", "verification");
            if (mode === "completed") {
              expect(readdirSync(evidence)).toHaveLength(1);
            }
            if (mode === "stopped" || mode === "inspection") {
              expect(existsSync(evidence)).toBe(false);
            }
            if (mode === "invalid_receipt") {
              const unavailable = readdirSync(evidence);
              expect(unavailable).toHaveLength(1);
              expect(
                JSON.parse(
                  readFileSync(join(evidence, unavailable[0]!), "utf8"),
                ),
              ).toMatchObject({ evidenceStatus: "unavailable" });
            }
            dispose();
          });
          return created;
        },
      });
      const ctx = {
        cwd: parentCwd,
        model: harness.model,
        modelRegistry: harness.modelRegistry,
      };
      const client = new RuntimeSubagentClient(
        pi as never,
        ctx as never,
        "run-1",
        runDirectory,
      );
      try {
        const id = await client.spawn({
          type: "pipkin:implement:implementer",
          role: "implementer",
          cwd: workerCwd,
          prompt: "capture and complete",
          description: "Verify",
          model: `${MANAGED_TEST_PROVIDER}/${MANAGED_TEST_MODEL}`,
          completion: {
            description: "Complete",
            schema: workstreamImplementerResultSchema,
          },
        });
        const result = await client.waitFor(id, controller.signal);
        expect(order).toEqual(["shutdown", "dispose"]);
        expect(runtime.snapshot(id)?.cleanupComplete).toBe(true);
        expect(existsSync(join(f.scope.root, childScopeId))).toBe(false);
        expect(result.status).toBe(
          mode === "promotion_failed" || mode === "invalid_receipt"
            ? "failed"
            : mode === "inspection"
              ? "completed"
              : mode,
        );
        expect(existsSync(join(parentCwd, ".pi"))).toBe(false);
        expect(existsSync(join(workerCwd, ".pi"))).toBe(false);
        expect(targetStatus()).toBe(initialTargetStatus);
        if (result.status === "completed") {
          const records = result.result.verification;
          await run.store.update(run.store.read().revision, (state) => {
            state.workstreams.source["first-stream"]!.baseSha = "base-sha";
            state.candidates.candidate = {
              id: "candidate",
              workstream: { kind: "source", id: "first-stream" },
              baseSha: "base-sha",
              commitSha: "candidate-sha",
              treeSha: "tree-sha",
              implementationEvidence: {
                summary: "Checked",
                verification: records,
              },
            };
            return state;
          });
          const inspection = inspectImplementRun(run.root, { runId: "run-1" });
          expect(Check(InspectResultSchema, inspection)).toBe(true);
          if (mode === "completed") {
            const record = records[0];
            if (record?.kind !== "execution") {
              throw new Error("Missing promoted execution");
            }
            expect(record).toMatchObject({
              kind: "execution",
              artifactPath: expect.stringMatching(/^artifacts\/verification\//),
            });
            const saved = JSON.parse(
              readFileSync(join(runDirectory, record.artifactPath), "utf8"),
            );
            expect(saved.output).toBe(data.text);
            expect(inspection).toMatchObject({
              ok: true,
              run: {
                artifacts: expect.arrayContaining([
                  expect.objectContaining({
                    kind: "execution",
                    retained: true,
                    path: record.artifactPath,
                  }),
                ]),
              },
            });
          } else {
            expect(records).toEqual([
              {
                kind: "inspection",
                label: "Contract",
                evidence: "Observed rejection path.",
              },
            ]);
          }
        }
      } finally {
        await runtime.dispose();
        off();
        f.lease.release();
        f.scope.release();
      }
    },
  );
});
