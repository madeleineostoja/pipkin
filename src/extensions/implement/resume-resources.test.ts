import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { GitClient } from "./git.js";
import {
  inventoryResumeResources,
  inspectResumeResource,
} from "./resume-resources.js";
import {
  cleanupSchedulerStores,
  createSchedulerStore,
} from "./scheduler/scheduler-test-support.js";

afterEach(cleanupSchedulerStores);

it("protects all candidate versions of delivered source and landed repair workspaces while inventorying unfinished execution", async () => {
  const store = await createSchedulerStore();
  const state = store.read();
  const root = join(store.lease.paths.worktrees, state.run.id);
  const paths = ["first-stream", "second-stream", "repair"].map((id) =>
    join(root, "g0", id),
  );
  for (const path of paths) {
    mkdirSync(path, { recursive: true });
  }
  const candidate = (
    id: string,
    lane: "first-stream" | "second-stream" | "repair",
  ) => ({
    id,
    workstream:
      lane === "repair"
        ? { kind: "overall" as const, repairId: lane }
        : { kind: "source" as const, id: lane },
    baseSha: "base",
    commitSha: "head",
    treeSha: "tree",
  });
  state.candidates = {
    "first-before-correction": candidate(
      "first-before-correction",
      "first-stream",
    ),
    "first-delivered": candidate("first-delivered", "first-stream"),
    "repair-before-correction": candidate("repair-before-correction", "repair"),
    "repair-landed": candidate("repair-landed", "repair"),
    "second-unpublished": candidate("second-unpublished", "second-stream"),
  };
  const git = {
    commonIdentity: async () => "repository",
    listWorktreeRegistrations: async () =>
      paths.map((path) => ({
        path,
        branch: `pipkin/implement/${state.run.id}/g0/${basename(path)}`,
      })),
    listBranchesMatching: async () =>
      paths.map(
        (path) => `pipkin/implement/${state.run.id}/g0/${basename(path)}`,
      ),
    branchTip: async () => "head",
    isAncestor: async () => true,
    forWorktree: (path: string) => ({
      commonIdentity: async () => "repository",
      currentBranch: async () =>
        `pipkin/implement/${state.run.id}/g0/${basename(path)}`,
      head: async () => "head",
      checkoutIdentity: async () => `${path}/.git`,
      activeOperation: async () => undefined,
      worktreeFingerprintExcept: async () => "dirty-fingerprint",
      indexEntries: async () => "index-entries",
      nonignoredUntracked: async () => [],
    }),
  } as unknown as GitClient;
  const resources = await inventoryResumeResources({
    state,
    git,
    root,
    preservedSourceIds: ["first-stream"],
    deliveredCandidateIds: new Set(["first-delivered", "repair-landed"]),
  });
  expect(resources.map((resource) => resource.path)).toEqual([paths[1]]);
  expect(resources[0]?.candidateId).toBe("second-unpublished");
  state.candidates["conflicting-repair"] = {
    ...candidate("conflicting-repair", "repair"),
    workstream: { kind: "overall", repairId: "first-stream" },
  };
  await expect(
    inventoryResumeResources({
      state,
      git,
      root,
      preservedSourceIds: ["first-stream"],
      deliveredCandidateIds: new Set(["first-delivered", "repair-landed"]),
    }),
  ).rejects.toThrow(/Conflicting Resume resource evidence/);
});

it("refuses an owned branch registered outside its inventoried workspace even when that path is unavailable", async () => {
  const store = await createSchedulerStore();
  const root = join(store.lease.paths.worktrees, store.read().run.id);
  const resource = {
    id: "workspace:g0:second-stream",
    kind: "branch" as const,
    path: join(root, "g0", "second-stream"),
    branch: `pipkin/implement/${store.read().run.id}/g0/second-stream`,
    ownershipEvidence: JSON.stringify({ head: "head" }),
    status: "pending" as const,
  };
  const git = {
    branchTip: async () => "head",
    listWorktreeRegistrations: async () => [
      { path: join(root, "..", "unavailable"), branch: resource.branch },
    ],
  } as unknown as GitClient;
  await expect(inspectResumeResource(git, root, resource)).rejects.toThrow(
    /checked out outside its inventoried workspace/,
  );
});
