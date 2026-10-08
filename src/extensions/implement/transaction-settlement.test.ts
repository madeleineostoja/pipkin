import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitClient } from "./git.js";
import type { RunStore } from "./store.js";
import { settlePublicationTransactions } from "./transaction-settlement.js";
import { WriteAheadPublisher } from "./write-ahead-publication.js";
import {
  cleanupSchedulerStores,
  createSchedulerStore,
} from "./scheduler/scheduler-test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
  cleanupSchedulerStores();
});

describe("retained publication settlement", () => {
  it("does not replay delivered historical repairs at a newer target or during preparation", async () => {
    const run = await createSchedulerStore();
    const state = run.read();
    const workstream = { kind: "overall" as const, repairId: "repair-g0" };
    const intentId = "publication-g0";
    const candidateId = "repair-candidate-g0";
    state.publication.intents[intentId] = {
      id: intentId,
      operationId: "preparation-g0",
      preparationId: "preparation-g0",
      workstream,
      candidateId,
      targetRef: "refs/heads/main",
      targetBaseSha: "base-sha",
      preparedCommitSha: "repair-sha",
      preparedTreeSha: "repair-tree",
      protectedArtifactHashes: state.protectedArtifactHashes,
      protectedArtifactSnapshots: {},
    };
    state.publication.receipts[intentId] = {
      operationId: "publication-g0",
      intentId,
      candidateId,
      targetBaseSha: "base-sha",
      publishedCommitSha: "repair-sha",
      publishedTreeSha: "repair-tree",
      targetRef: "refs/heads/main",
      protectedArtifactHashes: state.protectedArtifactHashes,
      publishedAt: "2026-01-01T00:00:00.000Z",
    };
    state.generationHistory.push({
      generation: 0,
      executionTarget: state.executionTarget,
      phase: "failed",
      workstreams: {
        source: state.workstreams.source,
        overall: {
          [workstream.repairId]: {
            ...workstream,
            phase: "completed",
            candidateId,
          },
        },
      },
      tasks: state.tasks,
      operationIds: [],
      failureIds: [],
      candidateIds: [candidateId],
      reviews: {},
      revisionAssignments: {},
      operationalRetries: {},
      workspaceRecreations: {},
      reconciliationAssignments: {},
      wholePlanReview: state.wholePlanReview,
    });
    state.generation = 1;
    state.executionTarget = "newer-published-target";
    const settleRestartPublishedLane = vi.fn();
    const store = {
      read: () => structuredClone(state),
      settleRestartPublishedLane,
    } as unknown as RunStore;
    const recover = vi
      .spyOn(WriteAheadPublisher.prototype, "recover")
      .mockRejectedValue(
        new Error("Historical target is neither transaction side"),
      );
    const receipts = structuredClone(state.publication.receipts);
    await settlePublicationTransactions({ store, git: {} as GitClient });
    state.restartPreparation = {
      generation: 2,
      targetSha: "repair-sha",
      targetTreeSha: "repair-tree",
      branchRef: "refs/heads/main",
      preservedSourceIds: [],
      resetSourceIds: Object.keys(state.workstreams.source),
      transactionIntentIds: [],
      resources: [],
      progress: {
        transactionsSettled: false,
        projectionSettled: false,
        targetValidated: false,
      },
      blockers: [],
      preparedAt: "2026-01-01T00:00:00.000Z",
    };
    await settlePublicationTransactions({ store, git: {} as GitClient });
    expect(recover).not.toHaveBeenCalled();
    expect(settleRestartPublishedLane).not.toHaveBeenCalled();
    expect(store.read().publication.receipts).toEqual(receipts);
  });
});
