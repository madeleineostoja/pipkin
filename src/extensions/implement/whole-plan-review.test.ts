import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAnchoredOverallReviewPrompt } from "./prompts.js";
import {
  buildWholePlanReviewPacket,
  completeWholePlanRun,
  runWholePlanReview,
} from "./whole-plan-review.js";
import {
  cleanupSchedulerStores,
  createUnboundSchedulerRun,
} from "./scheduler/scheduler-test-support.js";
import { ScriptedSubagentClient } from "./e2e-test-support.js";
import { WorkerPacketError } from "./worker-invocation.js";
import type { ImplementRoles } from "./subagents.js";

afterEach(() => cleanupSchedulerStores());

const roles: ImplementRoles = {
  implementer: {
    type: "pipkin:implement:implementer",
    model: "test",
    thinking: "medium",
  },
  reviewer: {
    type: "pipkin:implement:reviewer",
    model: "test",
    thinking: "high",
  },
  planner: {
    type: "pipkin:implement:planner",
    model: "test",
    thinking: "high",
  },
};

describe("whole-plan review packet", () => {
  it("rejects closure when an approved review omits or blanks its draft", async () => {
    for (const handoffDraft of [undefined, "   "]) {
      const { run } = createUnboundSchedulerRun();
      const state = run.read();
      state.wholePlanReview = {
        status: "approved",
        evidence: "whole-plan evidence",
        ...(handoffDraft === undefined ? {} : { handoffDraft }),
        reviewedTargetSha: "target-sha",
        reviewedTargetTreeSha: "target-tree",
      };

      await expect(
        completeWholePlanRun({
          state,
          git: {} as never,
          dispatch: async () => undefined,
        }),
      ).rejects.toThrow(
        "Whole-plan closure cannot prove the reviewed target boundary.",
      );
    }
  });

  it("retains a malformed anchored completion before whole-plan dispatch", async () => {
    const { run, plan } = createUnboundSchedulerRun();
    await run.bindExecutionPlan(plan);
    const state = run.read();
    for (const workstream of Object.values(state.workstreams.source)) {
      workstream.phase = "completed";
    }
    const workstream = { kind: "overall" as const, repairId: "repair-1" };
    const candidateId = "overall-repair:repair-1";
    const findingId = "overall-repair-1";
    state.candidates[candidateId] = {
      id: candidateId,
      workstream,
      baseSha: "target-sha",
      commitSha: "repair-sha",
      treeSha: "repair-tree",
    };
    state.findings[findingId] = {
      id: findingId,
      candidateId,
      workstream,
      scope: {
        kind: "whole_plan",
        initialTargetSha: "target-sha",
        initialTargetTreeSha: "target-tree",
      },
      origin: "initial",
      introducedRound: 0,
      status: "open",
      summary: "A material repair finding",
      evidence: "Observed in the repaired target.",
      requiredChange: "Correct the behavior.",
      acceptanceCriteria: ["Behavior is correct."],
    };
    state.wholePlanReview = {
      status: "pending",
      handoffDraft: "Prior handoff.",
      epoch: {
        initialTargetSha: "target-sha",
        initialTargetTreeSha: "target-tree",
        findingIds: [findingId],
        pendingCorrectionIds: [findingId],
        latestRepair: {
          candidateId,
          targetBaseSha: "target-sha",
          publishedCommitSha: "repair-sha",
          publishedTreeSha: "repair-tree",
          changedPaths: ["src/repair.ts"],
        },
      },
    };
    const artifactsPath = `${state.run.checkout.root}/artifacts`;
    const dispatch = vi.fn();
    const error = await runWholePlanReview({
      state,
      plan,
      git: {
        isCleanExcept: async () => true,
        hasStagedChangesInPaths: async () => false,
        activeOperation: async () => undefined,
        head: async () => "repair-sha",
        treeAt: async () => "repair-tree",
      } as never,
      subagents: new ScriptedSubagentClient(
        [
          {
            status: "completed",
            result: {
              assessments: [],
              regressions: [],
              handoffDraft: "Replacement handoff.",
            },
          },
        ],
        [state.run.checkout.root],
      ),
      artifactsPath,
      dispatch,
      roles,
    }).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(WorkerPacketError);
    expect(error).toHaveProperty(
      "message",
      expect.stringContaining(`Review artifact: ${artifactsPath}/`),
    );
    const artifacts = readdirSync(artifactsPath);
    expect(artifacts).toHaveLength(1);
    const artifactPath = join(artifactsPath, artifacts[0]!);
    expect(existsSync(artifactPath)).toBe(true);
    expect(JSON.parse(readFileSync(artifactPath, "utf8"))).toMatchObject({
      completion: { assessments: [], regressions: [] },
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("includes cumulative delivered repair checks across generations but not abandoned repair evidence", async () => {
    const { run: store, plan } = createUnboundSchedulerRun();
    await store.bindExecutionPlan(plan);
    const state = store.read();
    const repairId = "repair-1";
    const candidateId = "overall-repair:repair-1";
    state.candidates[candidateId] = {
      id: candidateId,
      workstream: { kind: "overall", repairId },
      baseSha: "target-sha",
      commitSha: "repair-sha",
      treeSha: "repair-tree",
      changedPaths: ["src/extensions/implement/whole-plan-review.ts"],
      evidenceStatus: "reported",
      implementationEvidence: {
        summary: "Preserved the reviewer-authored handoff draft.",
        verification: [
          { kind: "inspection", label: "Check", evidence: "npm run check" },
        ],
        uncertainty: "No end-to-end session was available.",
        changedPaths: ["src/extensions/implement/whole-plan-review.ts"],
      },
    };
    state.publication.receipts["publication:repair-1"] = {
      operationId: "publication:repair-1",
      intentId: "publication:repair-1",
      candidateId,
      targetBaseSha: "target-sha",
      publishedCommitSha: "repair-sha",
      publishedTreeSha: "repair-tree",
      targetRef: "refs/heads/main",
      protectedArtifactHashes: state.protectedArtifactHashes,
      publishedAt: "2026-01-01T00:00:00.000Z",
    };
    state.wholePlanReview = {
      status: "pending",
      handoffDraft: "Prior accepted reviewer handoff.",
      epoch: {
        initialTargetSha: "target-sha",
        initialTargetTreeSha: "target-tree",
        findingIds: [],
        pendingCorrectionIds: [],
        latestRepair: {
          candidateId,
          targetBaseSha: "target-sha",
          publishedCommitSha: "repair-sha",
          publishedTreeSha: "repair-tree",
          changedPaths: ["src/extensions/implement/whole-plan-review.ts"],
        },
      },
    };
    const earlierId = "overall-repair:earlier-generation";
    const time = "2026-01-01T00:00:00.000Z";
    state.candidates[earlierId] = {
      ...state.candidates[candidateId]!,
      id: earlierId,
      workstream: { kind: "overall", repairId: "earlier-repair" },
      commitSha: "earlier-repair-sha",
      treeSha: "earlier-repair-tree",
      implementationEvidence: {
        summary: "Earlier delivered repair decisions",
        verification: [
          ...(["passed", "failed"] as const).map((outcome) => ({
            kind: "execution" as const,
            label: `Earlier repair ${outcome} check`,
            artifactPath: `artifacts/verification/${"a".repeat(64)}.json`,
            outcome,
            execution: {
              state:
                outcome === "passed"
                  ? ("completed" as const)
                  : ("failed" as const),
              exitCode: outcome === "passed" ? 0 : 1,
              startedAt: time,
              endedAt: time,
            },
            sourceTool: "bash",
            commandTruncated: false,
            truncated: false,
            outputComplete: true,
            droppedBytes: 0,
            attemptId: "earlier-attempt",
            workerId: "earlier-worker",
            candidateCommitSha: "earlier-repair-sha",
            candidateCoverage: "not_attested" as const,
            capturedAt: time,
          })),
          {
            kind: "not_run",
            label: "Earlier repair unverified check",
            reason: "Required service unavailable",
          },
        ],
      },
    };
    state.publication.receipts["publication:earlier-repair"] = {
      ...state.publication.receipts["publication:repair-1"]!,
      intentId: "publication:earlier-repair",
      operationId: "earlier-publication",
      candidateId: earlierId,
      publishedCommitSha: "earlier-repair-sha",
      publishedTreeSha: "earlier-repair-tree",
    };
    state.candidates["abandoned-repair"] = {
      ...state.candidates[candidateId]!,
      id: "abandoned-repair",
      implementationEvidence: {
        summary: "Discarded unpublished repair decisions",
        verification: [
          {
            kind: "inspection",
            label: "Abandoned repair check",
            evidence: "Not delivered",
          },
        ],
      },
    };
    const sourceLane = Object.values(state.workstreams.source)[0]!;
    sourceLane.candidateId = "delivered-source";
    sourceLane.phase = "completed";
    state.candidates["delivered-source"] = {
      ...state.candidates[candidateId]!,
      id: "delivered-source",
      workstream: { kind: "source", id: sourceLane.id },
      implementationEvidence: {
        summary: "Delivered source decisions",
        verification: [
          {
            kind: "inspection",
            label: "Source behavior",
            evidence: "Delivered source verification",
          },
        ],
      },
    };
    state.publication.receipts["source-publication"] = {
      ...state.publication.receipts["publication:repair-1"]!,
      intentId: "source-publication",
      operationId: "source-publication",
      candidateId: "delivered-source",
    };
    state.generation = 2;
    const packet = buildWholePlanReviewPacket({
      state,
      plan,
      currentTargetSha: "repair-sha",
      currentTargetTreeSha: "repair-tree",
      previousSha: "target-sha",
      completionKind: "anchored-overall-review",
      outstandingFindings: [],
    });
    const prompt = buildAnchoredOverallReviewPrompt({
      planContext: packet.planContext,
      candidateContext: packet.candidateContext,
      baseSha: packet.baseSha,
      outstandingFindings: [],
      completeFindings: [],
      previousCandidate: packet.previousSha!,
      currentCandidate: packet.target.commitSha,
      latestHandoffDraft: packet.priorHandoffDraft!,
    });

    expect(packet.candidateContext).toContain(
      "Cumulative delivered whole-plan repair evidence",
    );
    expect(packet.candidateContext).toContain(candidateId);
    expect(packet.candidateContext).toContain("repair-tree");
    expect(packet.candidateContext).toContain("npm run check");
    expect(packet.candidateContext).toContain(
      "No end-to-end session was available.",
    );
    expect(packet.candidateContext).toContain("publication:repair-1");
    expect(prompt).toContain("Cumulative delivered whole-plan repair evidence");
    expect(packet.candidateContext).toContain(
      "Earlier delivered repair decisions",
    );
    expect(packet.candidateContext).toContain("Earlier repair passed check");
    expect(packet.candidateContext).toContain('"outcome": "passed"');
    expect(packet.candidateContext).toContain("Earlier repair failed check");
    expect(packet.candidateContext).toContain('"outcome": "failed"');
    expect(packet.candidateContext).toContain(
      "Earlier repair unverified check",
    );
    expect(packet.candidateContext).toContain("Required service unavailable");
    expect(packet.candidateContext).toContain("publication:earlier-repair");
    expect(packet.candidateContext).toContain("Delivered source verification");
    expect(packet.candidateContext).toContain("source-publication");
    expect(packet.candidateContext).not.toContain(
      "Discarded unpublished repair decisions",
    );
    expect(packet.candidateContext).not.toContain("Abandoned repair check");
    for (const task of plan.tasks) {
      expect(packet.planContext).toContain(task.id);
    }
    expect(prompt).toContain("Prior accepted reviewer handoff.");
  });
});
