import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ScriptedSubagentClient } from "./e2e-test-support.js";
import { compileExecutionPlan } from "./execution-plan.js";
import { ExecGitClient } from "./git.js";
import { buildMaterialStore } from "./material-store.js";
import { parsePlan } from "./plan.js";
import { writeSourceCorpus } from "./requirements-context.js";
import { createRuntime } from "./run.js";
import { inventoryResumeResources } from "./resume-resources.js";
import { reduceRunEvent, type SchedulerEvent } from "./scheduler/scheduler.js";
import { sha256 } from "./source-integrity.js";
import {
  acquireCheckoutLease,
  createPlanningRun,
  sourceIdentityForExecutionPlan,
  type CheckoutLeaseCapability,
  type RunStore,
} from "./store.js";
import type { ImplementRoles } from "./subagents.js";

const roots: string[] = [];
const leases: CheckoutLeaseCapability[] = [];
const workstream = { kind: "source" as const, id: "format-stream" };
const now = "2026-01-01T00:00:00.000Z";
const roles = Object.fromEntries(
  ["implementer", "reviewer", "planner"].map((role) => [
    role,
    { type: `pipkin:implement:${role}`, model: "test", thinking: "high" },
  ]),
) as ImplementRoles;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
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

async function approvedRun(prepareCandidate?: (workspace: string) => void) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "pipkin-hook-recovery-")),
  );
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  const planPath = join(root, "plan.md");
  const content = "# Plan\n\n- [ ] Deliver behavior\n";
  writeFileSync(planPath, content);
  writeFileSync(join(root, "app.txt"), "base\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "chore: base");
  const client = new ExecGitClient(root);
  const baseSha = await client.head();
  const checkoutIdentity = await client.checkoutIdentity();
  const parsed = parsePlan(planPath, content);
  const materialStore = buildMaterialStore({
    plan: parsed,
    planPath,
    repoRoot: root,
  });
  const compiled = compileExecutionPlan(
    {
      version: 1,
      tasks: [
        {
          id: "deliver",
          planIndex: 1,
          title: "Deliver behavior",
          dependsOn: [],
          compiledContract: {
            objective: "Deliver behavior.",
            inScope: ["app.txt"],
            acceptanceCriteria: ["Behavior is delivered."],
            outOfScope: ["Unrelated work"],
          },
        },
      ],
      workstreams: [{ id: workstream.id, taskIds: ["deliver"] }],
    },
    {
      plan: parsed,
      planHash: sha256(content),
      materialStore,
      checkoutId: checkoutIdentity,
      baseSha,
      workerConcurrency: 1,
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
      gitDir: checkoutIdentity,
      commonGitDir: checkoutIdentity,
      branchRef: "refs/heads/main",
      startHead: baseSha,
    },
    source: sourceIdentityForExecutionPlan(compiled.value),
    workerConcurrency: 1,
  });
  writeSourceCorpus(dirname(store.path), materialStore, compiled.value);
  await store.bindExecutionPlan(compiled.value);
  const [implementation] = await apply(store, {
    kind: "workstreams_selected",
    now,
    baseShas: { [workstream.id]: baseSha },
  });
  if (implementation?.kind !== "run_implementation") {
    throw new Error("No implementation");
  }
  const branch = `pipkin/implement/run-1/g0/${workstream.id}`;
  const workspace = join(lease.paths.worktrees, "run-1", "g0", workstream.id);
  await client.createTaskBranch(branch, baseSha);
  await client.addWorktree(workspace, branch);
  writeFileSync(join(workspace, "app.txt"), "unformatted\n");
  prepareCandidate?.(workspace);
  git(workspace, "add", "-A");
  git(workspace, "commit", "-qm", "feat: candidate");
  const candidate = {
    id: "candidate:first",
    workstream,
    baseSha,
    commitSha: git(workspace, "rev-parse", "HEAD"),
    treeSha: git(workspace, "rev-parse", "HEAD^{tree}"),
  };
  await apply(store, {
    kind: "implementation_completed",
    workstream,
    leaseId: implementation.leaseId,
    outcome: {
      kind: "candidate_ready",
      candidate,
      checkpoints: { deliver: candidate.commitSha },
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
      candidateId: candidate.id,
      completion: {
        findings: [],
        publicationCommitSubject: "feat: deliver behavior",
      },
      evidence: "Candidate reviewed",
    },
  });
  return {
    root,
    client,
    baseSha,
    checkoutIdentity,
    lease,
    store,
    candidate,
    workspace,
  };
}

it("recovers a successful hook-mutated replay with its exact delta and fresh review before publication", async () => {
  const {
    root,
    client,
    baseSha,
    checkoutIdentity,
    lease,
    store,
    candidate,
    workspace,
  } = await approvedRun();
  const hook = join(root, ".git", "hooks", "pre-commit");
  writeFileSync(
    hook,
    "#!/bin/sh\nprintf 'formatted\\n' > app.txt\ngit add app.txt\n",
  );
  chmodSync(hook, 0o755);

  const workers = new ScriptedSubagentClient(
    [
      {
        status: "completed",
        result: {
          summary: "Reconciled the hook formatting delta.",
          verification: [
            {
              kind: "inspection",
              label: "Formatting",
              evidence: "Exact hook delta inspected and preserved.",
            },
          ],
        },
      },
      { status: "completed", result: { assessments: [], regressions: [] } },
      {
        status: "completed",
        result: {
          findings: [],
          assessments: [],
          handoffDraft: "Behavior delivered with reviewed formatting.",
        },
      },
    ],
    [root],
  );
  const spawn = workers.spawn.bind(workers);
  vi.spyOn(workers, "spawn").mockImplementation((async (args) => {
    const state = store.read();
    if (args.role === "implementer") {
      const replaySha = /Hook-mutated replay: ([a-f0-9]+)/.exec(
        args.prompt,
      )?.[1];
      const replayTree = /Replay tree: ([a-f0-9]+)/.exec(args.prompt)?.[1];
      const beforeTree = /Before-hook tree: ([a-f0-9]+)/.exec(args.prompt)?.[1];
      expect(replaySha).toBeDefined();
      expect(replayTree).toBeDefined();
      expect(beforeTree).toBe(candidate.treeSha);
      expect(args.cwd).toBe(workspace);
      expect(git(workspace, "rev-parse", "HEAD")).toBe(candidate.commitSha);
      const delta = git(
        workspace,
        "diff",
        beforeTree!,
        replayTree!,
        "--",
        "app.txt",
      );
      expect(delta).toContain("-unformatted");
      expect(delta).toContain("+formatted");
      expect(Object.keys(state.revisionAssignments)).toHaveLength(0);
      expect(Object.keys(state.publication.intents)).toHaveLength(0);
      expect(await client.head()).toBe(baseSha);
      const assignment = Object.values(state.reconciliationAssignments)[0]!;
      expect(assignment.hookReplay).toEqual({
        commitSha: replaySha,
        treeSha: replayTree,
        beforeHookTreeSha: beforeTree,
      });
      expect(assignment.staging.hookCommand?.exitCode).toBe(0);
      expect(assignment.context.hookReplayTreeSha).toBe(replayTree);
      const merge = spawnSync(
        "git",
        ["merge", "--no-ff", "--no-commit", replaySha!],
        { cwd: workspace, encoding: "utf-8" },
      );
      expect(merge.status, merge.stderr).toBe(1);
      writeFileSync(
        join(workspace, "app.txt"),
        `${git(workspace, "show", `${replaySha}:app.txt`)}\n`,
      );
      git(workspace, "add", "app.txt");
      git(workspace, "commit", "-qm", "fix: reconcile hook formatting");
    } else if (args.role === "reviewer" && workers.invocations.length === 1) {
      expect(git(args.cwd!, "show", "HEAD:app.txt")).toBe("formatted");
      expect(
        state.reviews[`source:${workstream.id}`]?.latestCorrection,
      ).toBeDefined();
      expect(Object.keys(state.publication.intents)).toHaveLength(0);
      expect(await client.head()).toBe(baseSha);
    }
    return spawn(args);
  }) as typeof workers.spawn);
  const actor = createRuntime({
    pi: {} as never,
    ctx: { ui: { notify() {} } } as never,
    git: client,
    store,
    lease,
    roles,
    checkoutIdentity,
    baseSha,
    subagents: workers,
  });
  try {
    await actor.start();
    await actor.settle();
    const state = store.read();
    expect(state.phase, state.failure?.reason).toBe("completed");
    expect(workers.invocations.map((worker) => worker.role)).toEqual([
      "implementer",
      "reviewer",
      "reviewer",
    ]);
    expect(
      Object.values(state.reconciliationAssignments).map(
        (assignment) => assignment.status,
      ),
    ).toEqual(["completed"]);
    expect(Object.keys(state.publication.receipts)).toHaveLength(1);
    expect(readFileSync(join(root, "app.txt"), "utf-8")).toBe("formatted\n");
    expect(
      Object.values(state.failures).some(
        (failure) => failure.category === "hook_rejected",
      ),
    ).toBe(false);
  } finally {
    if (store.read().phase !== "completed") {
      await actor.stop("Test cleanup");
    }
  }
});

it("stops without publication when successful hooks never converge", async () => {
  const { root, client, baseSha, checkoutIdentity, lease, store, workspace } =
    await approvedRun();
  const hook = join(root, ".git", "hooks", "pre-commit");
  writeFileSync(
    hook,
    "#!/bin/sh\nprintf 'mutation\\n' >> app.txt\ngit add app.txt\n",
  );
  chmodSync(hook, 0o755);
  const workers = new ScriptedSubagentClient(
    Array.from({ length: 3 }, () => [
      {
        status: "completed" as const,
        result: {
          summary: "Reconciled the retained hook changes.",
          verification: [
            {
              kind: "inspection",
              label: "Hook delta",
              evidence: "Retained replay inspected.",
            },
          ],
        },
      },
      {
        status: "completed" as const,
        result: { assessments: [], regressions: [] },
      },
    ]).flat(),
    [root],
  );
  const spawn = workers.spawn.bind(workers);
  vi.spyOn(workers, "spawn").mockImplementation((async (args) => {
    if (args.role === "implementer") {
      const replaySha = /Hook-mutated replay: ([a-f0-9]+)/.exec(
        args.prompt,
      )?.[1];
      expect(replaySha).toBeDefined();
      const merge = spawnSync(
        "git",
        ["merge", "--no-ff", "--no-commit", replaySha!],
        { cwd: workspace, encoding: "utf-8" },
      );
      expect([0, 1]).toContain(merge.status);
      writeFileSync(
        join(workspace, "app.txt"),
        `${git(workspace, "show", `${replaySha}:app.txt`)}\n`,
      );
      git(workspace, "add", "app.txt");
      git(workspace, "commit", "-qm", "fix: reconcile hook changes");
    }
    return spawn(args);
  }) as typeof workers.spawn);
  const actor = createRuntime({
    pi: {} as never,
    ctx: { ui: { notify() {} } } as never,
    git: client,
    store,
    lease,
    roles,
    checkoutIdentity,
    baseSha,
    subagents: workers,
  });
  try {
    await actor.start();
    await actor.settle();
    const state = store.read();
    expect(state.phase, state.failure?.reason).toBe("incomplete");
    expect(workers.invocations.map((worker) => worker.role)).toEqual([
      "implementer",
      "reviewer",
      "implementer",
      "reviewer",
      "implementer",
      "reviewer",
    ]);
    expect(Object.values(state.failures)).toContainEqual(
      expect.objectContaining({
        category: "semantic_blocked",
        assignment: "blocked",
        gate: "reconciliation_hook",
        evidence: expect.stringContaining("Hook-mutation recovery exhausted"),
      }),
    );
    expect(Object.keys(state.publication.intents)).toHaveLength(0);
    expect(Object.keys(state.publication.receipts)).toHaveLength(0);
    expect(await client.head()).toBe(baseSha);
    expect(readFileSync(join(root, "app.txt"), "utf-8")).toBe("base\n");
  } finally {
    if (store.read().phase !== "incomplete") {
      await actor.stop("Test cleanup");
    }
  }
}, 30_000);

it("repairs candidate-added hook dependencies in staging before retrying the ordinary commit", async () => {
  const setup = `import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("node_modules/hook-dependency", { recursive: true });
writeFileSync("node_modules/hook-dependency/package.json", JSON.stringify({ type: "module", exports: "./index.js" }));
writeFileSync("node_modules/hook-dependency/index.js", "export default true;");
`;
  const prepared = await approvedRun((workspace) => {
    writeFileSync(join(workspace, ".gitignore"), "node_modules/\n");
    writeFileSync(
      join(workspace, "package.json"),
      JSON.stringify({
        type: "module",
        devDependencies: { "hook-dependency": "1.0.0" },
      }),
    );
    writeFileSync(
      join(workspace, "hook-config.mjs"),
      'import ready from "hook-dependency"; if (!ready) process.exit(1);\n',
    );
    writeFileSync(join(workspace, "setup.mjs"), setup);
    execFileSync(process.execPath, ["setup.mjs"], { cwd: workspace });
  });
  const {
    root,
    client,
    baseSha,
    checkoutIdentity,
    lease,
    store,
    candidate,
    workspace,
  } = prepared;
  const hook = join(root, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\nnode hook-config.mjs\n");
  chmodSync(hook, 0o755);
  const workers = new ScriptedSubagentClient(
    [
      {
        status: "completed",
        result: {
          outcome: "retry",
          summary: "Installed the replayed hook dependency.",
          verification: [
            {
              kind: "inspection",
              label: "Dependency",
              evidence: "Hook dependency resolves in staging.",
            },
          ],
        },
      },
      {
        status: "completed",
        result: {
          findings: [],
          assessments: [],
          handoffDraft: "Published with the reviewed dependencies.",
        },
      },
    ],
    [root],
  );
  const spawn = workers.spawn.bind(workers);
  vi.spyOn(workers, "spawn").mockImplementation((async (args) => {
    if (args.role === "implementer") {
      expect(args.cwd).not.toBe(workspace);
      expect(args.cwd).toContain("/staging-");
      expect(args.prompt).toContain("ERR_MODULE_NOT_FOUND");
      expect(args.prompt).toContain("Do not run the commit yourself");
      expect(Object.values(store.read().failures)).toContainEqual(
        expect.objectContaining({
          gate: "staging_environment_repair",
          candidateId: candidate.id,
          targetEvidence: baseSha,
        }),
      );
      expect(Object.keys(store.read().publication.intents)).toHaveLength(0);
      expect(await client.head()).toBe(baseSha);
      execFileSync(process.execPath, ["setup.mjs"], { cwd: args.cwd });
    }
    return spawn(args);
  }) as typeof workers.spawn);
  const actor = createRuntime({
    pi: {} as never,
    ctx: { ui: { notify() {} } } as never,
    git: client,
    store,
    lease,
    roles,
    checkoutIdentity,
    baseSha,
    subagents: workers,
  });
  try {
    await actor.start();
    await actor.settle();
    const state = store.read();
    expect(state.phase, state.failure?.reason).toBe("completed");
    expect(workers.invocations.map((worker) => worker.role)).toEqual([
      "implementer",
      "reviewer",
    ]);
    expect(Object.keys(state.revisionAssignments)).toHaveLength(0);
    expect(Object.keys(state.publication.receipts)).toHaveLength(1);
    expect(git(workspace, "rev-parse", "HEAD")).toBe(candidate.commitSha);
    const repair = Object.values(state.failures).find(
      (failure) => failure.gate === "staging_environment_repair",
    )!;
    const artifactPath = /Artifact: (.+)$/.exec(repair.evidence)![1]!;
    expect(
      JSON.parse(
        readFileSync(join(dirname(store.path), artifactPath), "utf-8"),
      ),
    ).toMatchObject({
      response: { status: "completed", result: { outcome: "retry" } },
    });
  } finally {
    await actor.stop("Test cleanup");
  }
});

it("does not repeat staging repair when its ordinary commit retry still fails", async () => {
  const { root, client, baseSha, checkoutIdentity, lease, store, workspace } =
    await approvedRun();
  const hook = join(root, ".git", "hooks", "pre-commit");
  writeFileSync(
    hook,
    '#!/bin/sh\nprintf "attempt\\n" >> "$(git rev-parse --git-common-dir)/hook-attempts"\nexit 1\n',
  );
  chmodSync(hook, 0o755);
  const workers = new ScriptedSubagentClient(
    [
      {
        status: "completed",
        result: {
          outcome: "retry",
          summary: "Environment preparation attempted.",
          verification: [
            {
              kind: "not_run",
              label: "Commit",
              reason: "The host owns the retry.",
            },
          ],
        },
      },
      {
        status: "completed",
        result: {
          outcome: "unchanged",
          summary: "No source defect found.",
          evidence: "No candidate correction justified.",
          verification: [
            {
              kind: "inspection",
              label: "Source",
              evidence: "Candidate unchanged.",
            },
          ],
        },
      },
    ],
    [root],
  );
  const actor = createRuntime({
    pi: {} as never,
    ctx: { ui: { notify() {} } } as never,
    git: client,
    store,
    lease,
    roles,
    checkoutIdentity,
    baseSha,
    subagents: workers,
  });
  try {
    await actor.start();
    await actor.settle();
    const state = store.read();
    expect(state.phase, state.failure?.reason).toBe("incomplete");
    expect(
      workers.invocations,
      JSON.stringify(state.failures, null, 2),
    ).toHaveLength(2);
    expect(workers.invocations[0]!.cwd).toContain("/staging-");
    expect(workers.invocations[1]!.cwd).toBe(workspace);
    const resources = await inventoryResumeResources({
      state,
      git: client,
      root: join(lease.paths.worktrees, state.run.id),
      preservedSourceIds: [],
      deliveredCandidateIds: new Set(),
    });
    expect(resources).toContainEqual(
      expect.objectContaining({
        kind: "staging",
        path: workers.invocations[0]!.cwd,
        operationId: Object.values(state.failures).find(
          (failure) => failure.gate === "staging_environment_repair",
        )!.operationId,
      }),
    );
    expect(
      Object.values(state.failures).filter(
        (failure) => failure.gate === "staging_environment_repair",
      ),
    ).toHaveLength(1);
    expect(
      readFileSync(join(root, ".git", "hook-attempts"), "utf-8")
        .trim()
        .split("\n"),
    ).toHaveLength(2);
    expect(await client.head()).toBe(baseSha);
    expect(Object.keys(state.publication.intents)).toHaveLength(0);
  } finally {
    await actor.stop("Test cleanup");
  }
});

it.each(["staging", "target", "hook redirection", "hook replacement"] as const)(
  "refuses publication if staging repair changes the %s boundary",
  async (boundary) => {
    const { root, client, baseSha, checkoutIdentity, lease, store } =
      await approvedRun();
    const hook = join(root, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    const workers = new ScriptedSubagentClient(
      [
        {
          status: "completed",
          result: {
            outcome: "retry",
            summary: "Attempted source change.",
            verification: [
              { kind: "not_run", label: "Commit", reason: "Host-owned." },
            ],
          },
        },
      ],
      [root],
    );
    const spawn = workers.spawn.bind(workers);
    vi.spyOn(workers, "spawn").mockImplementation((async (args) => {
      if (boundary === "hook redirection") {
        git(args.cwd!, "config", "core.hooksPath", "/dev/null");
      } else if (boundary === "hook replacement") {
        writeFileSync(hook, "#!/bin/sh\nexit 0\n");
      } else {
        writeFileSync(
          join(boundary === "staging" ? args.cwd! : root, "app.txt"),
          "unreviewed\n",
        );
      }
      return spawn(args);
    }) as typeof workers.spawn);
    const actor = createRuntime({
      pi: {} as never,
      ctx: { ui: { notify() {} } } as never,
      git: client,
      store,
      lease,
      roles,
      checkoutIdentity,
      baseSha,
      subagents: workers,
    });
    try {
      await actor.start();
      await actor.settle();
      const state = store.read();
      expect(state.phase).toBe("failed");
      expect(state.failure?.category).toBe("workspace_unsafe");
      expect(workers.invocations).toHaveLength(1);
      expect(Object.keys(state.publication.intents)).toHaveLength(0);
      expect(Object.keys(state.publication.receipts)).toHaveLength(0);
      expect(await client.head()).toBe(baseSha);
    } finally {
      await actor.stop("Test cleanup");
    }
  },
);

it("consumes a stopped staging repair without retrying the commit", async () => {
  const { root, client, baseSha, checkoutIdentity, lease, store } =
    await approvedRun();
  const hook = join(root, ".git", "hooks", "pre-commit");
  writeFileSync(
    hook,
    '#!/bin/sh\nprintf "attempt\\n" >> "$(git rev-parse --git-common-dir)/hook-attempts"\nexit 1\n',
  );
  chmodSync(hook, 0o755);
  const workers = new ScriptedSubagentClient([], [root]);
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  vi.spyOn(workers, "waitFor").mockImplementation((async (
    _id: string,
    signal?: AbortSignal,
  ) => {
    enter();
    await new Promise<void>((resolve) =>
      signal!.addEventListener("abort", () => resolve(), { once: true }),
    );
    return { status: "stopped", error: "Stopped by user." };
  }) as typeof workers.waitFor);
  const actor = createRuntime({
    pi: {} as never,
    ctx: { ui: { notify() {} } } as never,
    git: client,
    store,
    lease,
    roles,
    checkoutIdentity,
    baseSha,
    subagents: workers,
  });
  try {
    await actor.start();
    await entered;
    await actor.stop("Stop during staging repair");
    const state = store.read();
    expect(state.phase).toBe("failed");
    expect(workers.invocations).toHaveLength(1);
    expect(
      Object.values(state.failures).filter(
        (failure) => failure.gate === "staging_environment_repair",
      ),
    ).toHaveLength(1);
    expect(Object.keys(state.processLeases)).toHaveLength(0);
    expect(Object.keys(state.publication.receipts)).toHaveLength(0);
    expect(
      readFileSync(join(root, ".git", "hook-attempts"), "utf-8")
        .trim()
        .split("\n"),
    ).toHaveLength(1);
    expect(await client.head()).toBe(baseSha);
  } finally {
    await actor.stop("Test cleanup");
  }
});
