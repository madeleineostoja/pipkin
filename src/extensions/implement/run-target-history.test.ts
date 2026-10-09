import { describe, expect, it } from "vitest";
import { expectedTargetHead } from "./run.js";
import type { RunState } from "./store.js";

type TargetState = Pick<
  RunState,
  "publication" | "executionTarget" | "generationHistory"
>;

describe("expected target history", () => {
  it("uses a newer publication receipt after an older supersession", () => {
    const state = targetState();
    state.publication.intents["intent-1"] = intent("intent-1", "target-a");
    state.publication.supersessions["intent-1"] = {
      intentId: "intent-1",
      publicationOperationId: "publication-1",
      preparationOperationId: "preparation-1",
      workstream: { kind: "source", id: "first-stream" },
      candidateId: "candidate-1",
      preparationId: "preparation-1",
      targetRef: "refs/heads/main",
      expectedTargetSha: "target-a",
      actualTargetSha: "target-b",
      supersededAt: "2026-01-01T00:00:01.000Z",
    };
    state.publication.intents["intent-2"] = intent("intent-2", "target-b");
    state.publication.receipts["intent-2"] = {
      operationId: "publication-2",
      intentId: "intent-2",
      candidateId: "candidate-1",
      targetBaseSha: "target-b",
      publishedCommitSha: "target-c",
      publishedTreeSha: "tree-c",
      targetRef: "refs/heads/main",
      protectedArtifactHashes: {},
      publishedAt: "2026-01-01T00:00:02.000Z",
    };

    expect(expectedTargetHead(state)).toBe("target-c");
  });

  it("ignores historical externally based abandonments after activation", () => {
    const state = targetState();
    const historical = intent("historical", "manual-descendant");
    state.publication.intents[historical.id] = historical;
    state.publication.abandonments[historical.id] = {
      intentId: historical.id,
      publicationOperationId: "publication:historical",
      preparationOperationId: historical.operationId,
      workstream: historical.workstream,
      candidateId: historical.candidateId,
      preparationId: historical.preparationId,
      targetRef: historical.targetRef,
      targetBaseSha: historical.targetBaseSha,
      evidence: "Abandoned unpublished execution",
      abandonedAt: "2026-01-01T00:00:01.000Z",
    };
    state.generationHistory = [
      {
        operationIds: [historical.operationId],
      } as RunState["generationHistory"][number],
    ];

    expect(expectedTargetHead(state)).toBe(state.executionTarget);
    state.publication.intents["current"] = intent("current", "current-target");
    expect(expectedTargetHead(state)).toBe("current-target");
  });

  it("uses the target captured by the current unresolved intent", () => {
    const state = targetState();
    state.publication.intents["intent-1"] = intent("intent-1", "target-a");
    state.publication.receipts["intent-1"] = {
      operationId: "publication-1",
      intentId: "intent-1",
      candidateId: "candidate-1",
      targetBaseSha: "target-a",
      publishedCommitSha: "target-b",
      publishedTreeSha: "tree-b",
      targetRef: "refs/heads/main",
      protectedArtifactHashes: {},
      publishedAt: "2026-01-01T00:00:01.000Z",
    };
    state.publication.intents["intent-2"] = intent("intent-2", "target-c");

    expect(expectedTargetHead(state)).toBe("target-c");
  });
});

function targetState(): TargetState {
  return {
    executionTarget: "target-a",
    generationHistory: [],
    publication: {
      preparations: {},
      intents: {},
      receipts: {},
      supersessions: {},
      abandonments: {},
    },
  };
}

function intent(
  id: string,
  targetBaseSha: string,
): RunState["publication"]["intents"][string] {
  return {
    id,
    operationId: `preparation:${id}`,
    workstream: { kind: "source", id: "first-stream" },
    candidateId: "candidate-1",
    preparationId: `preparation:${id}`,
    targetBaseSha,
    preparedCommitSha: `prepared:${id}`,
    preparedTreeSha: `tree:${id}`,
    targetRef: "refs/heads/main",
    protectedArtifactSnapshots: {},
    protectedArtifactHashes: {},
  };
}
