import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  implementWorkerExcludedTools,
  RuntimeSubagentClient,
  type ImplementRoles,
} from "./subagents.js";
import { SubagentRuntime } from "#subagents/runtime";
import {
  completionContracts,
  REPOSITORY_PRESERVING_ROLE_CONTRACT,
  spawnValidatedWorker,
} from "./worker-invocation.js";
import { MANAGED_COMPLETION_FINAL_ACTION } from "#subagents/completion";
import { buildStrictExecutionPlannerPrompt } from "./execution-plan.js";
import {
  buildAnchoredOverallReviewPrompt,
  buildAnchoredWorkstreamReviewPrompt,
  buildInitialOverallReviewPrompt,
  buildInitialWorkstreamReviewPrompt,
  buildOverallReworkPrompt,
  buildReconciliationPrompt,
  buildRevisionPrompt,
  buildWorkstreamImplementerPrompt,
} from "./prompts.js";

describe("managed Pipkin Implement worker tools", () => {
  it("keeps Implement's worker-specific inspection exclusion separate from generic policy", () => {
    expect(implementWorkerExcludedTools()).toEqual(["inspect_implement_run"]);
  });

  it("gives mutable and repository-read-only workers broad inherited tools with Implement's inspection exclusion", async () => {
    const activeTools = [
      "read",
      "edit",
      "write",
      "docs",
      "web_fetch",
      "browser_observe",
      "inspect_implement_run",
      "Agent",
      "get_subagent_result",
      "steer_subagent",
    ];
    const sessions = Array.from(
      { length: 2 },
      () =>
        ({
          bindExtensions: vi.fn(async () => undefined),
          prompt: vi.fn(async () => undefined),
          steer: vi.fn(async () => undefined),
          abort: vi.fn(async () => undefined),
          dispose: vi.fn(),
          getLastAssistantText: vi.fn(() => "done"),
          setActiveToolsByName: vi.fn(),
          state: {},
          messages: [],
          sessionId: "child",
          subscribe: vi.fn(() => vi.fn()),
          getAllTools: vi.fn(() => []),
          extensionRunner: { hasHandlers: vi.fn(() => false), emit: vi.fn() },
        }) as unknown as AgentSession,
    );
    const createSession = vi.fn(async (_options?: unknown) => ({
      session: sessions.shift()!,
    }));
    const pi = { getActiveTools: () => activeTools };
    const runtime = new SubagentRuntime(pi as never, { createSession });
    expect(runtime).toBeInstanceOf(SubagentRuntime);
    const client = new RuntimeSubagentClient(
      pi as never,
      {
        cwd: "/worktree",
        model: { provider: "test", id: "model" },
        modelRegistry: { find: vi.fn() },
      } as never,
      "run",
    );

    const mutable = await client.spawn({
      type: "pipkin:implement:implementer",
      prompt: "implement",
      description: "implement",
    });
    const readOnly = await client.spawn({
      type: "pipkin:implement:reviewer",
      prompt: "review",
      description: "review",
      readOnly: true,
    });

    const selected = (index: number) => {
      const options = createSession.mock.calls[index]?.[0];
      if (!options) {
        throw new Error(`Missing child session ${index}`);
      }
      return (options as unknown as { tools: string[] }).tools;
    };
    expect(selected(0)).toEqual([
      "read",
      "edit",
      "write",
      "docs",
      "web_fetch",
      "browser_observe",
      "explore",
    ]);
    expect(selected(1)).toEqual([
      "read",
      "docs",
      "web_fetch",
      "browser_observe",
      "explore",
    ]);
    await expect(client.waitFor(mutable)).resolves.toEqual({
      status: "completed",
      result: "done",
    });
    await expect(client.waitFor(readOnly)).resolves.toEqual({
      status: "completed",
      result: "done",
    });
  });

  it("keeps managed runtime ownership in the Implement adapter", () => {
    const directory = dirname(fileURLToPath(import.meta.url));
    const owners = readdirSync(directory, {
      recursive: true,
      encoding: "utf8",
    })
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .filter((name) => {
        const source = readFileSync(join(directory, name), "utf-8");
        return (
          source.includes("runManagedAgent") ||
          source.includes("#subagents/runtime")
        );
      });

    expect(owners).toEqual(["subagents.ts"]);
  });

  it("maps every completion owner to the established read-only or mutable admission", async () => {
    const spawn = vi.fn(async () => "worker");
    const roles: ImplementRoles = {
      planner: {
        type: "pipkin:implement:planner",
        model: "test/planner",
        thinking: "high",
      },
      reviewer: {
        type: "pipkin:implement:reviewer",
        model: "test/reviewer",
        thinking: "high",
      },
      implementer: {
        type: "pipkin:implement:implementer",
        model: "test/implementer",
        thinking: "medium",
      },
    };
    const completionKinds = Object.entries(completionContracts) as Array<
      [
        keyof typeof completionContracts,
        (typeof completionContracts)[keyof typeof completionContracts],
      ]
    >;

    for (const [completionKind, completion] of completionKinds) {
      const { role, readOnly } = completion;
      await spawnValidatedWorker({
        packet: {
          completionKind,
          identity: completionKind,
          workspace: { path: "/worktree" },
        },
        subagents: { spawn } as never,
        roles,
        taskId: "task",
        description: completionKind,
        render: () => "Complete the assignment.",
      });
      expect(spawn).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: `pipkin:implement:${role}`,
          role,
          ...(readOnly ? { readOnly: true } : {}),
          sandboxWriteMode: readOnly
            ? "repository-read-only"
            : "workspace-write",
          completion: {
            description: completion.description,
            schema: completion.schema,
          },
          prompt: expect.stringContaining(MANAGED_COMPLETION_FINAL_ACTION),
        }),
      );
    }
    expect(spawn).toHaveBeenCalledTimes(completionKinds.length);
    for (const [index, call] of (
      spawn.mock.calls as unknown as Array<[{ prompt: string }]>
    ).entries()) {
      const [{ prompt }] = call;
      expect(
        prompt.match(/pi_managed_complete exactly once as your final action/g),
      ).toHaveLength(1);
      expect(prompt).toContain(
        "required structured result for this completion kind",
      );
      expect(prompt).toContain("sole allowed personal-metadata write");
      if (completionKinds[index]?.[1].readOnly) {
        expect(prompt).toContain(REPOSITORY_PRESERVING_ROLE_CONTRACT);
      } else {
        expect(prompt).not.toContain(REPOSITORY_PRESERVING_ROLE_CONTRACT);
      }
    }
  });

  it("assembles production role prompts with one shared completion protocol", async () => {
    const spawn = vi.fn(async () => "worker");
    const roles: ImplementRoles = {
      planner: {
        type: "pipkin:implement:planner",
        model: "test/planner",
        thinking: "high",
      },
      reviewer: {
        type: "pipkin:implement:reviewer",
        model: "test/reviewer",
        thinking: "high",
      },
      implementer: {
        type: "pipkin:implement:implementer",
        model: "test/implementer",
        thinking: "medium",
      },
    };
    const workspace = { path: "/worktree", mutationBoundary: "boundary" };
    const candidate = {
      id: "candidate",
      workstream: { kind: "source", id: "work" },
      baseSha: "base",
      commitSha: "head",
      treeSha: "tree",
    };
    const cases = [
      {
        kind: "planner",
        packet: {
          role: "planner",
          completionKind: "planner",
          identity: "planner",
          workspace,
        },
        render: () =>
          buildStrictExecutionPlannerPrompt({
            workspace,
            planContent: "plan",
            unchecked: [],
            corpus: [],
            baseSha: "base",
            workerConcurrency: 1,
          } as never),
        sentinel: "Create exactly one task contract",
      },
      {
        kind: "implementer",
        packet: {
          role: "implementer",
          completionKind: "implementer",
          identity: "implementer",
          workspace,
        },
        render: () =>
          buildWorkstreamImplementerPrompt({
            workspace,
            tasks: [],
            sourceMaterial: [],
            priorCheckpoints: {},
            baseSha: "base",
          } as never),
        sentinel: "Implement every ordered task contract",
      },
      {
        kind: "initial-review",
        packet: {
          role: "reviewer",
          completionKind: "initial-review",
          identity: "initial-review",
          workspace,
        },
        render: () =>
          buildInitialWorkstreamReviewPrompt({
            workspace,
            candidate,
            contracts: [],
            sourceMaterial: [],
            corpus: [],
            schedule: { tasks: [], workstreams: [] },
            checkpoints: {},
            satisfiedEvidence: {},
            outstandingFindings: [],
            completionKind: "initial-review",
          } as never),
        sentinel: "Review in two passes",
      },
      {
        kind: "initial-anchored-review",
        packet: {
          role: "reviewer",
          completionKind: "initial-anchored-review",
          identity: "initial-anchored-review",
          workspace,
        },
        render: () =>
          buildAnchoredWorkstreamReviewPrompt({
            workspace,
            candidate,
            previousCandidate: candidate,
            comparisonBase: "base",
            latestCorrection: {
              rangeBaseSha: "base",
              rangeHeadSha: "head",
              changedPaths: [],
              evidence: "evidence",
              mode: "changed",
            },
            contracts: [],
            sourceMaterial: [],
            corpus: [],
            schedule: { tasks: [], workstreams: [] },
            checkpoints: {},
            satisfiedEvidence: {},
            outstandingFindings: [],
          } as never),
        sentinel: "Findings requiring assessment in this review",
      },
      {
        kind: "anchored-review",
        packet: {
          role: "reviewer",
          completionKind: "anchored-review",
          identity: "anchored-review",
          workspace,
        },
        render: () =>
          buildAnchoredWorkstreamReviewPrompt({
            workspace,
            candidate,
            previousCandidate: candidate,
            comparisonBase: "base",
            latestCorrection: {
              rangeBaseSha: "base",
              rangeHeadSha: "head",
              changedPaths: [],
              evidence: "evidence",
              mode: "changed",
            },
            contracts: [],
            sourceMaterial: [],
            corpus: [],
            schedule: { tasks: [], workstreams: [] },
            checkpoints: {},
            satisfiedEvidence: {},
            outstandingFindings: [],
          } as never),
        sentinel: "Findings requiring assessment in this review",
      },
      {
        kind: "initial-overall-review",
        packet: {
          role: "reviewer",
          completionKind: "initial-overall-review",
          identity: "initial-overall-review",
          workspace,
        },
        render: (packet: { workspace: { path: string } }) =>
          buildInitialOverallReviewPrompt({
            planContext: "plan",
            candidateContext: "candidate",
            baseSha: "base",
            currentSha: "head",
            worktreePath: packet.workspace.path,
          }),
        sentinel: "Finalize the complete findings array",
      },
      {
        kind: "initial-anchored-overall-review",
        packet: {
          role: "reviewer",
          completionKind: "initial-anchored-overall-review",
          identity: "initial-anchored-overall-review",
          workspace,
        },
        render: (packet: { workspace: { path: string } }) =>
          buildAnchoredOverallReviewPrompt({
            planContext: "plan",
            candidateContext: "candidate",
            baseSha: "base",
            outstandingFindings: [],
            previousCandidate: "previous",
            currentCandidate: "head",
            latestHandoffDraft: "handoff",
            worktreePath: packet.workspace.path,
          }),
        sentinel: "Preserve unaffected facts",
      },
      {
        kind: "anchored-overall-review",
        packet: {
          role: "reviewer",
          completionKind: "anchored-overall-review",
          identity: "anchored-overall-review",
          workspace,
        },
        render: (packet: { workspace: { path: string } }) =>
          buildAnchoredOverallReviewPrompt({
            planContext: "plan",
            candidateContext: "candidate",
            baseSha: "base",
            outstandingFindings: [],
            previousCandidate: "previous",
            currentCandidate: "head",
            latestHandoffDraft: "handoff",
            worktreePath: packet.workspace.path,
          }),
        sentinel: "Preserve unaffected facts",
      },
      {
        kind: "overall-rework",
        packet: {
          role: "implementer",
          completionKind: "overall-rework",
          identity: "overall-rework",
          workspace,
        },
        render: () =>
          buildOverallReworkPrompt({
            workspace,
            runId: "run",
            runBaseSha: "base",
            baseline: candidate,
            requirements: {
              contracts: [],
              corpus: [],
              schedule: { tasks: [], workstreams: [] },
            },
            findings: [],
          } as never),
        sentinel: "Address only the supplied whole-plan review findings",
      },
      {
        kind: "reconciliation",
        packet: {
          role: "implementer",
          completionKind: "reconciliation",
          identity: "reconciliation",
          workspace,
        },
        render: () =>
          buildReconciliationPrompt({
            workspace,
            candidate,
            failedTarget: { commitSha: "target", treeSha: "tree" },
            priorIntegrationBase: "base",
            replay: {
              disposition: "overlap",
              candidatePaths: [],
              targetPaths: [],
              relevantPaths: [],
              evidence: "evidence",
            },
            priorEvidence: [],
            semanticAttempt: "initial",
          } as never),
        sentinel: "semantic reconciliation worker",
      },
      {
        kind: "revision",
        packet: {
          role: "implementer",
          completionKind: "revision",
          identity: "revision",
          workspace,
        },
        render: () =>
          buildRevisionPrompt({
            workspace,
            candidate,
            comparisonBase: "base",
            findingEpoch: 1,
            pendingCorrectionIds: [],
            authority: { kind: "review_findings" },
            findings: [],
            evidence: [],
            requirements: {
              contracts: [],
              corpus: [],
              schedule: { tasks: [], workstreams: [] },
            },
          } as never),
        sentinel: "revision worker",
      },
    ] as const;

    for (const testCase of cases) {
      await spawnValidatedWorker({
        packet: testCase.packet as never,
        subagents: { spawn } as never,
        roles,
        taskId: testCase.kind,
        description: testCase.kind,
        render: testCase.render as never,
      });
      const [{ prompt, completion, readOnly }] = (
        spawn.mock.calls as unknown as Array<
          [
            {
              prompt: string;
              completion: unknown;
              readOnly?: boolean;
            },
          ]
        >
      ).at(-1)!;
      expect(prompt).toContain(testCase.sentinel);
      expect(
        prompt.match(new RegExp(MANAGED_COMPLETION_FINAL_ACTION, "g")),
      ).toHaveLength(1);
      expect(completion).toEqual({
        description: completionContracts[testCase.kind].description,
        schema: completionContracts[testCase.kind].schema,
      });
      expect(Boolean(readOnly)).toBe(
        completionContracts[testCase.kind].readOnly,
      );
      expect(prompt.includes(REPOSITORY_PRESERVING_ROLE_CONTRACT)).toBe(
        completionContracts[testCase.kind].readOnly,
      );
    }
  });
});
