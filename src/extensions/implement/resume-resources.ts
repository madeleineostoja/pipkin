import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { stagingIdentity } from "./candidate-replay.js";
import type { GitClient } from "./git.js";
import { sha256 } from "./source-integrity.js";
import {
  candidateGeneration,
  currentOperationSettlements,
  type RunState,
} from "./store.js";
import type { RestartResource } from "./restart.js";

function samePath(left: string, right: string): boolean {
  return existsSync(left) && existsSync(right)
    ? realpathSync(left) === realpathSync(right)
    : resolve(left) === resolve(right);
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function assertOwnedPath(root: string, path: string): void {
  const inside = relative(resolve(root), resolve(path));
  if (!inside || inside.startsWith("..")) {
    throw new Error(`Resume resource escapes its owned root: ${path}`);
  }
  for (const boundary of [dirname(root), root]) {
    if (isSymlink(boundary)) {
      throw new Error(`Resume resource has a symlinked root: ${path}`);
    }
  }
  const components = inside.split("/");
  let current = resolve(root);
  for (const component of components) {
    current = join(current, component);
    if (isSymlink(current)) {
      throw new Error(`Resume resource has a symlinked path: ${path}`);
    }
  }
}

async function observe(
  git: GitClient,
  resource: RestartResource,
): Promise<string> {
  const workspace = git.forWorktree(resource.path);
  const stat = lstatSync(resource.path);
  if (
    !git.commonIdentity ||
    !workspace.commonIdentity ||
    (await workspace.commonIdentity()) !== (await git.commonIdentity())
  ) {
    throw new Error(
      `Resume workspace belongs to another repository: ${resource.path}`,
    );
  }
  const [branch, head, identity, operation, dirt, index, untracked] =
    await Promise.all([
      workspace.currentBranch(),
      workspace.head(),
      workspace.checkoutIdentity(),
      workspace.activeOperation(),
      workspace.worktreeFingerprintExcept([]),
      workspace.indexEntries().then(sha256),
      workspace.nonignoredUntracked(),
    ]);
  if (branch !== resource.branch || operation || !stat.isDirectory()) {
    throw new Error(
      `Resume workspace ownership or Git operation changed: ${resource.path}`,
    );
  }
  // Nonignored untracked contents are part of the confirmed disposal, not just their names.
  const loose = untracked.map((path) => {
    const file = join(resource.path, path);
    const entry = lstatSync(file);
    return [
      path,
      entry.isSymbolicLink() ? readlinkSync(file) : sha256(readFileSync(file)),
    ];
  });
  return JSON.stringify({
    head,
    identity,
    dev: stat.dev,
    ino: stat.ino,
    dirt,
    index,
    loose,
  });
}

export async function inventoryResumeResources(args: {
  state: RunState;
  git: GitClient;
  root: string;
  preservedSourceIds: string[];
  deliveredCandidateIds: ReadonlySet<string>;
}): Promise<RestartResource[]> {
  const { state, git, root } = args;
  const expected = new Map<string, RestartResource>();
  const knownPaths = new Map<string, { branch: string; disposable: boolean }>();
  const knownBranches = new Map<string, string>();
  const publishedRepairs = new Set(
    [...args.deliveredCandidateIds].flatMap((candidateId) => {
      const lane = state.candidates[candidateId]!.workstream;
      return lane.kind === "overall" ? [lane.repairId] : [];
    }),
  );
  const preserved = (lane: RunState["candidates"][string]["workstream"]) =>
    lane.kind === "source"
      ? args.preservedSourceIds.includes(lane.id)
      : publishedRepairs.has(lane.repairId);
  const add = (
    resource: Omit<RestartResource, "ownershipEvidence" | "status">,
    disposable: boolean,
  ) => {
    const path = resolve(resource.path);
    const authority = knownPaths.get(path);
    const branchPath = knownBranches.get(resource.branch);
    if (
      (authority &&
        (authority.branch !== resource.branch ||
          authority.disposable !== disposable)) ||
      (branchPath && branchPath !== path)
    ) {
      throw new Error(`Conflicting Resume resource evidence: ${resource.path}`);
    }
    knownPaths.set(path, { branch: resource.branch, disposable });
    knownBranches.set(resource.branch, path);
    if (!disposable) {
      return;
    }
    const prior = expected.get(resource.path);
    if (!prior || resource.candidateId) {
      expected.set(resource.path, {
        ...resource,
        ownershipEvidence: "",
        status: "pending",
      });
    }
  };
  for (const operation of currentOperationSettlements(state)) {
    const lane = operation.workstream;
    if (
      !lane ||
      operation.kind === "publication" ||
      operation.kind === "reconciliation"
    ) {
      continue;
    }
    const id = lane.kind === "source" ? lane.id : lane.repairId;
    add(
      {
        id: `workspace:g${state.generation}:${id}`,
        kind: "worktree",
        path: join(root, `g${state.generation}`, id),
        branch: `pipkin/implement/${state.run.id}/g${state.generation}/${id}`,
        operationId: operation.operationId,
      },
      !preserved(lane),
    );
  }
  for (const candidate of Object.values(state.candidates)) {
    const generation = candidateGeneration(state, candidate.id);
    const disposable =
      generation === state.generation && !preserved(candidate.workstream);
    const id =
      candidate.workstream.kind === "source"
        ? candidate.workstream.id
        : candidate.workstream.repairId;
    add(
      {
        id: `workspace:g${generation}:${id}`,
        kind: "worktree",
        path: join(root, `g${generation}`, id),
        branch: `pipkin/implement/${state.run.id}/g${generation}/${id}`,
        candidateId: candidate.id,
      },
      disposable,
    );
    for (const preparation of Object.values(
      state.publication.preparations,
    ).filter((item) => item.candidateId === candidate.id)) {
      add(
        {
          id: preparation.id,
          kind: "staging",
          path: preparation.stagingWorktree,
          branch: preparation.stagingBranch,
          candidateId: candidate.id,
        },
        disposable,
      );
    }
    for (const assessment of Object.values(
      state.satisfaction.assessments,
    ).filter((item) => item.candidateId === candidate.id && item.operationId)) {
      const staging = stagingIdentity({
        runId: state.run.id,
        operationId: assessment.operationId!,
        candidateId: candidate.id,
        candidateCommitSha: candidate.commitSha,
        candidateTreeSha: candidate.treeSha,
        targetBaseSha: assessment.targetSha,
        targetRef: state.run.checkout.branchRef,
      });
      add(
        {
          id: staging.id,
          kind: "staging",
          path: join(root, staging.id),
          branch: staging.branchName,
          candidateId: candidate.id,
        },
        disposable,
      );
    }
  }
  for (const execution of [
    ...state.generationHistory,
    {
      generation: state.generation,
      reconciliationAssignments: state.reconciliationAssignments,
    },
  ]) {
    for (const assignment of Object.values(
      execution.reconciliationAssignments,
    )) {
      const candidate = state.candidates[assignment.candidateId];
      const operation = state.operationSettlements[assignment.operationId];
      const operationGeneration =
        state.generationHistory.find((history) =>
          history.operationIds.includes(assignment.operationId),
        )?.generation ?? state.generation;
      const staging = stagingIdentity({
        runId: state.run.id,
        operationId: assignment.operationId,
        candidateId: assignment.candidateId,
        candidateCommitSha: assignment.candidateCommitSha,
        candidateTreeSha: assignment.candidateTreeSha,
        targetBaseSha: assignment.targetSha,
        targetRef: assignment.staging.targetRef,
      });
      const lane = assignment.workstream;
      if (
        !candidate ||
        candidateGeneration(state, candidate.id) !== execution.generation ||
        candidate.commitSha !== assignment.candidateCommitSha ||
        candidate.treeSha !== assignment.candidateTreeSha ||
        (lane.kind === "source"
          ? candidate.workstream.kind !== "source" ||
            candidate.workstream.id !== lane.id
          : candidate.workstream.kind !== "overall" ||
            candidate.workstream.repairId !== lane.repairId) ||
        !operation ||
        operation.kind !== "reconciliation" ||
        operation.candidateId !== candidate.id ||
        operationGeneration !== execution.generation ||
        operation.workstream?.kind !== lane.kind ||
        (lane.kind === "source"
          ? operation.workstream.kind !== "source" ||
            operation.workstream.id !== lane.id
          : operation.workstream.kind !== "overall" ||
            operation.workstream.repairId !== lane.repairId) ||
        assignment.staging.targetRef !== state.run.checkout.branchRef ||
        assignment.staging.id !== staging.id ||
        assignment.staging.branchName !== staging.branchName ||
        (await git.treeAt(assignment.targetSha)) !== assignment.targetTreeSha
      ) {
        throw new Error(
          `Resume cannot establish exact reconciliation staging ownership: ${assignment.id}`,
        );
      }
      add(
        {
          id: staging.id,
          kind: "staging",
          path: join(root, staging.id),
          branch: staging.branchName,
          candidateId: candidate.id,
          operationId: operation.operationId,
        },
        execution.generation === state.generation && !preserved(lane),
      );
    }
  }
  const registered = await git.listWorktreeRegistrations();
  const canonicalRoot = existsSync(root) ? realpathSync(root) : resolve(root);
  for (const { path, branch } of registered) {
    const lexicalInside = relative(resolve(root), resolve(path));
    if (lexicalInside && !lexicalInside.startsWith("..")) {
      assertOwnedPath(root, path);
    }
    // The shared registry may include worktrees unavailable in this container.
    const canonicalPath = existsSync(path) ? realpathSync(path) : resolve(path);
    const inside = relative(canonicalRoot, canonicalPath);
    if (!inside || inside.startsWith("..")) {
      if (branch?.startsWith(`pipkin/implement/${state.run.id}/`)) {
        throw new Error(
          `Resume branch is checked out outside its owned root: ${branch}`,
        );
      }
      continue;
    }
    if (![...knownPaths.keys()].some((known) => samePath(known, path))) {
      throw new Error(
        `Resume cannot establish durable ownership of workspace: ${path}`,
      );
    }
    if (!existsSync(path)) {
      throw new Error(
        `Resume workspace registration remains without its inventoried directory: ${path}`,
      );
    }
  }
  for (const branch of await git.listBranchesMatching(
    `pipkin/implement/${state.run.id}/*`,
  )) {
    if (!knownBranches.has(branch)) {
      throw new Error(
        `Resume cannot establish durable ownership of branch: ${branch}`,
      );
    }
  }
  const resources: RestartResource[] = [];
  for (const resource of expected.values()) {
    assertOwnedPath(root, resource.path);
    const tip = await git.branchTip?.(resource.branch);
    const candidate = resource.candidateId
      ? state.candidates[resource.candidateId]
      : undefined;
    const operation = resource.operationId
      ? currentOperationSettlements(state).find(
          (item) => item.operationId === resource.operationId,
        )
      : undefined;
    const lane = operation?.workstream;
    const base =
      candidate?.baseSha ??
      (lane?.kind === "source"
        ? state.workstreams.source[lane.id]?.baseSha
        : lane?.kind === "overall"
          ? state.executionTarget
          : undefined);
    if (tip && (!base || !(await git.isAncestor(base, tip)))) {
      throw new Error(
        `Resume resource lost its durable execution base: ${resource.branch}`,
      );
    }
    if (!existsSync(resource.path) && !tip) {
      continue;
    }
    if (!existsSync(resource.path)) {
      resource.kind = "branch";
      resource.ownershipEvidence = JSON.stringify({ head: tip });
    } else {
      if (!registered.some(({ path }) => samePath(path, resource.path))) {
        throw new Error(`Resume workspace is not registered: ${resource.path}`);
      }
      resource.ownershipEvidence = await observe(git, resource);
      if (JSON.parse(resource.ownershipEvidence).head !== tip) {
        throw new Error(
          `Resume branch conflicts with workspace: ${resource.branch}`,
        );
      }
    }
    resources.push(resource);
  }
  return resources;
}

/** Only the persisted confirmed inventory authorizes dirty unpublished disposal. */
export async function inspectResumeResource(
  git: GitClient,
  root: string,
  resource: RestartResource,
): Promise<{ present: boolean; tip: string | undefined }> {
  assertOwnedPath(root, resource.path);
  const tip = await git.branchTip?.(resource.branch);
  const present = existsSync(resource.path);
  if (resource.status === "retired" && (present || tip)) {
    throw new Error(`Retired Resume resource reappeared: ${resource.path}`);
  }
  const registered = await git.listWorktreeRegistrations();
  if (
    !present &&
    registered.some(({ path }) => samePath(path, resource.path))
  ) {
    throw new Error(
      `Resume workspace registration remains without its inventoried directory: ${resource.path}`,
    );
  }
  if (!present && !tip) {
    return { present, tip };
  }
  const expected = JSON.parse(resource.ownershipEvidence) as { head: string };
  if (tip && tip !== expected.head) {
    throw new Error(
      `Resume branch changed after confirmation: ${resource.branch}`,
    );
  }
  if (present) {
    if (
      resource.kind === "branch" ||
      !registered.some(({ path }) => samePath(path, resource.path)) ||
      (await observe(git, resource)) !== resource.ownershipEvidence
    ) {
      throw new Error(
        `Resume workspace changed after confirmation: ${resource.path}`,
      );
    }
  }
  if (
    registered.some(
      ({ path, branch }) =>
        branch === resource.branch && !samePath(path, resource.path),
    )
  ) {
    throw new Error(
      `Resume branch is checked out outside its inventoried workspace: ${resource.branch}`,
    );
  }
  return { present, tip };
}

export async function retireResumeResource(
  git: GitClient,
  root: string,
  resource: RestartResource,
): Promise<void> {
  const { present, tip } = await inspectResumeResource(git, root, resource);
  if (present) {
    await git.removeWorktree(resource.path);
  }
  if (tip) {
    await git.deleteTaskBranch(resource.branch);
  }
}
