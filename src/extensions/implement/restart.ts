import { resolve, relative } from "node:path";
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

/** Observational only. Transaction recovery and resource disposal are separate host obligations. */
export async function preflightRestart(
  store: RunStore,
  git: GitClient,
): Promise<RestartPreflight> {
  store.lease.assertOwned();
  const state = store.refresh();
  if (
    !state.executionPlan ||
    (!["failed", "incomplete", "completed"].includes(state.phase) &&
      !(state.generation > 0 && !state.executionStartedAt)) ||
    Object.keys(state.processLeases).length > 0
  ) {
    throw new Error(
      "Restart requires a bound, settled run with no live execution owner.",
    );
  }
  if (!sourceIdentityMatches(state) || !protectedArtifactsMatch(state)) {
    throw new Error(
      "Restart source or protected plan evidence is unavailable.",
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
    throw new Error("Restart cannot classify multiple unsettled publications.");
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
      "Restart target differs from the exact trusted target receipt.",
    );
  }
  const branchRef = `refs/heads/${await git.currentBranch()}`;
  const protectedPaths = Object.keys(state.protectedArtifactHashes);
  if (
    resolve(await git.root()) !== resolve(state.run.checkout.root) ||
    (await git.checkoutIdentity()) !== state.run.checkout.gitDir ||
    branchRef !== state.run.checkout.branchRef ||
    (await git.activeOperation()) ||
    !(await git.isCleanExcept(protectedPaths)) ||
    (await git.hasStagedChangesInPaths(protectedPaths))
  ) {
    throw new Error(
      "Restart checkout identity, branch, operation, or cleanliness is invalid.",
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
