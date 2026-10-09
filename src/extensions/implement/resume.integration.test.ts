import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileExecutionPlan } from "./execution-plan.js";
import { buildMaterialStore } from "./material-store.js";
import { parsePlan } from "./plan.js";
import { writeSourceCorpus } from "./requirements-context.js";
import { sha256 } from "./source-integrity.js";
import {
  acquireCheckoutLease,
  createPlanningRun,
  loadRunState,
  RunStore,
  sourceIdentityForExecutionPlan,
  protectedArtifactsMatch,
  type RunState,
} from "./store.js";
import { reduceRunEvent, type SchedulerEvent } from "./scheduler/scheduler.js";
import { ExecGitClient } from "./git.js";
import {
  CandidateReplayEngine,
  publicationIntentId,
  publicationPreparation,
} from "./candidate-replay.js";
import { WriteAheadPublisher } from "./write-ahead-publication.js";
import { openResume } from "./resume.js";
import { createRuntime } from "./run.js";
import * as runRuntime from "./run.js";
import { registerImplementCommand } from "./command.js";
import { ScriptedSubagentClient } from "./e2e-test-support.js";
import type { ImplementRoles } from "./subagents.js";
import { SchedulerActor } from "./scheduler/scheduler-actor.js";
import { inventoryResumeResources } from "./resume-resources.js";
import { createCheckboxProjectionIntent } from "./projection.js";
import { settleProjectionTransactions } from "./transaction-settlement.js";

const roots: string[] = [];
const leases: Array<{ release(): Promise<void> }> = [];
const now = "2026-01-01T00:00:00.000Z";
const first = { kind: "source" as const, id: "first-stream" };
const roles = Object.fromEntries(
  ["implementer", "reviewer", "planner"].map((role) => [
    role,
    { type: `pipkin:implement:${role}`, model: "test", thinking: "high" },
  ]),
) as ImplementRoles;
function git(root: string, ...args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf-8" }).trim();
}
async function apply(store: RunStore, event: SchedulerEvent) {
  const state = store.read();
  const result = reduceRunEvent(state, {
    generation: state.generation,
    ...event,
  });
  if (!result.accepted) {
    throw new Error(result.error);
  }
  await store.update(state.revision, () => result.state);
  return result.effects;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const lease of leases.splice(0)) {
    await lease.release();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function fixture(options?: { parallel: boolean }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pipkin-resume-")));
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  const content = "# Plan\n\n- [ ] First task\n- [ ] Second task\n";
  const planPath = join(root, "plan.md");
  writeFileSync(planPath, content);
  writeFileSync(join(root, "app.txt"), "base\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "chore: base");
  const client = new ExecGitClient(root);
  const base = await client.head();
  const parsed = parsePlan(planPath, content);
  const materialStore = buildMaterialStore({
    plan: parsed,
    planPath,
    repoRoot: root,
  });
  const compiled = compileExecutionPlan(
    {
      version: 1,
      tasks: ["first", "second"].map((id, index) => ({
        id,
        planIndex: index + 1,
        title: `${index ? "Second" : "First"} task`,
        dependsOn: index && !options?.parallel ? ["first"] : [],
        compiledContract: {
          objective: `Implement ${id}.`,
          inScope: ["Required behavior"],
          acceptanceCriteria: ["Behavior works"],
          outOfScope: ["Unrelated work"],
        },
      })),
      workstreams: [
        { id: first.id, taskIds: ["first"] },
        { id: "second-stream", taskIds: ["second"] },
      ],
    },
    {
      plan: parsed,
      planHash: sha256(content),
      materialStore,
      checkoutId: await client.checkoutIdentity(),
      baseSha: base,
      workerConcurrency: options?.parallel ? 2 : 1,
    },
  );
  if (!compiled.ok) {
    throw new Error(compiled.reason);
  }
  const lease = await acquireCheckoutLease({
    checkoutRoot: root,
    runId: "run-1",
    timeoutMs: 1000,
  });
  leases.push(lease);
  const store = createPlanningRun({
    lease,
    runId: "run-1",
    checkout: {
      root,
      gitDir: await client.checkoutIdentity(),
      commonGitDir: await client.checkoutIdentity(),
      branchRef: "refs/heads/main",
      startHead: base,
    },
    source: sourceIdentityForExecutionPlan(compiled.value),
    workerConcurrency: options?.parallel ? 2 : 1,
  });
  writeSourceCorpus(dirname(store.path), materialStore, compiled.value);
  await store.bindExecutionPlan(compiled.value);
  return { root, client, base, store, lease, plan: compiled.value };
}
async function fail(store: RunStore) {
  await apply(store, {
    kind: "failure_requested",
    category: "interrupted",
    reason: "Interrupted execution",
    now,
  });
  for (const lease of Object.values(store.read().processLeases)) {
    await apply(store, { kind: "process_abandoned", leaseId: lease.id });
  }
  await apply(store, { kind: "run_failed" });
}
async function publication(
  setup: Awaited<ReturnType<typeof fixture>>,
  beforeReconciliation?: () => Promise<void>,
) {
  const { store, client, base } = setup;
  const [implementation] = await apply(store, {
    kind: "workstreams_selected",
    now,
    baseShas: { [first.id]: base, "second-stream": base },
  });
  if (implementation?.kind !== "run_implementation") {
    throw new Error("No implementation");
  }
  const workspace = join(store.lease.paths.worktrees, "run-1", "g0", first.id);
  await client.createTaskBranch(`pipkin/implement/run-1/g0/${first.id}`, base);
  await client.addWorktree(workspace, `pipkin/implement/run-1/g0/${first.id}`);
  writeFileSync(join(workspace, "app.txt"), "first delivered\n");
  git(workspace, "add", "app.txt");
  git(workspace, "commit", "-qm", "feat: first");
  const candidate = {
    id: "first-candidate",
    workstream: first,
    baseSha: base,
    commitSha: git(workspace, "rev-parse", "HEAD"),
    treeSha: git(workspace, "rev-parse", "HEAD^{tree}"),
  };
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
      completion: { findings: [], publicationCommitSubject: "feat: first" },
      evidence: "Candidate reviewed",
    },
  });
  await beforeReconciliation?.();
  const [reconciliation] = await apply(store, {
    kind: "reconciliation_requested",
    workstream: first,
    now,
  });
  if (reconciliation?.kind !== "run_reconciliation") {
    throw new Error("No reconciliation");
  }
  const replay = await new CandidateReplayEngine({
    git: client,
    worktreesRoot: join(store.lease.paths.worktrees, "run-1"),
    runId: "run-1",
    operationId: reconciliation.leaseId,
    protectedPaths: Object.keys(store.read().protectedArtifactHashes),
    protectedArtifactsMatch: () => protectedArtifactsMatch(store.read()),
  }).prepare(candidate, "feat: first");
  if (replay.kind !== "prepared") {
    throw new Error(`Replay ${JSON.stringify(replay)}`);
  }
  const preparation = publicationPreparation(
    {
      runId: "run-1",
      operationId: reconciliation.leaseId,
      candidate,
      disposition: replay.disposition,
      targetRef: "refs/heads/main",
      hookEvidence: "Ordinary Git hooks passed",
      hookCommand: {
        command: "git commit",
        cwd: replay.staging.worktreePath,
        exitCode: 0,
        timedOut: false,
        output: "committed",
      },
    },
    replay.staging,
  );
  const publisher = new WriteAheadPublisher({
    git: client,
    checkoutRoot: setup.root,
    checkoutIdentity: await client.checkoutIdentity(),
    protectedPaths: Object.keys(store.read().protectedArtifactHashes),
    hooks: {
      afterRefUpdate() {
        throw new Error("crash after CAS");
      },
    },
  });
  const intent = {
    ...publisher.createIntent({
      id: publicationIntentId({
        runId: "run-1",
        operationId: reconciliation.leaseId,
        preparation,
      }),
      candidateId: candidate.id,
      targetBaseSha: base,
      preparedCommitSha: preparation.preparedCommitSha,
      preparedTreeSha: preparation.preparedTreeSha,
      targetRef: preparation.targetRef,
    }),
    operationId: reconciliation.leaseId,
    workstream: first,
    preparationId: preparation.id,
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
  await apply(store, {
    kind: "reconciliation_completed",
    workstream: first,
    leaseId: reconciliation.leaseId,
    outcome: {
      kind: "prepared",
      evidence: "Prepared exact replay",
      workspace: {
        id: replay.staging.id,
        checkpoint: preparation.preparedCommitSha,
        changedPaths: preparation.changedPaths,
        stateEvidence: "prepared",
        targetSha: base,
        stagingComparison: {
          baseSha: base,
          treeSha: preparation.preparedTreeSha,
        },
      },
    },
  });
  return { publisher, intent, workspace };
}
async function failedReplayFixture() {
  const setup = await fixture({ parallel: true });
  const { store, client, base } = setup;
  const second = { kind: "source" as const, id: "second-stream" };
  const workspace = join(store.lease.paths.worktrees, "run-1", "g0", second.id);
  let candidate!: RunState["candidates"][string];
  const pending = await publication(setup, async () => {
    const implementation = Object.values(store.read().processLeases).find(
      (lease) =>
        lease.kind === "implementation" &&
        lease.workstream?.kind === "source" &&
        lease.workstream.id === second.id,
    )!;
    const branch = `pipkin/implement/run-1/g0/${second.id}`;
    await client.createTaskBranch(branch, base);
    await client.addWorktree(workspace, branch);
    writeFileSync(join(workspace, "app.txt"), "second unpublished\n");
    git(workspace, "add", "app.txt");
    git(workspace, "commit", "-qm", "feat: second candidate");
    candidate = {
      id: "second-candidate",
      workstream: second,
      baseSha: base,
      commitSha: git(workspace, "rev-parse", "HEAD"),
      treeSha: git(workspace, "rev-parse", "HEAD^{tree}"),
    };
    await apply(store, {
      kind: "implementation_completed",
      workstream: second,
      leaseId: implementation.id,
      outcome: {
        kind: "candidate_ready",
        candidate,
        checkpoints: { second: candidate.commitSha },
        satisfied: {},
      },
    });
    const [review] = await apply(store, {
      kind: "review_requested",
      workstream: second,
      now,
    });
    if (review?.kind !== "run_review") {
      throw new Error("No second review");
    }
    await apply(store, {
      kind: "review_completed",
      workstream: second,
      leaseId: review.leaseId,
      outcome: {
        kind: "initial",
        candidateId: candidate.id,
        completion: { findings: [], publicationCommitSubject: "feat: second" },
        evidence: "Second candidate reviewed",
      },
    });
  });
  await expect(pending.publisher.publish(pending.intent)).rejects.toThrow(
    "crash after CAS",
  );
  const recoveredPublication = await pending.publisher.recover(pending.intent);
  if (recoveredPublication.kind !== "published") {
    throw new Error("First publication did not land");
  }
  const publicationLease = Object.values(store.read().processLeases).find(
    (lease) => lease.publicationIntentId === pending.intent.id,
  );
  if (!publicationLease) {
    throw new Error("No publication");
  }
  const publishing = { leaseId: publicationLease.id };
  await apply(store, {
    kind: "publication_receipt_recorded",
    operationId: publishing.leaseId,
    receipt: {
      ...recoveredPublication.receipt,
      operationId: publishing.leaseId,
    },
  });
  await apply(store, {
    kind: "publication_completed",
    workstream: first,
    leaseId: publishing.leaseId,
    intentId: pending.intent.id,
    projectionDebt: {
      ...createCheckboxProjectionIntent({
        id: "first-projection",
        checkoutRoot: setup.root,
        taskIds: ["first"],
        checkboxes: [setup.plan.tasks[0]!.sourceAnchor],
      }),
      reason: "First delivered",
      artifactPath: setup.plan.tasks[0]!.sourceAnchor.path,
    },
  });
  await settleProjectionTransactions({ store });
  const [reconciliation] = await apply(store, {
    kind: "reconciliation_requested",
    workstream: second,
    now,
  });
  if (reconciliation?.kind !== "run_reconciliation") {
    throw new Error("No replay");
  }
  const replay = await new CandidateReplayEngine({
    git: client,
    worktreesRoot: join(store.lease.paths.worktrees, "run-1"),
    runId: "run-1",
    operationId: reconciliation.leaseId,
    protectedPaths: Object.keys(store.read().protectedArtifactHashes),
    protectedArtifactsMatch: () => protectedArtifactsMatch(store.read()),
  }).prepare(candidate, "feat: second");
  if (replay.kind !== "reconciliation_required" || replay.hookMutated) {
    throw new Error(`Expected failed replay: ${JSON.stringify(replay)}`);
  }
  const staging = replay.staging;
  const paths = {
    candidate: staging.candidatePaths,
    target: staging.targetPaths,
    replay: staging.replayPaths ?? [],
  };
  await apply(store, {
    kind: "reconciliation_completed",
    workstream: second,
    leaseId: reconciliation.leaseId,
    outcome: {
      kind: "reconciliation_required",
      evidence: replay.evidence,
      workspace: {
        id: staging.id,
        changedPaths: paths.replay,
        stateEvidence: replay.evidence,
        targetSha: staging.targetBaseSha,
      },
      failedReplay: {
        candidateCommitSha: candidate.commitSha,
        candidateTreeSha: candidate.treeSha,
        targetSha: staging.targetBaseSha,
        targetTreeSha: staging.targetTreeSha,
        disposition: replay.disposition,
        paths,
        staging: {
          id: staging.id,
          operationId: staging.operationId,
          branchName: staging.branchName,
          targetRef: staging.targetRef,
        },
        evidence: replay.evidence,
      },
    },
  });
  await fail(store);
  await setup.lease.release();
  return { ...setup, pending, staging, workspace };
}

async function select(setup: Awaited<ReturnType<typeof fixture>>) {
  const session = await openResume({
    checkoutRoot: setup.root,
    runId: "run-1",
  });
  leases.push({ release: session.release });
  return session;
}

function menu(root: string, choices: string[], confirmed: boolean) {
  let handler!: (input: string, ctx: any) => Promise<void>;
  const events = new Map<string, (event: unknown, ctx: any) => unknown>();
  const menus: string[][] = [];
  const notices: string[] = [];
  const handoffs: Array<{ text: string }> = [];
  const input = vi.fn();
  const confirm = vi.fn(async (_title: string, _message: string) => confirmed);
  const pi = {
    events: { emit() {} },
    setSessionName() {},
    on(name: string, listener: (event: unknown, ctx: any) => unknown) {
      events.set(name, listener);
    },
    registerCommand(name: string, command: { handler: typeof handler }) {
      expect(name).toBe("implement");
      handler = command.handler;
    },
    appendEntry(_type: string, entry: { text: string }) {
      handoffs.push(entry);
    },
  };
  const ctx = {
    cwd: root,
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    ui: {
      input,
      confirm,
      notify(message: string) {
        notices.push(message);
      },
      select: async (_title: string, options: string[]) => {
        menus.push(options);
        return choices.shift();
      },
    },
  };
  registerImplementCommand(
    pi as never,
    {
      path: "/config",
      issues: [],
      config: {
        models: {
          medium: { model: "test/medium", thinking: "medium" },
          high: { model: "test/high", thinking: "high" },
        },
        implement: { workerConcurrency: 3 },
      },
    } as never,
  );
  return {
    invoke: (input = "") => handler(input, ctx),
    menus,
    notices,
    handoffs,
    input,
    confirm,
    events,
    ctx,
  };
}

describe("recoverable Resume", () => {
  it("recovers retained pre-launch stopping after confirmation in the same activated generation", async () => {
    const setup = await fixture();
    await fail(setup.store);
    await setup.lease.release();
    const initial = await select(setup);
    const activated = await initial.confirm();
    const allowance = activated.store.read();
    await apply(activated.store, {
      kind: "failure_requested",
      category: "runtime",
      reason: "Startup interrupted before failure settlement",
      now,
    });
    expect(activated.store.read().phase).toBe("stopping");
    expect(activated.store.read().processLeases).toEqual({});
    expect(activated.store.read().executionStartedAt).toBeUndefined();
    const failure = activated.store.read().failure;
    await activated.lease.release();
    const before = readFileSync(setup.store.path, "utf-8");
    const cancelled = await select(setup);
    expect(cancelled.preview.startupRecovery).toBe(true);
    await cancelled.release();
    expect(readFileSync(setup.store.path, "utf-8")).toBe(before);
    const session = await select(setup);
    const recovered = await session.confirm();
    const state = recovered.store.read();
    expect(state.phase).toBe("running");
    expect(state.generation).toBe(allowance.generation);
    expect(state.activatedRestart).toEqual(allowance.activatedRestart);
    expect(state.generationHistory).toEqual(allowance.generationHistory);
    expect(state.operationalRetries).toEqual(allowance.operationalRetries);
    expect(state.startupRecoveries[0]?.failure).toEqual(failure);
    const executeEffect = vi.fn(
      async ({ effect, dispatch, markExecutionStarted }) => {
        expect(effect.kind).toBe("run_implementation");
        expect(effect.workstream).toEqual(first);
        await markExecutionStarted();
        await dispatch({
          kind: "failure_requested",
          category: "runtime",
          reason: "Ordinary unfinished source execution began",
          now,
        });
      },
    );
    const actor = new SchedulerActor({ store: recovered.store, executeEffect });
    await actor.start();
    await actor.settle();
    expect(executeEffect).toHaveBeenCalledTimes(1);
    expect(recovered.store.read().executionStartedAt).toBeDefined();
  });

  it("retires recorded failed-replay staging across interrupted preparation and rebuilds only unfinished work from the trusted target", async () => {
    const setup = await failedReplayFixture();
    const before = readFileSync(setup.store.path, "utf-8");
    const stagingStatus = git(
      setup.staging.worktreePath,
      "status",
      "--porcelain",
    );
    const stagingContent = readFileSync(
      join(setup.staging.worktreePath, "app.txt"),
      "utf-8",
    );
    const stagingIndex = git(setup.staging.worktreePath, "ls-files", "--stage");
    const cancelled = await select(setup);
    expect(cancelled.preview.preservedSourceIds).toEqual([first.id]);
    expect(cancelled.preview.resources).toContainEqual(
      expect.objectContaining({
        id: setup.staging.id,
        path: setup.staging.worktreePath,
        branch: setup.staging.branchName,
        candidateId: "second-candidate",
      }),
    );
    await cancelled.release();
    expect(readFileSync(setup.store.path, "utf-8")).toBe(before);
    expect(git(setup.staging.worktreePath, "status", "--porcelain")).toBe(
      stagingStatus,
    );
    expect(
      readFileSync(join(setup.staging.worktreePath, "app.txt"), "utf-8"),
    ).toBe(stagingContent);
    expect(git(setup.staging.worktreePath, "ls-files", "--stage")).toBe(
      stagingIndex,
    );
    const session = await select(setup);
    const deleteTaskBranch = ExecGitClient.prototype.deleteTaskBranch;
    const removeBranch = vi
      .spyOn(ExecGitClient.prototype, "deleteTaskBranch")
      .mockImplementation(async function (this: ExecGitClient, branch) {
        if (branch === setup.staging.branchName) {
          throw new Error("staging retirement interrupted");
        }
        await deleteTaskBranch.call(this, branch);
      });
    await expect(session.confirm()).rejects.toThrow(
      "staging retirement interrupted",
    );
    const blocked = loadRunState(setup.store.path);
    expect(blocked.restartPreparation?.generation).toBe(1);
    expect(blocked.tasks.first?.phase).toBe("published");
    expect(existsSync(setup.staging.worktreePath)).toBe(false);
    expect(
      await setup.client.branchTip(setup.staging.branchName),
    ).toBeDefined();
    await session.release();
    removeBranch.mockRestore();
    const retry = await select(setup);
    expect(retry.preview.generation).toBe(1);
    const resumed = await retry.confirm();
    expect(resumed.store.read().generationHistory).toHaveLength(1);
    expect(
      await setup.client.branchTip(setup.staging.branchName),
    ).toBeUndefined();
    expect(resumed.store.read().executionTarget).toBe(
      setup.pending.intent.preparedCommitSha,
    );
    expect(existsSync(setup.pending.workspace)).toBe(true);
    expect(
      resumed.store.read().generationHistory[0]?.reconciliationAssignments,
    ).toEqual(blocked.reconciliationAssignments);
    const workers = new ScriptedSubagentClient(
      [
        {
          status: "completed",
          result: {
            outcome: "changed",
            summary: "Second delivered",
            verification: [
              {
                kind: "inspection",
                label: "Second behavior",
                evidence: "Implemented",
              },
            ],
          },
        },
        {
          status: "completed",
          result: { findings: [], publicationCommitSubject: "feat: second" },
        },
        {
          status: "completed",
          result: {
            findings: [],
            assessments: [],
            handoffDraft: "Both lanes reviewed",
          },
        },
      ],
      [setup.root],
    );
    const spawn = workers.spawn.bind(workers);
    vi.spyOn(workers, "spawn").mockImplementation((async (args) => {
      if (args.role === "implementer") {
        expect(args.cwd).toContain("/g1/second-stream");
        expect(git(args.cwd!, "rev-parse", "HEAD")).toBe(
          setup.pending.intent.preparedCommitSha,
        );
        writeFileSync(join(args.cwd!, "second.txt"), "second delivered\n");
        git(args.cwd!, "add", "second.txt");
        git(args.cwd!, "commit", "-qm", "feat: second");
      }
      return spawn(args);
    }) as typeof workers.spawn);
    const actor = createRuntime({
      ...resumed,
      pi: {} as never,
      ctx: { ui: { notify() {} } } as never,
      roles,
      checkoutIdentity: await setup.client.checkoutIdentity(),
      baseSha: resumed.store.read().executionTarget,
      subagents: workers,
    });
    await actor.start();
    await actor.settle();
    expect(
      resumed.store.read().phase,
      resumed.store.read().failure?.reason,
    ).toBe("completed");
    expect(
      workers.invocations
        .filter((worker) => worker.role === "implementer")
        .map((worker) => worker.taskId),
    ).toEqual(["second-stream"]);
    expect(Object.keys(resumed.store.read().publication.receipts)).toHaveLength(
      2,
    );
    expect(readFileSync(join(setup.root, "app.txt"), "utf-8")).toBe(
      "first delivered\n",
    );
    expect(workers.invocations.at(-1)?.prompt).toContain("First task");
  }, 30_000);

  it("refuses missing or conflicting failed-replay ownership, lookalikes and staging symlink escapes without deleting delivery", async () => {
    const setup = await failedReplayFixture();
    const state = setup.store.read();
    const assignment = Object.values(state.reconciliationAssignments)[0]!;
    const inventory = (state: RunState) =>
      inventoryResumeResources({
        state,
        git: setup.client,
        root: join(setup.store.lease.paths.worktrees, "run-1"),
        preservedSourceIds: [first.id],
        deliveredCandidateIds: new Set(["first-candidate"]),
      });
    const missing = structuredClone(state);
    missing.reconciliationAssignments = {};
    await expect(inventory(missing)).rejects.toThrow(/durable ownership/);
    const conflicting = structuredClone(state);
    conflicting.reconciliationAssignments[assignment.id]!.staging.branchName +=
      "-lookalike";
    await expect(inventory(conflicting)).rejects.toThrow(
      /exact reconciliation staging ownership/,
    );
    const missingOperation = structuredClone(state);
    delete missingOperation.operationSettlements[assignment.operationId];
    await expect(inventory(missingOperation)).rejects.toThrow(
      /exact reconciliation staging ownership/,
    );
    const lookalike = `${setup.staging.branchName}-lookalike`;
    await setup.client.createTaskBranch(
      lookalike,
      setup.pending.intent.preparedCommitSha,
    );
    await expect(select(setup)).rejects.toThrow(/durable ownership of branch/);
    await setup.client.deleteTaskBranch(lookalike);
    const before = readFileSync(setup.store.path, "utf-8");
    const externalRoot = realpathSync(
      mkdtempSync(join(tmpdir(), "pipkin-staging-")),
    );
    roots.push(externalRoot);
    const outside = join(externalRoot, "escaped-staging");
    renameSync(setup.staging.worktreePath, outside);
    symlinkSync(outside, setup.staging.worktreePath);
    await expect(select(setup)).rejects.toThrow(/symlinked path/);
    rmSync(setup.staging.worktreePath);
    renameSync(outside, setup.staging.worktreePath);
    expect(readFileSync(setup.store.path, "utf-8")).toBe(before);
    expect(existsSync(setup.pending.workspace)).toBe(true);
    expect(existsSync(setup.staging.worktreePath)).toBe(true);
    const protectedState = structuredClone(state);
    protectedState.generationHistory.push({
      generation: state.generation,
      executionTarget: state.executionTarget,
      phase: state.phase,
      workstreams: state.workstreams,
      tasks: state.tasks,
      operationIds: Object.keys(state.operationSettlements),
      failureIds: Object.keys(state.failures),
      candidateIds: Object.keys(state.candidates),
      reviews: state.reviews,
      revisionAssignments: state.revisionAssignments,
      operationalRetries: state.operationalRetries,
      workspaceRecreations: state.workspaceRecreations,
      reconciliationAssignments: state.reconciliationAssignments,
      wholePlanReview: state.wholePlanReview,
      failure: state.failure,
    });
    protectedState.generation = 1;
    protectedState.reconciliationAssignments = {};
    // Historical resources are recognized, but never reauthorized for disposal.
    expect(await inventory(protectedState)).toEqual([]);
  });

  it("observes a landed CAS without mutation, then establishes delivery and rebuilds only the unfinished lane through normal runtime", async () => {
    const setup = await fixture();
    const pending = await publication(setup);
    await expect(pending.publisher.publish(pending.intent)).rejects.toThrow(
      "crash after CAS",
    );
    await fail(setup.store);
    await setup.lease.release();
    const before = readFileSync(setup.store.path, "utf-8");
    const status = git(setup.root, "status", "--porcelain");
    const cancelled = await select(setup);
    expect(cancelled.preview.preservedSourceIds).toEqual([first.id]);
    expect(cancelled.preview.discardedSourceIds).toEqual(["second-stream"]);
    await cancelled.release();
    expect(readFileSync(setup.store.path, "utf-8")).toBe(before);
    expect(git(setup.root, "status", "--porcelain")).toBe(status);
    expect(readFileSync(join(setup.root, "app.txt"), "utf-8")).toBe("base\n");
    const confirmed = await select(setup);
    const prepared = await confirmed.confirm();
    expect(prepared.store.read().tasks.first?.phase).toBe("published");
    expect(prepared.store.read().workstreams.source[first.id]?.phase).toBe(
      "completed",
    );
    expect(readFileSync(join(setup.root, "plan.md"), "utf-8")).toContain(
      "- [x] First",
    );
    expect(prepared.store.read().run.checkout.startHead).toBe(setup.base);
    expect(prepared.store.read().executionPlan).toEqual(
      setup.store.read().executionPlan,
    );
    await prepared.lease.release();
    const startup = await select(setup);
    expect(startup.preview.startupRecovery).toBe(true);
    const recovered = await startup.confirm();
    expect(recovered.store.read().generation).toBe(1);
    const second = { kind: "source" as const, id: "second-stream" };
    const [implementation] = await apply(recovered.store, {
      kind: "workstreams_selected",
      now,
      baseShas: { [second.id]: recovered.store.read().executionTarget },
    });
    if (implementation?.kind !== "run_implementation") {
      throw new Error("No second implementation");
    }
    await recovered.store.update(recovered.store.read().revision, (state) => ({
      ...state,
      executionStartedAt: now,
    }));
    const discardedWorkspace = join(
      recovered.lease.paths.worktrees,
      "run-1",
      "g1",
      second.id,
    );
    const discardedBranch = `pipkin/implement/run-1/g1/${second.id}`;
    await setup.client.createTaskBranch(
      discardedBranch,
      recovered.store.read().executionTarget,
    );
    await setup.client.addWorktree(discardedWorkspace, discardedBranch);
    writeFileSync(
      join(discardedWorkspace, "second.txt"),
      "unpublished candidate\n",
    );
    git(discardedWorkspace, "add", "second.txt");
    git(discardedWorkspace, "commit", "-qm", "feat: candidate second");
    const candidate = {
      id: "second-candidate",
      workstream: second,
      baseSha: recovered.store.read().executionTarget,
      commitSha: git(discardedWorkspace, "rev-parse", "HEAD"),
      treeSha: git(discardedWorkspace, "rev-parse", "HEAD^{tree}"),
    };
    await apply(recovered.store, {
      kind: "implementation_completed",
      workstream: second,
      leaseId: implementation.leaseId,
      outcome: {
        kind: "candidate_ready",
        candidate,
        checkpoints: { second: candidate.commitSha },
        satisfied: {},
      },
    });
    const [review] = await apply(recovered.store, {
      kind: "review_requested",
      workstream: second,
      now,
    });
    if (review?.kind !== "run_review") {
      throw new Error("No second review");
    }
    await apply(recovered.store, {
      kind: "review_completed",
      workstream: second,
      leaseId: review.leaseId,
      outcome: {
        kind: "initial",
        candidateId: candidate.id,
        completion: {
          findings: [
            {
              summary: "Second behavior missing",
              evidence: "Unpublished candidate has no second behavior",
              requiredChange: "Deliver the second behavior",
              acceptanceCriteria: ["Second behavior works"],
            },
          ],
          publicationCommitSubject: "feat: second",
        },
        evidence: "Second candidate reviewed",
      },
    });
    await fail(recovered.store);
    const findingId = Object.keys(recovered.store.read().findings)[0]!;
    await recovered.lease.release();
    const successor = await select(setup);
    expect(successor.preview.preservedSourceIds).toEqual([first.id]);
    const finalRun = await successor.confirm();
    expect(finalRun.store.read().generation).toBe(2);
    expect(existsSync(discardedWorkspace)).toBe(false);
    const workers = new ScriptedSubagentClient(
      [
        {
          status: "completed",
          result: {
            outcome: "changed",
            summary: "Second delivered",
            verification: [
              {
                kind: "inspection",
                label: "Behavior",
                evidence: "Observed second behavior",
              },
            ],
          },
        },
        {
          status: "completed",
          result: {
            findings: [],
            assessments: [
              {
                id: findingId,
                status: "resolved",
                evidence: "Fresh candidate now supplies the second behavior",
              },
            ],
            publicationCommitSubject: "feat: second",
          },
        },
        {
          status: "completed",
          result: {
            findings: [],
            assessments: [],
            handoffDraft: "Both original lanes reviewed.",
          },
        },
      ],
      [setup.root],
    );
    const spawn = workers.spawn.bind(workers);
    vi.spyOn(workers, "spawn").mockImplementation((async (args) => {
      if (args.role === "implementer") {
        expect(args.cwd).toContain("/g2/second-stream");
        expect(git(args.cwd!, "rev-parse", "HEAD")).toBe(
          pending.intent.preparedCommitSha,
        );
        expect(args.prompt).toContain(findingId);
        writeFileSync(
          join(args.cwd!, "second.txt"),
          "second behavior delivered\n",
        );
        git(args.cwd!, "add", "second.txt");
        git(args.cwd!, "commit", "-qm", "feat: second");
      }
      return spawn(args);
    }) as typeof workers.spawn);
    const actor = createRuntime({
      ...finalRun,
      pi: {} as never,
      ctx: { ui: { notify() {} } } as never,
      roles,
      checkoutIdentity: await setup.client.checkoutIdentity(),
      baseSha: finalRun.store.read().executionTarget,
      subagents: workers,
    });
    await actor.start();
    await actor.settle();
    const state = finalRun.store.read();
    expect(state.phase, state.failure?.reason).toBe("completed");
    expect(
      workers.invocations
        .filter((worker) => worker.role === "implementer")
        .map((worker) => worker.taskId),
    ).toEqual(["second-stream"]);
    expect(workers.invocations.at(-1)?.prompt).toContain("First task");
    expect(workers.invocations.at(-1)?.prompt).toContain("Second task");
    expect(Object.keys(state.publication.receipts)).toHaveLength(2);
    expect(
      state.publication.receipts[pending.intent.id]?.publishedCommitSha,
    ).toBe(pending.intent.preparedCommitSha);
    expect(readFileSync(join(setup.root, "app.txt"), "utf-8")).toBe(
      "first delivered\n",
    );
    expect(readFileSync(join(setup.root, "second.txt"), "utf-8")).toBe(
      "second behavior delivered\n",
    );
    expect(state.findings[findingId]?.status).toBe("resolved");
    expect(existsSync(pending.workspace)).toBe(true);
  }, 30_000);

  it("accepts only the exact pending projection side and continues preparation after a post-write persistence failure", async () => {
    const setup = await fixture();
    const pending = await publication(setup);
    await expect(pending.publisher.publish(pending.intent)).rejects.toThrow(
      "crash after CAS",
    );
    await fail(setup.store);
    await setup.lease.release();
    const session = await select(setup);
    vi.spyOn(RunStore.prototype, "recordProjection").mockRejectedValueOnce(
      new Error("projection persistence interrupted"),
    );
    await expect(session.confirm()).rejects.toThrow(
      "projection persistence interrupted",
    );
    await session.release();
    const blocked = loadRunState(setup.store.path);
    expect(blocked.restartPreparation?.progress.transactionsSettled).toBe(true);
    expect(blocked.restartPreparation?.progress.projectionSettled).toBe(false);
    const content = readFileSync(join(setup.root, "plan.md"), "utf-8");
    expect(content).toContain("- [x] First task");
    const cancelled = await select(setup);
    await cancelled.release();
    expect(loadRunState(setup.store.path).revision).toBe(blocked.revision);
    writeFileSync(
      join(setup.root, "plan.md"),
      content.replace("- [ ] Second", "- [x] Second"),
    );
    await expect(select(setup)).rejects.toThrow(/source or protected/);
    writeFileSync(join(setup.root, "plan.md"), content);
    const retry = await select(setup);
    const resumed = await retry.confirm();
    expect(resumed.store.read().generation).toBe(1);
    expect(resumed.store.read().projectionDebt).toEqual([]);
    expect(Object.keys(resumed.store.read().publication.receipts)).toEqual([
      pending.intent.id,
    ]);
    expect(await setup.client.head()).toBe(pending.intent.preparedCommitSha);
  });

  it("abandons an unlanded intent and recovers interrupted dirty-resource cleanup with one reserved successor", async () => {
    const setup = await fixture();
    const pending = await publication(setup);
    writeFileSync(
      join(pending.workspace, "unfinished.txt"),
      "unfinished changes\n",
    );
    await fail(setup.store);
    await setup.lease.release();
    const session = await select(setup);
    expect(session.preview.preservedSourceIds).toEqual([]);
    expect(session.preview.resources.map((item) => item.path)).toContain(
      pending.workspace,
    );
    const removeBranch = vi
      .spyOn(ExecGitClient.prototype, "deleteTaskBranch")
      .mockRejectedValueOnce(new Error("cleanup interrupted"));
    await expect(session.confirm()).rejects.toThrow("cleanup interrupted");
    expect(existsSync(pending.workspace)).toBe(false);
    const blocked = loadRunState(setup.store.path);
    expect(blocked.restartPreparation?.generation).toBe(1);
    expect(blocked.restartPreparation?.blockers).toEqual([
      "cleanup interrupted",
    ]);
    expect(blocked.publication.abandonments[pending.intent.id]).toBeDefined();
    expect(await setup.client.head()).toBe(setup.base);
    await session.release();
    removeBranch.mockRestore();
    const remaining = blocked.restartPreparation!.resources.find(
      (resource) => resource.path === pending.workspace,
    )!;
    const expectedHead = JSON.parse(remaining.ownershipEvidence).head as string;
    git(setup.root, "update-ref", `refs/heads/${remaining.branch}`, setup.base);
    await expect(select(setup)).rejects.toThrow(
      /branch changed after confirmation/,
    );
    expect(loadRunState(setup.store.path).restartPreparation?.generation).toBe(
      1,
    );
    git(
      setup.root,
      "update-ref",
      `refs/heads/${remaining.branch}`,
      expectedHead,
    );
    const retry = await select(setup);
    const result = await retry.confirm();
    expect(result.store.read().generation).toBe(1);
    expect(
      result.store
        .read()
        .activatedRestart?.resources.every((item) => item.status === "retired"),
    ).toBe(true);
    expect(existsSync(dirname(setup.store.path))).toBe(true);
    expect(await setup.client.head()).toBe(setup.base);
    expect(Object.keys(result.store.read().publication.receipts)).toHaveLength(
      0,
    );
  });

  it("keeps completed preparation recoverable after activation failure", async () => {
    const setup = await fixture();
    await fail(setup.store);
    await setup.lease.release();
    const session = await select(setup);
    vi.spyOn(RunStore.prototype, "activateRestart").mockRejectedValueOnce(
      new Error("activation interrupted"),
    );
    await expect(session.confirm()).rejects.toThrow("activation interrupted");
    expect(
      loadRunState(setup.store.path).restartPreparation?.progress
        .targetValidated,
    ).toBe(true);
    await session.release();
    const next = await select(setup);
    const prepared = await next.confirm();
    expect(prepared.store.read().generation).toBe(1);
    expect(prepared.store.read().generationHistory).toHaveLength(1);
  });

  it("refuses unsafe target and plan changes, foreign repositories, and unowned or symlink-escaped work without mutation", async () => {
    const setup = await fixture();
    const pending = await publication(setup);
    await fail(setup.store);
    await setup.lease.release();
    const original = readFileSync(setup.store.path, "utf-8");
    const foreign = realpathSync(
      mkdtempSync(join(tmpdir(), "pipkin-foreign-")),
    );
    roots.push(foreign);
    git(setup.root, "clone", "--quiet", "--no-local", setup.root, foreign);
    git(
      foreign,
      "checkout",
      "-q",
      "-b",
      git(pending.workspace, "branch", "--show-current"),
      git(pending.workspace, "rev-parse", "HEAD"),
    );
    const gitFile = join(pending.workspace, ".git");
    const registration = readFileSync(gitFile, "utf-8");
    writeFileSync(gitFile, `gitdir: ${join(foreign, ".git")}\n`);
    await expect(select(setup)).rejects.toThrow(/another repository/);
    expect(existsSync(gitFile)).toBe(true);
    writeFileSync(gitFile, registration);
    const plan = join(setup.root, "plan.md");
    const content = readFileSync(plan, "utf-8");
    writeFileSync(plan, content.replace("First task", "Edited task"));
    await expect(select(setup)).rejects.toThrow(/source or protected/);
    writeFileSync(plan, content);
    writeFileSync(join(setup.root, "user.txt"), "user data");
    await expect(select(setup)).rejects.toThrow(/dirty/);
    rmSync(join(setup.root, "user.txt"));
    git(setup.root, "commit", "--allow-empty", "-qm", "chore: manual change");
    await expect(select(setup)).rejects.toThrow(/exact trusted target/);
    git(setup.root, "reset", "--hard", setup.base);
    const escaped = join(setup.root, "outside");
    await setup.client.removeWorktree(pending.workspace);
    symlinkSync(escaped, pending.workspace);
    await expect(select(setup)).rejects.toThrow(/symlink/);
    rmSync(pending.workspace);
    const unowned = join(setup.lease.paths.worktrees, "run-1", "g0", "unowned");
    const unownedBranch = "pipkin/implement/run-1/g0/unowned";
    await setup.client.createTaskBranch(unownedBranch, setup.base);
    await setup.client.addWorktree(unowned, unownedBranch);
    writeFileSync(join(unowned, "user.txt"), "unowned changes");
    await expect(select(setup)).rejects.toThrow(/durable ownership/);
    expect(readFileSync(join(unowned, "user.txt"), "utf-8")).toBe(
      "unowned changes",
    );
    expect(readFileSync(setup.store.path, "utf-8")).toBe(original);
  });

  it("builds the menu without workspace preflight and cancellation leaves retained state unchanged without asking for a plan", async () => {
    const setup = await fixture();
    await fail(setup.store);
    await setup.lease.release();
    const before = readFileSync(setup.store.path, "utf-8");
    const inspect = vi.spyOn(ExecGitClient.prototype, "listWorktrees");
    const lazy = menu(setup.root, ["run-1 · failed", "Back", "Close"], false);
    await lazy.invoke();
    expect(lazy.menus[1]).toEqual(["Details", "Resume", "Clean up", "Back"]);
    expect(inspect).not.toHaveBeenCalled();
    const declined = menu(setup.root, ["run-1 · failed", "Resume"], false);
    await declined.invoke();
    expect(declined.confirm).toHaveBeenCalledWith(
      "Resume",
      expect.stringContaining("Confirm disposal of unfinished changes"),
    );
    expect(declined.input).not.toHaveBeenCalled();
    expect(readFileSync(setup.store.path, "utf-8")).toBe(before);
    const next = await select(setup);
    await next.release();
  });

  it("transfers a settled same-session actor to successive generations and rejects old lifecycle callbacks", async () => {
    const setup = await fixture();
    await fail(setup.store);
    await setup.lease.release();
    const starts: Parameters<typeof runRuntime.startPreparedResume>[0][] = [];
    vi.spyOn(runRuntime, "startPreparedResume").mockImplementation(
      async (args) => {
        starts.push(args);
        const actor = {
          get isSettled() {
            return ["failed", "incomplete", "completed"].includes(
              args.prepared.store.read().phase,
            );
          },
          async settle() {},
          async stop() {
            await fail(args.prepared.store);
            args.onTransition?.(args.prepared.store.read(), {
              kind: "run_failed",
            });
          },
        };
        return {
          kind: "started",
          active: { ...args.prepared, actor: actor as never },
        };
      },
    );
    const choices = ["run-1 · failed", "Resume"];
    const surface = menu(setup.root, choices, true);
    await surface.invoke();
    const firstStart = starts[0]!;
    choices.push("run-1 · running", "Back", "Close");
    await surface.invoke();
    expect(surface.menus[3]).toEqual(["Details", "Stop", "Clean up", "Back"]);
    await firstStart.prepared.store.update(
      firstStart.prepared.store.read().revision,
      (state) => ({ ...state, executionStartedAt: now }),
    );
    await fail(firstStart.prepared.store);
    firstStart.onTransition?.(firstStart.prepared.store.read(), {
      kind: "run_failed",
    });
    choices.push("run-1 · failed", "Resume");
    await surface.invoke();
    expect(
      starts.map((start) => start.prepared.store.read().generation),
    ).toEqual([1, 2]);
    firstStart.onCompleted?.(firstStart.prepared);
    firstStart.onTransition?.(firstStart.prepared.store.read(), {
      kind: "run_failed",
    });
    const secondStart = starts[1]!;
    await secondStart.prepared.store.update(
      secondStart.prepared.store.read().revision,
      (state) => ({ ...state, executionStartedAt: now }),
    );
    await surface.invoke("stop");
    expect(
      surface.handoffs.map(
        (handoff) => handoff.text.match(/generation (\d+)/)?.[1],
      ),
    ).toEqual(["1", "2"]);
    expect(surface.input).not.toHaveBeenCalled();
    expect(starts[1]!.prepared.store.read().phase).toBe("failed");
    const reopened = await select(setup);
    await reopened.release();
  });

  it("continues blocked preparation and recovers failed startup through the menu without another generation or terminal handoff", async () => {
    const setup = await fixture();
    await fail(setup.store);
    await setup.lease.release();
    vi.spyOn(RunStore.prototype, "activateRestart").mockRejectedValueOnce(
      new Error("activation interrupted"),
    );
    const start = vi.spyOn(runRuntime, "startPreparedResume");
    start.mockImplementationOnce(async (args) => {
      await fail(args.prepared.store);
      throw new Error("startup interrupted");
    });
    start.mockImplementation(async (args) => ({
      kind: "started",
      active: {
        ...args.prepared,
        actor: {
          get isSettled() {
            return args.prepared.store.read().phase === "failed";
          },
          async settle() {},
          async stop() {
            await fail(args.prepared.store);
            args.onTransition?.(args.prepared.store.read(), {
              kind: "run_failed",
            });
          },
        } as never,
      },
    }));
    const choices = ["run-1 · failed", "Resume"];
    const surface = menu(setup.root, choices, true);
    await surface.invoke();
    expect(loadRunState(setup.store.path).restartPreparation?.generation).toBe(
      1,
    );
    expect(start).not.toHaveBeenCalled();
    choices.push("run-1 · failed", "Resume");
    await surface.invoke();
    expect(loadRunState(setup.store.path).generation).toBe(1);
    expect(loadRunState(setup.store.path).executionStartedAt).toBeUndefined();
    expect(surface.handoffs).toEqual([]);
    choices.push("run-1 · failed", "Resume");
    await surface.invoke();
    expect(surface.confirm.mock.calls.at(-1)?.[1]).toContain(
      "startup recovery",
    );
    const owned = start.mock.calls.at(-1)![0].prepared;
    expect(owned.store.read().generation).toBe(1);
    expect(owned.store.read().generationHistory).toHaveLength(1);
    expect(owned.store.read().startupRecoveries).toHaveLength(1);
    await owned.store.update(owned.store.read().revision, (state) => ({
      ...state,
      executionStartedAt: now,
    }));
    await surface.invoke("stop");
    expect(surface.handoffs).toHaveLength(1);
    expect(surface.input).not.toHaveBeenCalled();
  });

  it("recovers an activated generation's crash-retained pre-launch assignment without reserving another successor", async () => {
    const setup = await fixture();
    await fail(setup.store);
    await setup.lease.release();
    const session = await select(setup);
    const prepared = await session.confirm();
    await apply(prepared.store, {
      kind: "workstreams_selected",
      now,
      baseShas: { [first.id]: prepared.store.read().executionTarget },
    });
    await prepared.lease.release();
    const deadPid = Number(
      execFileSync(process.execPath, ["-e", "console.log(process.pid)"], {
        encoding: "utf-8",
      }).trim(),
    );
    writeFileSync(
      prepared.lease.paths.owner,
      JSON.stringify({ ...prepared.lease.owner, pid: deadPid }),
    );
    const retry = await select(setup);
    expect(retry.preview.startupRecovery).toBe(true);
    const recovered = await retry.confirm();
    expect(recovered.store.read().generation).toBe(1);
    expect(recovered.store.read().generationHistory).toHaveLength(1);
    expect(recovered.store.read().startupRecoveries).toHaveLength(1);
    expect(recovered.store.read().processLeases).toEqual({});
    expect(recovered.store.read().workstreams.source[first.id]?.phase).toBe(
      "queued",
    );
  });

  it("requires dead prior-owner proof for crash-retained execution and defers interrupted settlement until confirmation", async () => {
    const setup = await fixture();
    await apply(setup.store, {
      kind: "workstreams_selected",
      now,
      baseShas: { [first.id]: setup.base },
    });
    await setup.lease.release();
    const before = readFileSync(setup.store.path, "utf-8");
    await expect(select(setup)).rejects.toThrow(/ownership is uncertain/);
    writeFileSync(setup.lease.paths.owner, JSON.stringify(setup.lease.owner));
    await expect(select(setup)).rejects.toThrow(/live prior owner/);
    const live = menu(setup.root, ["run-1 · running", "Back", "Close"], false);
    await live.invoke();
    expect(live.menus[1]).toEqual(["Details", "Clean up", "Back"]);
    expect(live.confirm).not.toHaveBeenCalled();
    const deadPid = Number(
      execFileSync(process.execPath, ["-e", "console.log(process.pid)"], {
        encoding: "utf-8",
      }).trim(),
    );
    writeFileSync(
      setup.lease.paths.owner,
      JSON.stringify({ ...setup.lease.owner, pid: deadPid }),
    );
    const crashed = menu(setup.root, ["run-1 · running", "Resume"], false);
    await crashed.invoke();
    expect(crashed.menus[1]).toContain("Resume");
    expect(crashed.confirm).toHaveBeenCalled();
    expect(crashed.input).not.toHaveBeenCalled();
    expect(readFileSync(setup.store.path, "utf-8")).toBe(before);
    const retry = await select(setup);
    const prepared = await retry.confirm();
    expect(prepared.store.read().generation).toBe(1);
    expect(prepared.store.read().generationHistory[0]?.failure?.category).toBe(
      "interrupted",
    );
    expect(prepared.store.read().processLeases).toEqual({});
  });
});
