import { readFileSync } from "node:fs";
import { canonicalPath } from "./source-integrity.js";
import { hostname } from "node:os";
import { dirname, resolve, relative } from "node:path";
import { inspectCheckboxProjection } from "./projection.js";
import { reduceRunEvent } from "./scheduler/scheduler.js";
import { readExecutionPlan } from "./execution-plan.js";
import { loadRequirementsContext } from "./requirements-context.js";
import { WriteAheadPublisher } from "./write-ahead-publication.js";
import { openFindingObligations } from "./finding-context.js";
import type { GitClient } from "./git.js";
import {
  candidateGeneration,
  currentOperationSettlements,
  protectedArtifactsMatch,
  sourceIdentityMatches,
  type RunState,
  type RunStore,
} from "./store.js";

// This inventory records host ownership evidence; disposal must revalidate it before removal.
export type RestartResource = {
  id: string;
  kind: "worktree" | "staging" | "branch";
  path: string;
  branch: string;
  candidateId?: string;
  operationId?: string;
  ownershipEvidence: string;
  status: "pending" | "retired";
};

const validated = new WeakSet<object>();
export type RestartPreflight = {
  runId: string;
  revision: number;
  generation: number;
  targetSha: string;
  targetTreeSha: string;
  branchRef: string;
};

export function assertRestartPreflight(
  proof: RestartPreflight,
  state: RunState,
): void {
  if (
    !validated.has(proof) ||
    proof.runId !== state.run.id ||
    proof.revision !== state.revision ||
    proof.generation !== state.generation
  ) {
    throw new Error("Restart requires a current host-validated preflight.");
  }
}

export function restartDeliveredCandidateIds(
  state: RunState,
  targetSha: string,
): Set<string> {
  return new Set([
    ...Object.values(state.publication.receipts).map(
      (receipt) => receipt.candidateId,
    ),
    ...Object.values(state.satisfaction.receipts).map(
      (receipt) => receipt.candidateId,
    ),
    ...Object.values(state.publication.intents)
      .filter(
        (intent) =>
          !state.publication.receipts[intent.id] &&
          !state.publication.abandonments[intent.id] &&
          !state.publication.supersessions[intent.id] &&
          intent.preparedCommitSha === targetSha,
      )
      .map((intent) => intent.candidateId),
  ]);
}

export function restartPreservedSourceIds(
  state: RunState,
  targetSha: string,
): string[] {
  const delivered = restartDeliveredCandidateIds(state, targetSha);
  return Object.values(state.workstreams.source)
    .filter((lane) => lane.candidateId && delivered.has(lane.candidateId))
    .map((lane) => lane.id);
}

export function deliveredSourceIds(state: RunState): string[] {
  return Object.values(state.workstreams.source)
    .filter((lane) => {
      const published = Object.values(state.publication.receipts).some(
        (receipt) => receipt.candidateId === lane.candidateId,
      );
      const satisfied = Object.values(state.satisfaction.receipts).some(
        (receipt) => receipt.candidateId === lane.candidateId,
      );
      return (
        (published || satisfied) &&
        lane.taskIds.every((id) =>
          ["published", "reviewed_satisfied"].includes(state.tasks[id]!.phase),
        )
      );
    })
    .map((lane) => lane.id);
}

export function restartTarget(
  state: Pick<RunState, "run" | "publication" | "executionTarget">,
): string {
  const intents = Object.values(state.publication.intents);
  const pending = intents.filter(
    (intent) =>
      !state.publication.receipts[intent.id] &&
      !state.publication.supersessions[intent.id] &&
      !state.publication.abandonments[intent.id],
  );
  if (pending.length > 1) {
    throw new Error("Resume found multiple unresolved publication intents.");
  }
  for (const intent of [...intents].reverse()) {
    const receipt = state.publication.receipts[intent.id];
    if (receipt) {
      return receipt.publishedCommitSha;
    }
  }
  return state.executionTarget;
}

export function interruptedRestartState(current: RunState): RunState {
  let state = structuredClone(current);
  const apply = (event: Parameters<typeof reduceRunEvent>[1]) => {
    const result = reduceRunEvent(state, event);
    if (!result.accepted) {
      throw new Error(
        result.error ?? "Interrupted execution cannot settle safely.",
      );
    }
    state = result.state;
  };
  if (["planning", "running", "whole_plan_review"].includes(state.phase)) {
    // An activated, unlaunched actor already has a usable current generation.
    if (
      state.generation > 0 &&
      !state.executionStartedAt &&
      !Object.keys(state.processLeases).length
    ) {
      return state;
    }
    apply({
      kind: "failure_requested",
      category: "interrupted",
      reason: "Run was retained after its actor ended.",
      now: new Date().toISOString(),
    });
  }
  if (state.phase === "stopping") {
    for (const lease of Object.values(state.processLeases)) {
      apply({ kind: "process_abandoned", leaseId: lease.id });
    }
    apply({ kind: "run_failed" });
  }
  return state;
}

function assertInterruptedOwnerGone(store: RunStore, state: RunState): void {
  if (
    ["failed", "incomplete", "completed"].includes(state.phase) &&
    !Object.keys(state.processLeases).length
  ) {
    return;
  }
  if (
    state.generation > 0 &&
    !state.executionStartedAt &&
    !Object.keys(state.processLeases).length
  ) {
    return;
  }
  const owner = store.lease.priorOwner;
  if (
    !owner ||
    owner.runId !== state.run.id ||
    owner.hostname !== hostname() ||
    owner.checkoutRoot !== state.run.checkout.root ||
    owner.gitDir !== state.run.checkout.gitDir ||
    owner.runPath !== dirname(store.path)
  ) {
    throw new Error(
      "Resume cannot prove the prior execution owner is gone; process ownership is uncertain.",
    );
  }
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return;
    }
    throw new Error("Resume cannot verify prior process ownership.");
  }
  throw new Error(`Resume is blocked by live prior owner PID ${owner.pid}.`);
}

/** Accept only recorded projection sides, never arbitrary checkbox or prose edits. */
function restartArtifactsMatch(state: RunState): boolean {
  if (
    Object.keys(state.protectedArtifactHashes).some(
      (path) => canonicalPath(path) !== path,
    )
  ) {
    return false;
  }
  const observation = structuredClone(state);
  for (const debt of state.projectionDebt) {
    const outcome = inspectCheckboxProjection(state.run.checkout.root, debt);
    if (outcome.kind === "safety_paused") {
      return false;
    }
    const newSide =
      readFileSync(debt.canonicalPath, "utf-8") === debt.expectedNewContent;
    observation.protectedArtifactHashes[debt.canonicalPath] = newSide
      ? debt.expectedNewHash
      : debt.expectedOldHash;
    if (newSide) {
      for (const id of debt.taskIds) {
        observation.tasks[id]!.phase = "published";
      }
    }
  }
  return (
    sourceIdentityMatches(observation) && protectedArtifactsMatch(observation)
  );
}

/** Observational only. Transaction recovery and resource disposal are separate host obligations. */
export async function preflightRestart(
  store: RunStore,
  git: GitClient,
): Promise<RestartPreflight> {
  store.lease.assertOwned();
  const original = store.refresh();
  assertInterruptedOwnerGone(store, original);
  const state = interruptedRestartState(original);
  if (
    !state.executionPlan ||
    (!["failed", "incomplete", "completed"].includes(state.phase) &&
      !(state.generation > 0 && !state.executionStartedAt)) ||
    Object.keys(state.processLeases).length > 0
  ) {
    throw new Error(
      "Resume requires a bound, settled run with no live execution owner. Planning failures before plan binding cannot resume.",
    );
  }
  const plan = readExecutionPlan(dirname(store.path));
  if (!plan || plan.executionPlanHash !== state.executionPlan.hash) {
    throw new Error("Resume requires the original bound execution plan.");
  }
  loadRequirementsContext(dirname(store.path), plan);
  if (!restartArtifactsMatch(state)) {
    throw new Error(
      "Resume source or protected plan evidence is unavailable; restore the original protected content before retrying.",
    );
  }
  const targetSha = await git.head();
  const pending = Object.values(state.publication.intents).filter(
    (intent) =>
      !state.publication.receipts[intent.id] &&
      !state.publication.abandonments[intent.id] &&
      !state.publication.supersessions[intent.id],
  );
  if (pending.length > 1) {
    throw new Error("Resume cannot classify multiple unsettled publications.");
  }
  // A landed write-ahead commit is not delivery until the host settles its lane and projection.
  if (
    targetSha !== restartTarget(state) &&
    !(
      pending.length === 1 &&
      pending[0]!.targetBaseSha === restartTarget(state) &&
      targetSha === pending[0]!.preparedCommitSha &&
      (await git.treeAt(targetSha)) === pending[0]!.preparedTreeSha
    )
  ) {
    throw new Error(
      `Resume target differs from the exact trusted target receipt: expected ${restartTarget(state)}${pending[0] ? ` or proven publication ${pending[0].preparedCommitSha}` : ""}, found ${targetSha}. Restore the retained target boundary; manual descendants cannot authorize Resume.`,
    );
  }
  for (const receipt of Object.values(state.publication.receipts)) {
    if (
      (await git.treeAt(receipt.publishedCommitSha)) !==
        receipt.publishedTreeSha ||
      (receipt.publishedCommitSha !== targetSha &&
        !(await git.isAncestor(receipt.publishedCommitSha, targetSha)))
    ) {
      throw new Error(
        "Resume target no longer contains its exact delivered publication evidence.",
      );
    }
  }
  let transactionClean = false;
  if (pending.length) {
    const outcome = await new WriteAheadPublisher({
      git,
      checkoutRoot: state.run.checkout.root,
      checkoutIdentity: state.run.checkout.gitDir,
      protectedPaths: Object.keys(state.protectedArtifactHashes),
    }).inspectRecovery(pending[0]!);
    if (!["published", "retry_from_base"].includes(outcome.kind)) {
      throw new Error(
        outcome.kind === "safety_paused"
          ? outcome.reason
          : "Resume cannot classify publication.",
      );
    }
    transactionClean = true;
  }
  const branchRef = `refs/heads/${await git.currentBranch()}`;
  const protectedPaths = Object.keys(state.protectedArtifactHashes);
  if (
    resolve(await git.root()) !== resolve(state.run.checkout.root) ||
    (await git.checkoutIdentity()) !== state.run.checkout.gitDir
  ) {
    throw new Error(
      "Resume checkout identity differs from the original run; use its original checkout.",
    );
  }
  if (branchRef !== state.run.checkout.branchRef) {
    throw new Error(
      `Resume requires branch ${state.run.checkout.branchRef}, found ${branchRef}.`,
    );
  }
  const operation = await git.activeOperation();
  if (operation) {
    throw new Error(
      `Resume is blocked by an active ${operation} operation; finish or abort it explicitly.`,
    );
  }
  if (
    (!transactionClean && !(await git.isCleanExcept(protectedPaths))) ||
    (await git.hasStagedChangesInPaths(protectedPaths))
  ) {
    throw new Error(
      "Resume checkout cleanliness is invalid: unrelated or staged protected changes remain. Preserve your changes outside this operation before retrying; Resume will not discard them.",
    );
  }
  openFindingObligations(state);
  const proof = Object.freeze({
    runId: state.run.id,
    revision: state.revision,
    generation: state.generation,
    targetSha,
    targetTreeSha: await git.treeAt(targetSha),
    branchRef,
  });
  validated.add(proof);
  return proof;
}

export function validateRestartResources(
  state: RunState,
  resources: RestartResource[],
  root: string,
): void {
  const delivered = new Set(deliveredSourceIds(state));
  const ids = new Set<string>();
  for (const resource of resources) {
    const candidate = resource.candidateId
      ? state.candidates[resource.candidateId]
      : undefined;
    const operation = resource.operationId
      ? currentOperationSettlements(state).find(
          (operation) => operation.operationId === resource.operationId,
        )
      : undefined;
    const workstream = candidate?.workstream ?? operation?.workstream;
    const within = relative(resolve(root), resolve(resource.path));
    if (
      ids.has(resource.id) ||
      !workstream ||
      (resource.candidateId &&
        (!candidate ||
          candidateGeneration(state, candidate.id) !== state.generation)) ||
      (resource.operationId && !operation) ||
      (workstream.kind === "source" && delivered.has(workstream.id)) ||
      (candidate &&
        Object.values(state.publication.receipts).some(
          (receipt) => receipt.candidateId === candidate.id,
        )) ||
      !within ||
      within === ".." ||
      within.startsWith("../") ||
      !resource.branch.startsWith(`pipkin/implement/${state.run.id}/`) ||
      !resource.ownershipEvidence.trim() ||
      resource.status !== "pending"
    ) {
      throw new Error(
        "Restart retirement inventory is not unpublished run-owned execution.",
      );
    }
    ids.add(resource.id);
  }
}
