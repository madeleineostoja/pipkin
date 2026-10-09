import { readFileSync } from "node:fs";
import {
  publicationIntentId,
  publicationPreparationId,
  stagingIdentity,
} from "./candidate-replay.js";
import { sha256 } from "./source-integrity.js";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TargetPreconditionError } from "./workstream-candidate.js";
import {
  settleProjectionTransactions,
  settlePublicationTransactions,
} from "./transaction-settlement.js";
import { WriteAheadPublisher } from "./write-ahead-publication.js";
import { projectRunSurface, runMarkdown } from "./run-surface.js";
import { expectedTargetHead } from "./run.js";
import { WorkerPacketError } from "./worker-invocation.js";
import type { GitClient } from "./git.js";
import { preflightRestart } from "./restart.js";
import { RunStore, type RunState } from "./store.js";
import {
  reduceRunEvent,
  selectReadyWorkstreams,
  type SchedulerEvent,
} from "./scheduler/scheduler.js";
import { SchedulerActor } from "./scheduler/scheduler-actor.js";
import {
  cleanupSchedulerStores,
  createSchedulerStore,
  createUnboundSchedulerRun,
} from "./scheduler/scheduler-test-support.js";
import { readExecutionPlan } from "./execution-plan.js";
import {
  buildWorkstreamPacket,
  workstreamWorkspace,
} from "./workstream-candidate.js";
import { buildReviewPacket, buildSourceReviewWorkerPacket } from "./review.js";
import {
  buildWholePlanReviewPacket,
  runWholePlanReview,
} from "./whole-plan-review.js";
import { ScriptedSubagentClient } from "./e2e-test-support.js";
import type { ImplementRoles } from "./subagents.js";

afterEach(() => {
  vi.restoreAllMocks();
  cleanupSchedulerStores();
});
const now = "2026-01-01T00:00:00.000Z";
const first = { kind: "source" as const, id: "first-stream" };
const second = { kind: "source" as const, id: "second-stream" };
const finding = {
  summary: "Missing behavior",
  evidence: "The source omits a required behavior.",
  requiredChange: "Implement the behavior.",
  acceptanceCriteria: ["The required behavior works."],
};
const roles = Object.fromEntries(
  ["implementer", "reviewer", "planner"].map((role) => [
    role,
    { type: `pipkin:implement:${role}`, model: "test", thinking: "high" },
  ]),
) as ImplementRoles;

function targetGit(state: RunState, target = state.executionTarget): GitClient {
  return {
    root: async () => state.run.checkout.root,
    checkoutIdentity: async () => state.run.checkout.gitDir,
    currentBranch: async () => "main",
    head: async () => target,
    treeAt: async () => "target-tree",
    parent: async () =>
      state.publication.intents[Object.keys(state.publication.intents).at(-1)!]
        ?.targetBaseSha ?? state.executionTarget,
    isCleanExcept: async () => true,
    isCleanAt: async () => true,
    isAncestor: async () => true,
    hasStagedChangesInPaths: async () => false,
    activeOperation: async () => undefined,
  } as unknown as GitClient;
}

async function apply(store: RunStore, event: SchedulerEvent) {
  const state = store.read();
  const transition = reduceRunEvent(state, {
    generation: state.generation,
    ...event,
  });
  expect(transition.accepted, transition.error).toBe(true);
  await store.update(state.revision, () => transition.state);
  return transition.effects;
}

async function restart(store: RunStore) {
  const proof = await preflightRestart(store, targetGit(store.read()));
  await store.prepareRestart(proof, []);
  const pending = store.read().restartPreparation;
  if (!pending) {
    return store.activateRestart(
      await preflightRestart(store, targetGit(store.read())),
    );
  }
  await store.recordRestartProgress(store.read().revision, {
    ...pending,
    progress: {
      transactionsSettled: true,
      projectionSettled: true,
      targetValidated: true,
    },
  });
  return store.activateRestart(
    await preflightRestart(store, targetGit(store.read())),
  );
}

async function deliverSatisfied(store: RunStore, id: string, taskId: string) {
  const workstream = { kind: "source" as const, id };
  const [implementation] = await apply(store, {
    kind: "workstreams_selected",
    now,
    baseShas: { [id]: "base-sha" },
  });
  if (implementation?.kind !== "run_implementation") {
    throw new Error("No implementation");
  }
  const candidateId = `satisfied:${id}`;
  await apply(store, {
    kind: "implementation_completed",
    workstream,
    leaseId: implementation.leaseId,
    outcome: {
      kind: "satisfaction_claimed",
      candidate: {
        id: candidateId,
        workstream,
        baseSha: "base-sha",
        commitSha: "base-sha",
        treeSha: "base-tree",
      },
      evidence: { [taskId]: "The target satisfies this contract." },
    },
  });
  const [review] = await apply(store, {
    kind: "review_requested",
    workstream,
    now,
  });
  if (review?.kind !== "run_review") {
    throw new Error("No review");
  }
  await apply(store, {
    kind: "review_completed",
    workstream,
    leaseId: review.leaseId,
    outcome: {
      kind: "initial",
      candidateId,
      completion: { findings: [] },
      evidence: "Durable independent satisfaction review",
    },
  });
  const [reconciliation] = await apply(store, {
    kind: "reconciliation_requested",
    workstream,
    now,
  });
  if (reconciliation?.kind !== "run_reconciliation") {
    throw new Error("No reconciliation");
  }
  await apply(store, {
    kind: "satisfaction_completed",
    workstream,
    leaseId: reconciliation.leaseId,
    targetSha: "base-sha",
    evidence: "Exact reviewed target receipt",
  });
}

async function stop(store: RunStore) {
  await apply(store, {
    kind: "failure_requested",
    category: "interrupted",
    reason: "Execution interrupted",
    now,
  });
  for (const lease of Object.values(store.read().processLeases)) {
    await apply(store, { kind: "process_abandoned", leaseId: lease.id });
  }
  await apply(store, { kind: "run_failed" });
}

async function preparedPublication(store: RunStore, baseSha = "base-sha") {
  const candidate = {
    id: "publish-candidate",
    workstream: first,
    baseSha,
    commitSha: "candidate-sha",
    treeSha: "target-tree",
  };
  const [implementation] = await apply(store, {
    kind: "workstreams_selected",
    now,
    baseShas: { [first.id]: candidate.baseSha },
  });
  if (implementation?.kind !== "run_implementation") {
    throw new Error("No implementation");
  }
  await apply(store, {
    kind: "implementation_completed",
    workstream: first,
    leaseId: implementation.leaseId,
    outcome: {
      kind: "candidate_ready",
      candidate,
      checkpoints: { first: candidate.commitSha },
      satisfied: {},
    },
  });
  const [review] = await apply(store, {
    kind: "review_requested",
    workstream: first,
    now,
  });
  if (review?.kind !== "run_review") {
    throw new Error("No review");
  }
  await apply(store, {
    kind: "review_completed",
    workstream: first,
    leaseId: review.leaseId,
    outcome: {
      kind: "initial",
      candidateId: candidate.id,
      completion: {
        findings: [],
        publicationCommitSubject: "feat: published source",
      },
      evidence: "Independent candidate review",
    },
  });
  const [reconciliation] = await apply(store, {
    kind: "reconciliation_requested",
    workstream: first,
    now,
  });
  if (reconciliation?.kind !== "run_reconciliation") {
    throw new Error("No reconciliation");
  }
  const state = store.read();
  const staging = stagingIdentity({
    runId: state.run.id,
    operationId: reconciliation.leaseId,
    candidateId: candidate.id,
    candidateCommitSha: candidate.commitSha,
    candidateTreeSha: candidate.treeSha,
    targetBaseSha: candidate.baseSha,
    targetRef: state.run.checkout.branchRef,
  });
  const preparation = {
    id: "pending",
    operationId: reconciliation.leaseId,
    candidateId: candidate.id,
    candidateCommitSha: candidate.commitSha,
    candidateTreeSha: candidate.treeSha,
    targetBaseSha: candidate.baseSha,
    targetRef: state.run.checkout.branchRef,
    preparedCommitSha: "published-sha",
    preparedTreeSha: "target-tree",
    stagingWorktree: join(
      store.lease.paths.worktrees,
      state.run.id,
      staging.id,
    ),
    stagingBranch: staging.branchName,
    replayPatchHash: sha256("patch"),
    changedPaths: ["app.ts"],
    disposition: "same_base" as const,
    hookEvidence: "Ordinary hooks passed",
    hookCommand: {
      command: "git commit",
      cwd: "staging",
      exitCode: 0,
      timedOut: false,
      output: "hooks passed",
    },
  };
  preparation.id = publicationPreparationId({
    runId: state.run.id,
    preparation,
  });
  const intent = {
    id: publicationIntentId({
      runId: state.run.id,
      operationId: reconciliation.leaseId,
      preparation,
    }),
    operationId: reconciliation.leaseId,
    workstream: first,
    candidateId: candidate.id,
    preparationId: preparation.id,
    targetBaseSha: candidate.baseSha,
    preparedCommitSha: preparation.preparedCommitSha,
    preparedTreeSha: preparation.preparedTreeSha,
    targetRef: state.run.checkout.branchRef,
    protectedArtifactSnapshots: Object.fromEntries(
      Object.keys(state.protectedArtifactHashes).map((path) => [
        path,
        readFileSync(path, "utf-8"),
      ]),
    ),
    protectedArtifactHashes: state.protectedArtifactHashes,
  };
  await apply(store, {
    kind: "publication_preparation_recorded",
    operationId: reconciliation.leaseId,
    preparation,
  });
  await apply(store, {
    kind: "publication_intent_recorded",
    operationId: reconciliation.leaseId,
    intent,
  });
  const [publication] = await apply(store, {
    kind: "reconciliation_completed",
    workstream: first,
    leaseId: reconciliation.leaseId,
    outcome: {
      kind: "prepared",
      evidence: "Exact replay prepared",
      workspace: {
        id: staging.id,
        checkpoint: preparation.preparedCommitSha,
        changedPaths: preparation.changedPaths,
        stateEvidence: "Replay prepared",
        targetSha: candidate.baseSha,
        stagingComparison: {
          baseSha: candidate.baseSha,
          treeSha: preparation.preparedTreeSha,
        },
      },
    },
  });
  if (publication?.kind !== "run_publication") {
    throw new Error("No publication");
  }
  return { intent, preparation, publication };
}

describe("validated generation restart", () => {
  it("persists distinct findings across generation-like workstream IDs without replacing retained provenance", async () => {
    const { run: store, plan } = createUnboundSchedulerRun(2, true, [
      "api-g1",
      "api",
    ]);
    await store.bindExecutionPlan(plan);
    const reviewCandidate = async (id: string) => {
      const workstream = { kind: "source" as const, id };
      const operation = Object.values(store.read().processLeases).find(
        (lease) =>
          lease.kind === "implementation" &&
          lease.workstream?.kind === "source" &&
          lease.workstream.id === id,
      )!;
      const candidateId = `candidate:${id}:g${store.read().generation}`;
      await apply(store, {
        kind: "implementation_completed",
        workstream,
        leaseId: operation.id,
        outcome: {
          kind: "candidate_ready",
          candidate: {
            id: candidateId,
            workstream,
            baseSha: "base-sha",
            commitSha: candidateId,
            treeSha: `${candidateId}-tree`,
          },
          checkpoints: { [id === "api" ? "second" : "first"]: candidateId },
          satisfied: {},
        },
      });
      const [review] = await apply(store, {
        kind: "review_requested",
        workstream,
        now,
      });
      if (review?.kind !== "run_review") {
        throw new Error("No review");
      }
      await apply(store, {
        kind: "review_completed",
        workstream,
        leaseId: review.leaseId,
        outcome: {
          kind: "initial",
          candidateId,
          completion: {
            findings: [finding],
            publicationCommitSubject: "feat: source behavior",
          },
          evidence: `Independent review of ${candidateId}`,
        },
      });
    };
    const select = () =>
      apply(store, {
        kind: "workstreams_selected",
        now,
        baseShas: { "api-g1": "base-sha", api: "base-sha" },
      });
    await select();
    await reviewCandidate("api-g1");
    const original = Object.values(store.read().findings)[0]!;
    await stop(store);
    await restart(store);
    await select();
    await reviewCandidate("api");

    const persisted = RunStore.open(store.lease, store.path).read();
    const introduced = Object.values(persisted.findings).find(
      (entry) =>
        entry.workstream.kind === "source" && entry.workstream.id === "api",
    )!;
    expect(introduced.id).not.toBe(original.id);
    expect(persisted.findings[original.id]).toEqual(original);
    expect(introduced).toMatchObject({
      status: "open",
      candidateId: "candidate:api:g1",
      scope: { kind: "source", id: "api" },
    });
    expect(
      persisted.generationHistory[0]?.reviews["source:api-g1"],
    ).toBeDefined();
  });

  it("requeues exhausted and dependency-skipped lanes once with fresh bounded attempts and rejects stale completions", async () => {
    const store = await createSchedulerStore();
    const oldActor = new SchedulerActor({ store });
    expect(store.read().generation).toBe(0);
    let oldEvent: SchedulerEvent | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const [effect] = await apply(store, {
        kind: "workstreams_selected",
        now,
        baseShas: { "first-stream": "base-sha" },
      });
      if (effect?.kind !== "run_implementation") {
        throw new Error("No implementation");
      }
      oldEvent = {
        kind: "implementation_failed",
        leaseId: effect.leaseId,
        workstream: first,
        category: "provider_failure",
        evidence: "Provider unavailable",
      };
      await apply(store, oldEvent);
    }
    await apply(store, { kind: "run_incomplete" });
    const failed = store.read();
    expect(failed.workstreams.source[second.id]?.phase).toBe(
      "dependency_skipped",
    );
    await expect(
      store.update(failed.revision, (state) => ({
        ...state,
        workstreams: {
          ...state.workstreams,
          source: {
            ...state.workstreams.source,
            [first.id]: {
              ...state.workstreams.source[first.id]!,
              phase: "queued",
            },
          },
        },
      })),
    ).rejects.toThrow("lifecycle invariants");
    await expect(
      store.prepareRestart(
        {
          runId: failed.run.id,
          revision: failed.revision,
          generation: 0,
          targetSha: "base-sha",
          targetTreeSha: "target-tree",
          branchRef: "refs/heads/main",
        },
        [],
      ),
    ).rejects.toThrow("host-validated");
    const proof = await preflightRestart(store, targetGit(failed));
    const resource = {
      id: "unfinished-source",
      kind: "worktree" as const,
      path: join(store.lease.paths.worktrees, failed.run.id, "g0", first.id),
      branch: `pipkin/implement/${failed.run.id}/g0/${first.id}`,
      operationId: "leaseId" in oldEvent! ? oldEvent.leaseId : "",
      ownershipEvidence: "Host-validated workspace ownership",
      status: "pending" as const,
    };
    await expect(
      store.prepareRestart(proof, [{ ...resource, path: "/unowned/source" }]),
    ).rejects.toThrow("run-owned");
    await store.prepareRestart(proof, [resource]);
    const prepared = store.read();
    await expect(
      store.activateRestart(await preflightRestart(store, targetGit(prepared))),
    ).rejects.toThrow("prerequisites");
    expect(
      (
        await store.prepareRestart(
          await preflightRestart(store, targetGit(prepared)),
          [],
        )
      ).restartPreparation,
    ).toEqual(prepared.restartPreparation);
    await store.recordRestartProgress(store.read().revision, {
      ...store.read().restartPreparation!,
      resources: [{ ...resource, status: "retired" }],
    });
    await expect(
      store.recordRestartProgress(store.read().revision, {
        ...store.read().restartPreparation!,
        resources: [resource],
      }),
    ).rejects.toThrow("reverse");
    const resumed = await restart(store);
    expect(resumed.generation).toBe(1);
    expect(resumed.activatedRestart?.resources[0]?.status).toBe("retired");
    expect(resumed.generationHistory[0]?.operationalRetries).toEqual(
      failed.operationalRetries,
    );
    expect(resumed.failures).toEqual(failed.failures);
    expect(resumed.run).toEqual(failed.run);
    expect(resumed.operationalRetries).toEqual({});
    expect(selectReadyWorkstreams(resumed)).toEqual([first.id]);
    expect(resumed.workstreams.source[second.id]?.phase).toBe("queued");
    expect(reduceRunEvent(resumed, oldEvent!).accepted).toBe(false);
    await oldActor.dispatch({
      kind: "failure_requested",
      category: "runtime",
      reason: "Abandoned callback",
      now,
    });
    expect(store.read()).toEqual(resumed);
    expect(
      (
        await store.activateRestart(
          await preflightRestart(store, targetGit(resumed)),
        )
      ).generation,
    ).toBe(1);
    expect(
      (
        await store.prepareRestart(
          await preflightRestart(store, targetGit(resumed)),
          [],
        )
      ).restartPreparation,
    ).toBeUndefined();
    const [fresh] = await apply(store, {
      kind: "workstreams_selected",
      now,
      baseShas: { [first.id]: "base-sha" },
    });
    if (!fresh || !("leaseId" in fresh)) {
      throw new Error("No fresh lease");
    }
    expect(store.read().processLeases[fresh.leaseId]?.attempt).toBe(1);
    expect(fresh.leaseId).toContain(":g1:");
    expect(
      RunStore.open(store.lease, store.path).read().generationHistory,
    ).toEqual(resumed.generationHistory);
    await apply(store, { kind: "process_abandoned", leaseId: fresh.leaseId });
    let launches = 0;
    const actor = new SchedulerActor({
      store,
      now: () => now,
      executeEffect: async ({ effect, dispatch, markExecutionStarted }) => {
        await markExecutionStarted();
        if (effect.kind !== "run_implementation") {
          throw new Error("Unexpected fresh cycle effect");
        }
        launches++;
        expect(store.read().executionStartedAt).toBe(now);
        await dispatch({
          kind: "implementation_failed",
          workstream: effect.workstream,
          leaseId: effect.leaseId,
          category: "provider_failure",
          evidence: "Fresh bounded failure",
        });
      },
    });
    await actor.start();
    await actor.settle();
    expect(launches).toBe(3);
    expect(store.read().phase).toBe("incomplete");
    const next = await store.prepareRestart(
      await preflightRestart(store, targetGit(store.read())),
      [],
    );
    expect(next.restartPreparation?.generation).toBe(2);
    expect(next.generation).toBe(1);
  });

  it("preserves durable satisfaction, discards unpublished approval, and freshly resolves carried source obligations with retained assessments", async () => {
    const store = await createSchedulerStore();
    await deliverSatisfied(store, first.id, "first");
    const [implementation] = await apply(store, {
      kind: "workstreams_selected",
      now,
      baseShas: { [second.id]: "base-sha" },
    });
    if (implementation?.kind !== "run_implementation") {
      throw new Error("No implementation");
    }
    await apply(store, {
      kind: "implementation_completed",
      workstream: second,
      leaseId: implementation.leaseId,
      outcome: {
        kind: "candidate_ready",
        candidate: {
          id: "old-second",
          workstream: second,
          baseSha: "base-sha",
          commitSha: "old-candidate",
          treeSha: "old-tree",
        },
        checkpoints: { second: "old-candidate" },
        satisfied: {},
      },
    });
    const [review] = await apply(store, {
      kind: "review_requested",
      workstream: second,
      now,
    });
    if (review?.kind !== "run_review") {
      throw new Error("No review");
    }
    await apply(store, {
      kind: "review_completed",
      workstream: second,
      leaseId: review.leaseId,
      outcome: {
        kind: "initial",
        candidateId: "old-second",
        completion: {
          findings: [finding],
          publicationCommitSubject: "feat: old source",
        },
        evidence: "Old source review",
      },
    });
    await stop(store);
    const prior = store.read();
    const obligation = Object.values(prior.findings)[0]!;
    const resumed = await restart(store);
    expect(resumed.workstreams.source[first.id]).toEqual(
      prior.workstreams.source[first.id],
    );
    expect(resumed.tasks.first).toEqual(prior.tasks.first);
    expect(resumed.satisfaction.receipts).toEqual(prior.satisfaction.receipts);
    expect(
      reduceRunEvent(resumed, {
        generation: resumed.generation,
        kind: "satisfaction_reassessment_requested",
        workstream: first,
        targetSha: "another-target",
      }).accepted,
    ).toBe(false);
    await expect(
      store.update(resumed.revision, (state) => {
        state.workstreams.source[first.id]!.phase = "queued";
        return state;
      }),
    ).rejects.toThrow("lifecycle invariants");
    expect(resumed.workstreams.source[second.id]?.candidateId).toBeUndefined();
    expect(resumed.reviews[`source:${second.id}`]).toBeUndefined();
    const [fresh] = await apply(store, {
      kind: "workstreams_selected",
      now,
      baseShas: { [second.id]: "base-sha" },
    });
    if (fresh?.kind !== "run_implementation") {
      throw new Error("No fresh implementation");
    }
    const plan = readExecutionPlan(dirname(store.path))!;
    const workspace = workstreamWorkspace(store.read(), second.id);
    const packet = buildWorkstreamPacket({
      state: store.read(),
      plan,
      workstreamId: second.id,
      workspace,
    });
    expect(packet.carriedFindings).toEqual([obligation]);
    expect(packet.priorCheckpoints).toEqual({});
    expect(packet.workspace.path).toContain("/g1/");
    await apply(store, {
      kind: "implementation_completed",
      workstream: second,
      leaseId: fresh.leaseId,
      outcome: {
        kind: "candidate_ready",
        candidate: {
          id: "fresh-second-g1",
          workstream: second,
          baseSha: "base-sha",
          commitSha: "fresh-sha",
          treeSha: "fresh-tree",
        },
        checkpoints: { second: "fresh-sha" },
        satisfied: {},
      },
    });
    const state = store.read();
    const reviewPacket = buildReviewPacket({ state, plan, workstream: second });
    expect(
      buildSourceReviewWorkerPacket({
        state,
        workstream: second,
        workspacePath: workspace.worktreePath,
        packet: reviewPacket,
      }).mode,
    ).toBe("initial");
    expect(reviewPacket.previousCandidate).toBeUndefined();
    const [freshReview] = await apply(store, {
      kind: "review_requested",
      workstream: second,
      now,
    });
    if (freshReview?.kind !== "run_review") {
      throw new Error("No fresh review");
    }
    const completionEvent = {
      kind: "review_completed" as const,
      workstream: second,
      leaseId: freshReview.leaseId,
      outcome: {
        kind: "initial" as const,
        candidateId: "fresh-second-g1",
        completion: {
          findings: [],
          publicationCommitSubject: "feat: fresh source",
        },
        evidence: "Fresh source review",
      },
    };
    expect(reduceRunEvent(store.read(), completionEvent).accepted).toBe(false);
    const assessment = {
      id: obligation.id,
      status: "resolved" as const,
      evidence: "Fresh source implements the obligation.",
    };
    expect(
      reduceRunEvent(store.read(), {
        ...completionEvent,
        outcome: {
          ...completionEvent.outcome,
          completion: {
            ...completionEvent.outcome.completion,
            assessments: [assessment, assessment],
          },
        },
      }).accepted,
    ).toBe(false);
    await apply(store, {
      ...completionEvent,
      outcome: {
        ...completionEvent.outcome,
        completion: {
          ...completionEvent.outcome.completion,
          assessments: [assessment],
          findings: [finding],
        },
      },
    });
    const recurrence = Object.values(store.read().findings).find(
      (entry) => entry.id !== obligation.id,
    )!;
    expect(recurrence).toMatchObject({
      candidateId: "fresh-second-g1",
      status: "open",
      origin: "initial",
    });
    expect(store.read().findings[obligation.id]).toMatchObject({
      candidateId: obligation.candidateId,
      scope: obligation.scope,
      status: "resolved",
      evidence: assessment.evidence,
    });
    expect(
      store
        .read()
        .reviewHistory.some(
          (history) =>
            history.findings[obligation.id]?.evidence === obligation.evidence,
        ),
    ).toBe(true);
    expect(
      store.read().reviews[`source:${second.id}`]?.publicationCommitSubject,
    ).toBe("feat: fresh source");
    const whole = buildWholePlanReviewPacket({
      state: store.read(),
      plan,
      currentTargetSha: "fresh-sha",
      currentTargetTreeSha: "fresh-tree",
      completionKind: "initial-overall-review",
      outstandingFindings: [],
    });
    expect(whole.planContext).toContain(
      plan.tasks[0]!.compiledContract.objective,
    );
    expect(whole.planContext).toContain(
      plan.tasks[1]!.compiledContract.objective,
    );
    expect(whole.candidateContext).toContain("Exact reviewed target receipt");
    expect(whole.canonicalFindings).toContainEqual(
      store.read().findings[obligation.id],
    );
    expect(
      readFileSync(join(dirname(store.path), "execution-plan.json"), "utf8"),
    ).toContain(plan.executionPlanHash);
  });

  it("continues delivered-only runs through fresh whole-plan assessment and a renewed repair budget without reparenting source findings", async () => {
    const store = await createSchedulerStore();
    await deliverSatisfied(store, first.id, "first");
    await deliverSatisfied(store, second.id, "second");
    await store.update(store.read().revision, (state) => {
      const candidateId = state.workstreams.source[first.id]!.candidateId!;
      state.findings["delivered-obligation"] = {
        ...finding,
        id: "delivered-obligation",
        candidateId,
        workstream: first,
        scope: { kind: "source", id: first.id },
        status: "open",
        origin: "initial",
        introducedRound: 0,
      };
      const oldRepair = { kind: "overall" as const, repairId: "old-repair" };
      state.workstreams.overall[oldRepair.repairId] = {
        ...oldRepair,
        phase: "failed",
        candidateId: "old-repair-candidate",
      };
      state.candidates["old-repair-candidate"] = {
        id: "old-repair-candidate",
        workstream: oldRepair,
        baseSha: "base-sha",
        commitSha: "old-repair-sha",
        treeSha: "old-repair-tree",
      };
      state.findings["old-whole-plan-obligation"] = {
        ...finding,
        id: "old-whole-plan-obligation",
        candidateId: "old-repair-candidate",
        workstream: oldRepair,
        scope: {
          kind: "whole_plan",
          initialTargetSha: "base-sha",
          initialTargetTreeSha: "target-tree",
        },
        status: "open",
        origin: "initial",
        introducedRound: 0,
      };
      state.reviews["overall:old-repair"] = {
        candidateId: "old-repair-candidate",
        candidateCommitSha: "old-repair-sha",
        candidateTreeSha: "old-repair-tree",
        comparisonBase: "base-sha",
        round: 1,
        pendingCorrectionIds: [],
        correctionConsumed: true,
        evidence: ["Old repair allowance consumed"],
        observations: [],
      };
      state.wholePlanReview = {
        status: "repairing",
        epoch: {
          initialTargetSha: "base-sha",
          initialTargetTreeSha: "target-tree",
          findingIds: ["old-whole-plan-obligation"],
          pendingCorrectionIds: [],
        },
        handoffDraft: "Historical handoff is not approval",
        reviewRetry: {
          status: "exhausted",
          attempts: 3,
          evidence: ["Old review budget exhausted"],
        },
      };
      return state;
    });
    await stop(store);
    const resumed = await restart(store);
    expect(resumed.phase).toBe("whole_plan_review");
    expect(resumed.wholePlanReview.reviewRetry).toBeUndefined();
    expect(resumed.wholePlanReview.epoch).toBeUndefined();
    expect(selectReadyWorkstreams(resumed)).toEqual([]);
    await apply(store, { kind: "whole_plan_review_requested" });
    const git = targetGit(store.read());
    const obligations = Object.values(store.read().findings);
    const assessments = obligations.map((obligation) => ({
      id: obligation.id,
      status: "unresolved",
      ...finding,
    }));
    expect(
      reduceRunEvent(store.read(), {
        generation: 1,
        kind: "whole_plan_review_completed",
        outcome: {
          kind: "approved",
          evidence: "Missing assessments",
          handoffDraft: "Not authority",
          reviewedTargetSha: "base-sha",
          reviewedTargetTreeSha: "target-tree",
        },
      }).accepted,
    ).toBe(false);
    const worker = new ScriptedSubagentClient(
      [
        {
          status: "completed",
          result: {
            findings: [],
            assessments,
            handoffDraft: "Fresh whole-plan draft",
          },
        },
      ],
      [store.read().run.checkout.root],
    );
    await runWholePlanReview({
      state: store.read(),
      plan: readExecutionPlan(dirname(store.path))!,
      git,
      subagents: worker,
      artifactsPath: join(dirname(store.path), "artifacts", "g1"),
      roles,
      dispatch: async (event) => {
        await apply(store, event);
      },
    });
    const repairing = store.read();
    expect(repairing.wholePlanReview.status).toBe("repairing");
    expect(repairing.wholePlanReview.epoch?.pendingCorrectionIds).toEqual(
      obligations.map((obligation) => obligation.id),
    );
    expect(Object.keys(repairing.workstreams.overall)).toEqual([
      "overall-repair-1-g1",
    ]);
    expect(
      repairing.generationHistory[0]?.reviews["overall:old-repair"]
        ?.correctionConsumed,
    ).toBe(true);
    expect(repairing.findings["delivered-obligation"]?.workstream).toEqual(
      first,
    );
    expect(repairing.workstreams.source[first.id]?.phase).toBe("completed");
    expect(worker.invocations[0]?.prompt).toContain("delivered-obligation");
    expect(worker.invocations[0]?.prompt).toContain("Historical handoff");
    expect(
      reduceRunEvent(repairing, {
        generation: 0,
        kind: "whole_plan_review_completed",
        outcome: {
          kind: "approved",
          evidence: "stale",
          handoffDraft: "stale",
          reviewedTargetSha: "base-sha",
          reviewedTargetTreeSha: "target-tree",
        },
      }).accepted,
    ).toBe(false);
  });

  it("settles a landed publication's lane before projection and preserves its delivered parent while resetting unfinished descendants", async () => {
    const store = await createSchedulerStore();
    const { intent, publication } = await preparedPublication(store);
    const receipt = {
      operationId: publication.leaseId,
      intentId: intent.id,
      candidateId: intent.candidateId,
      targetBaseSha: intent.targetBaseSha,
      publishedCommitSha: intent.preparedCommitSha,
      publishedTreeSha: intent.preparedTreeSha,
      targetRef: intent.targetRef,
      protectedArtifactHashes: intent.protectedArtifactHashes,
      publishedAt: now,
    };
    const recover = vi
      .spyOn(WriteAheadPublisher.prototype, "recover")
      .mockResolvedValue({ kind: "published", receipt });
    await stop(store);
    const git = targetGit(store.read(), intent.preparedCommitSha);
    await store.prepareRestart(await preflightRestart(store, git), []);
    expect(store.read().restartPreparation?.preservedSourceIds).toEqual([
      first.id,
    ]);
    await settlePublicationTransactions({ store, git });
    expect(recover).toHaveBeenCalledWith(intent);
    expect(store.read().publication.receipts[intent.id]).toEqual(receipt);
    expect(store.read().workstreams.source[first.id]?.phase).toBe("completed");
    await settleProjectionTransactions({ store });
    const receipts = store.read().publication.receipts;
    await store.recordRestartProgress(store.read().revision, {
      ...store.read().restartPreparation!,
      progress: {
        transactionsSettled: true,
        projectionSettled: true,
        targetValidated: true,
      },
    });
    const resumed = await store.activateRestart(
      await preflightRestart(store, git),
    );
    expect(resumed.executionTarget).toBe(intent.preparedCommitSha);
    expect(resumed.run.checkout.startHead).toBe("base-sha");
    expect(resumed.publication.receipts).toEqual(receipts);
    expect(resumed.tasks.first?.phase).toBe("published");
    expect(selectReadyWorkstreams(resumed)).toEqual([second.id]);
    await expect(
      store.update(resumed.revision, (state) => ({
        ...state,
        tasks: {
          ...state.tasks,
          first: { workstreamId: first.id, phase: "pending" },
        },
      })),
    ).rejects.toThrow("lifecycle invariants");
  });

  it("abandons a provably unlanded publication without reusing its approval or granting another preparation", async () => {
    const store = await createSchedulerStore();
    const { intent } = await preparedPublication(store);
    await stop(store);
    const git = targetGit(store.read());
    await store.prepareRestart(await preflightRestart(store, git), []);
    expect(store.read().restartPreparation?.preservedSourceIds).toEqual([]);
    await store.abandonRestartPublication(
      await preflightRestart(store, git),
      intent.id,
      "Exact recovery proved no ref write",
    );
    const abandonment = store.read().publication.abandonments[intent.id];
    await store.abandonRestartPublication(
      await preflightRestart(store, git),
      intent.id,
      "Repeated recovery",
    );
    expect(store.read().publication.abandonments[intent.id]).toEqual(
      abandonment,
    );
    const resumed = await restart(store);
    expect(resumed.workstreams.source[first.id]?.candidateId).toBeUndefined();
    expect(resumed.reviews[`source:${first.id}`]).toBeUndefined();
    expect(resumed.candidates[intent.candidateId]).toBeDefined();
    expect(resumed.activatedRestart?.transactionIntentIds).toContain(intent.id);
    expect(resumed.tasks.first?.phase).toBe("pending");
  });

  it("refuses superseded manual targets and unlanded intents based on external movement", async () => {
    const store = await createSchedulerStore();
    const { intent, publication } = await preparedPublication(store);
    await apply(store, {
      kind: "publication_target_moved",
      workstream: first,
      leaseId: publication.leaseId,
      candidateId: intent.candidateId,
      intentId: intent.id,
      expectedTargetSha: intent.targetBaseSha,
      actualTargetSha: "manual-descendant",
    });
    expect(store.read().workstreams.source[first.id]?.phase).toBe("approved");
    expect(expectedTargetHead(store.read())).toBe("manual-descendant");
    await stop(store);
    const before = readFileSync(store.path, "utf8");
    await expect(
      preflightRestart(store, targetGit(store.read(), "manual-descendant")),
    ).rejects.toThrow("exact trusted target");
    expect(readFileSync(store.path, "utf8")).toBe(before);
    const supersessions = store.read().publication.supersessions;
    const resumed = await restart(store);
    expect(resumed.publication.supersessions).toEqual(supersessions);
    expect(expectedTargetHead(resumed)).toBe(resumed.executionTarget);

    const movedBaseStore = await createSchedulerStore();
    await preparedPublication(movedBaseStore, "manual-descendant");
    await stop(movedBaseStore);
    const movedBefore = readFileSync(movedBaseStore.path, "utf8");
    await expect(
      preflightRestart(
        movedBaseStore,
        targetGit(movedBaseStore.read(), "manual-descendant"),
      ),
    ).rejects.toThrow("exact trusted target");
    expect(readFileSync(movedBaseStore.path, "utf8")).toBe(movedBefore);
  });

  it("recovers failed pre-launch startup in the activated generation without renewing allowances", async () => {
    const store = await createSchedulerStore();
    await stop(store);
    await restart(store);
    const executeEffect = vi.fn();
    const oldActor = new SchedulerActor({
      store,
      captureTargetBoundary: async () => {
        throw new TargetPreconditionError("Invalid launch boundary");
      },
      executeEffect,
      now: () => now,
    });
    await oldActor.start();
    await oldActor.settle();
    const failed = store.read();
    expect(failed.phase).toBe("failed");
    expect(failed.executionStartedAt).toBeUndefined();
    expect(executeEffect).not.toHaveBeenCalled();
    await expect(
      store.update(failed.revision, (state) => ({
        ...state,
        phase: "running",
        failure: undefined,
      })),
    ).rejects.toThrow("lifecycle invariants");
    const recovered = await restart(store);
    expect(recovered.generation).toBe(1);
    expect(recovered.phase).toBe("running");
    expect(recovered.restartPreparation).toBeUndefined();
    expect(recovered.activatedRestart).toEqual(failed.activatedRestart);
    expect(recovered.operationSettlements).toEqual(failed.operationSettlements);
    expect(recovered.operationalRetries).toEqual(failed.operationalRetries);
    expect(recovered.startupRecoveries[0]?.failure).toEqual(failed.failure);
    expect(
      runMarkdown(recovered.run.checkout.root, recovered, "details"),
    ).toContain("Invalid launch boundary");
    expect(
      projectRunSurface(recovered.run.checkout.root, recovered).outcomes,
    ).toContainEqual({
      kind: "startup_recovery",
      text: "Generation 1: failed · Invalid launch boundary",
    });
    expect(RunStore.open(store.lease, store.path).read()).toEqual(recovered);
    await oldActor.dispatch({
      kind: "failure_requested",
      category: "runtime",
      reason: "Stale startup callback",
      now,
    });
    expect(store.read()).toEqual(recovered);
    await expect(
      store.update(recovered.revision, (state) => ({
        ...state,
        startupRecoveries: [],
      })),
    ).rejects.toThrow("lifecycle invariants");

    const actor = new SchedulerActor({
      store,
      now: () => now,
      captureTargetBoundary: async () => JSON.stringify({ head: "base-sha" }),
      executeEffect: async ({ effect, dispatch, markExecutionStarted }) => {
        await markExecutionStarted();
        if (effect.kind !== "run_implementation") {
          throw new Error("Unexpected effect");
        }
        await dispatch({
          kind: "implementation_failed",
          workstream: effect.workstream,
          leaseId: effect.leaseId,
          category: "semantic_blocked",
          evidence: "Worker began but could not implement the contract",
        });
      },
    });
    await actor.start();
    await actor.settle();
    expect(store.read().executionStartedAt).toBe(now);
    const prepared = await store.prepareRestart(
      await preflightRestart(store, targetGit(store.read())),
      [],
    );
    expect(prepared.restartPreparation?.generation).toBe(2);
    expect(prepared.startupRecoveries).toEqual(recovered.startupRecoveries);
  });

  it("settles worker preflight failure as startup failure rather than exhausting an unlaunched cycle", async () => {
    const store = await createSchedulerStore();
    await stop(store);
    await restart(store);
    const executeEffect = vi.fn(async () => {
      throw new WorkerPacketError("Worker packet preflight refused");
    });
    const actor = new SchedulerActor({ store, executeEffect });
    await actor.start();
    await actor.settle();
    expect(executeEffect).toHaveBeenCalledTimes(1);
    expect(store.read().phase).toBe("failed");
    expect(store.read().executionStartedAt).toBeUndefined();
    expect(store.read().operationalRetries).toEqual({});
    const recovered = await restart(store);
    expect(recovered.generation).toBe(1);
    expect(selectReadyWorkstreams(recovered)).toEqual([first.id]);
    expect(recovered.startupRecoveries[0]?.failure?.reason).toBe(
      "Worker packet preflight refused",
    );
  });

  it("recovers unlaunched whole-plan review startup without reopening delivered source work", async () => {
    const store = await createSchedulerStore();
    await deliverSatisfied(store, first.id, "first");
    await deliverSatisfied(store, second.id, "second");
    await stop(store);
    const activated = await restart(store);
    expect(activated.phase).toBe("whole_plan_review");
    const executeEffect = vi.fn();
    const actor = new SchedulerActor({
      store,
      executeEffect,
      captureTargetBoundary: async () => {
        throw new TargetPreconditionError(
          "Invalid whole-plan startup boundary",
        );
      },
    });
    await actor.start();
    await actor.settle();
    expect(store.read().phase).toBe("failed");
    expect(store.read().wholePlanReview.status).toBe("reviewing");
    expect(store.read().executionStartedAt).toBeUndefined();
    expect(executeEffect).not.toHaveBeenCalled();
    const recovered = await restart(store);
    expect(recovered.generation).toBe(1);
    expect(recovered.phase).toBe("whole_plan_review");
    expect(recovered.wholePlanReview.status).toBe("pending");
    expect(recovered.workstreams).toEqual(activated.workstreams);
    expect(recovered.satisfaction.receipts).toEqual(
      activated.satisfaction.receipts,
    );
    expect(recovered.startupRecoveries[0]?.failure?.reason).toBe(
      "Invalid whole-plan startup boundary",
    );
  });

  it("settles unlaunched stopping whole-plan execution before same-generation startup recovery", async () => {
    const store = await createSchedulerStore();
    await deliverSatisfied(store, first.id, "first");
    await deliverSatisfied(store, second.id, "second");
    await stop(store);
    const activated = await restart(store);
    await apply(store, {
      kind: "failure_requested",
      category: "runtime",
      reason: "Whole-plan startup interrupted",
      now,
    });
    const stopping = store.read();
    expect(stopping.phase).toBe("stopping");
    expect(stopping.processLeases).toEqual({});
    expect(stopping.executionStartedAt).toBeUndefined();
    const before = readFileSync(store.path, "utf-8");
    await preflightRestart(store, targetGit(stopping));
    expect(readFileSync(store.path, "utf-8")).toBe(before);
    const recovered = await restart(store);
    expect(recovered.generation).toBe(activated.generation);
    expect(recovered.phase).toBe("whole_plan_review");
    expect(recovered.activatedRestart).toEqual(activated.activatedRestart);
    expect(recovered.workstreams).toEqual(activated.workstreams);
    expect(recovered.startupRecoveries[0]?.failure).toEqual(stopping.failure);
    const executeEffect = vi.fn(
      async ({ effect, dispatch, markExecutionStarted }) => {
        expect(effect.kind).toBe("run_whole_plan_review");
        await markExecutionStarted();
        await dispatch({
          kind: "failure_requested",
          category: "runtime",
          reason: "Fresh whole-plan review began",
          now,
        });
      },
    );
    const actor = new SchedulerActor({ store, executeEffect });
    await actor.start();
    await actor.settle();
    expect(executeEffect).toHaveBeenCalledTimes(1);
    expect(store.read().executionStartedAt).toBeDefined();
  });

  it("refuses moved or dirty targets observationally without reserving a successor", async () => {
    const store = await createSchedulerStore();
    await stop(store);
    const before = readFileSync(store.path, "utf8");
    await expect(
      preflightRestart(store, targetGit(store.read(), "manual-descendant")),
    ).rejects.toThrow("exact trusted target");
    await expect(
      preflightRestart(store, {
        ...targetGit(store.read()),
        isCleanExcept: async () => false,
      }),
    ).rejects.toThrow("cleanliness");
    expect(readFileSync(store.path, "utf8")).toBe(before);
  });
});
