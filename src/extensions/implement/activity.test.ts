import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { ACTIVITY_CHANNEL, type ActivityPublisher } from "#ui/activity";
import { ActivityStore } from "../ui/activity-store.js";
import { createImplementActivity } from "./activity.js";
import { compileExecutionPlan, writeExecutionPlan } from "./execution-plan.js";
import { buildMaterialStore } from "./material-store.js";
import { parsePlan } from "./plan.js";
import type { RunState } from "./store.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function attachPlan(running: RunState, orderedIds: string[]): void {
  const directory = mkdtempSync(join(tmpdir(), "pipkin-activity-"));
  directories.push(directory);
  const planPath = join(directory, "plan.md");
  const title =
    "A long task title that should not be repeated in dependency details";
  const plan = parsePlan(
    planPath,
    `# Plan\n\n${orderedIds.map(() => `- [ ] ${title}`).join("\n")}\n`,
  );
  const result = compileExecutionPlan(
    {
      version: 1,
      tasks: orderedIds.map((id, index) => ({
        id: `task-${id}`,
        planIndex: index + 1,
        title,
        dependsOn: running.workstreams.source[id]!.dependsOn.map(
          (dependency) => `task-${dependency}`,
        ),
        compiledContract: {
          objective: `Implement ${id}`,
          inScope: [id],
          acceptanceCriteria: [`${id} works`],
          outOfScope: ["Sibling work"],
        },
      })),
      workstreams: orderedIds.map((id) => ({ id, taskIds: [`task-${id}`] })),
    },
    {
      plan,
      planHash: "plan-hash",
      materialStore: buildMaterialStore({
        plan,
        planPath,
        repoRoot: directory,
      }),
      checkoutId: "checkout",
      baseSha: "base-sha",
      workerConcurrency: 3,
    },
  );
  if (!result.ok) {
    throw new Error(result.reason);
  }
  writeExecutionPlan(directory, result.value);
  running.executionPlan = {
    path: join(directory, "execution-plan.json"),
    hash: "plan-hash",
  };
}

function state(
  source: Record<
    string,
    { id: string; phase: string; taskIds: string[]; dependsOn?: string[] }
  > = {},
  overall: Record<string, { repairId: string; phase: string }> = {},
  runId = "run",
): RunState {
  return {
    run: { id: runId },
    tasks: {},
    generation: 0,
    generationHistory: [],
    operationSettlements: {},
    reviews: {},
    wholePlanReview: { status: "pending" },
    workstreams: {
      source: Object.fromEntries(
        Object.entries(source).map(([id, workstream]) => [
          id,
          { kind: "source", dependsOn: [], ...workstream },
        ]),
      ),
      overall: Object.fromEntries(
        Object.entries(overall).map(([id, workstream]) => [
          id,
          { kind: "overall", ...workstream },
        ]),
      ),
    },
    phase: "executing",
  } as unknown as RunState;
}

function fakePublisher(
  remove: ActivityPublisher["remove"] = vi.fn(() => true),
): ActivityPublisher & {
  upsert: ReturnType<typeof vi.fn<ActivityPublisher["upsert"]>>;
  remove: ActivityPublisher["remove"];
  dispose: ReturnType<typeof vi.fn<ActivityPublisher["dispose"]>>;
} {
  return {
    upsert: vi.fn(() => true),
    remove,
    clear: vi.fn(() => true),
    dispose: vi.fn(),
  };
}

describe("Implement Activity projector", () => {
  it("uses distinct bounded IDs for maximum-length source and repair lanes", () => {
    const events = createEventBus();
    const store = new ActivityStore();
    events.on(ACTIVITY_CHANNEL, (event) => store.accept(event));
    const id = `a${"b".repeat(63)}`;
    const activity = createImplementActivity(events, {} as never);

    activity.update(
      state(
        { [id]: { id, phase: "implementing", taskIds: [] } },
        { [id]: { repairId: id, phase: "implementing" } },
      ),
    );

    const children = store.records.filter((record) => record.parent);
    expect(children).toHaveLength(2);
    expect(new Set(children.map((record) => record.id)).size).toBe(2);
    expect(children.every((record) => record.id.length <= 64)).toBe(true);
  });

  it("keeps overall progress separate from workstream task totals", () => {
    const publisher = fakePublisher();
    const activity = createImplementActivity(
      {} as never,
      {} as never,
      publisher,
    );
    const running = state({
      lane: {
        id: "lane",
        phase: "implementing",
        taskIds: ["first", "second", "third"],
      },
    });
    running.tasks = {
      first: {
        workstreamId: "lane",
        phase: "published",
        checkpoint: "first-sha",
      },
      second: { workstreamId: "lane", phase: "pending" },
      third: { workstreamId: "lane", phase: "pending" },
    };

    activity.update(running);

    const records = publisher.upsert.mock.calls.map(([published]) => published);
    expect(
      records.find((record) => record.label === "Implement"),
    ).toMatchObject({ progress: { completed: 1, total: 3 } });
    expect(
      records.find((record) => record.label === "Workstream 1"),
    ).toMatchObject({ metric: "3 tasks" });
  });

  it("keeps plan numbering stable and updates only unfinished direct dependencies", () => {
    const events = createEventBus();
    const store = new ActivityStore();
    events.on(ACTIVITY_CHANNEL, (event) => store.accept(event));
    const activity = createImplementActivity(events, {} as never);
    const running = state({
      consumer: {
        id: "consumer",
        phase: "queued",
        taskIds: ["task-consumer"],
        dependsOn: ["branch", "independent"],
      },
      independent: {
        id: "independent",
        phase: "implementing",
        taskIds: ["task-independent"],
      },
      branch: {
        id: "branch",
        phase: "queued",
        taskIds: ["task-branch"],
        dependsOn: ["foundation"],
      },
      foundation: {
        id: "foundation",
        phase: "implementing",
        taskIds: ["task-foundation"],
      },
    });
    attachPlan(running, ["foundation", "branch", "independent", "consumer"]);
    const details = () =>
      store.records
        .filter((record) => record.parent)
        .map(({ label, detail }) => ({ label, detail }));

    activity.update(running);
    expect(details()).toEqual(
      expect.arrayContaining([
        { label: "Workstream 2", detail: "Waiting for: Workstream 1" },
        { label: "Workstream 4", detail: "Waiting for: Workstreams 2, 3" },
      ]),
    );
    expect(
      store.records.find((record) => record.label === "Workstream 4")?.title,
    ).toContain("A long task title");

    running.workstreams.source.foundation!.phase = "completed";
    running.workstreams.source.independent!.phase = "completed";
    activity.update(running);
    expect(details()).toEqual(
      expect.arrayContaining([
        { label: "Workstream 2", detail: "Queued" },
        { label: "Workstream 4", detail: "Waiting for: Workstream 2" },
      ]),
    );
    expect(details().map(({ label }) => label)).toEqual([
      "Workstream 4",
      "Workstream 2",
    ]);

    running.workstreams.source.branch!.phase = "completed";
    activity.update(running);
    expect(details()).toEqual([{ label: "Workstream 4", detail: "Queued" }]);
  });

  it("bounds long lists of pending prerequisites", () => {
    const publisher = fakePublisher();
    const activity = createImplementActivity(
      {} as never,
      {} as never,
      publisher,
    );
    const ids = ["a", "b", "c", "d", "e"];
    const running = state(
      Object.fromEntries(
        ids.map((id) => [
          id,
          {
            id,
            phase: "implementing",
            taskIds: [`task-${id}`],
          },
        ]),
      ),
    );
    running.workstreams.source.consumer = {
      kind: "source",
      id: "consumer",
      phase: "queued",
      taskIds: ["task-consumer"],
      dependsOn: ids,
    };
    attachPlan(running, [...ids, "consumer"]);

    activity.update(running);

    expect(publisher.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "Workstream 6",
        detail: "Waiting for: Workstreams 1, 2, 3 +2 more",
      }),
    );
  });

  it("distinguishes initial reviews from reassessment even at review round zero", () => {
    const publisher = fakePublisher();
    const activity = createImplementActivity(
      {} as never,
      {} as never,
      publisher,
    );
    const running = state(
      { lane: { id: "lane", phase: "reviewing", taskIds: [] } },
      { repair: { repairId: "repair", phase: "reviewing" } },
    );
    const laneDetails = () =>
      publisher.upsert.mock.calls
        .map(([record]) => record)
        .filter((record) => record.parent)
        .map((record) => record.detail);

    activity.update(running);
    expect(laneDetails()).toEqual(["Reviewing", "Reviewing"]);

    const review: RunState["reviews"][string] = {
      candidateId: "candidate",
      candidateCommitSha: "commit",
      candidateTreeSha: "tree",
      comparisonBase: "base",
      round: 0,
      pendingCorrectionIds: ["finding"],
      correctionConsumed: true,
      evidence: ["Initial review evidence"],
      observations: [],
    };
    running.reviews = { "source:lane": review, "overall:repair": review };
    publisher.upsert.mockClear();
    activity.update(running);
    expect(laneDetails()).toEqual(["Re-reviewing", "Re-reviewing"]);
  });

  it("uses sentence case for run phases and multi-word lane phases", () => {
    const publisher = fakePublisher();
    const activity = createImplementActivity(
      {} as never,
      {} as never,
      publisher,
    );
    const running = state({
      lane: { id: "lane", phase: "candidate_ready", taskIds: [] },
    });
    running.phase = "whole_plan_review";
    activity.update(running);

    expect(publisher.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "Implement",
        metric: "Whole-plan review",
      }),
    );
    expect(publisher.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "Workstream 1",
        detail: "Candidate ready",
      }),
    );
  });

  it("collapses dependency-skipped lanes while retaining failures", () => {
    const events = createEventBus();
    const store = new ActivityStore();
    events.on(ACTIVITY_CHANNEL, (event) => store.accept(event));
    const activity = createImplementActivity(events, {} as never);

    activity.update(
      state({
        skipped: { id: "skipped", phase: "dependency_skipped", taskIds: [] },
        failed: { id: "failed", phase: "failed", taskIds: [] },
      }),
    );

    const children = store.records.filter((record) => record.parent);
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      state: "waiting",
      detail: "Failed",
    });
  });

  it.each([
    ["rejected", () => false],
    [
      "throwing",
      () => {
        throw new Error("remove failed");
      },
    ],
  ])("retries %s removals until they succeed", (_kind, firstRemoval) => {
    const remove = vi
      .fn<ActivityPublisher["remove"]>()
      .mockImplementationOnce(firstRemoval)
      .mockReturnValue(true);
    const publisher = fakePublisher(remove);
    const activity = createImplementActivity(
      {} as never,
      {} as never,
      publisher,
    );
    activity.update(
      state({ lane: { id: "lane", phase: "implementing", taskIds: [] } }),
    );
    const childId = publisher.upsert.mock.calls
      .map(([published]) => published)
      .find((published) => published.parent)?.id;

    activity.update(state());
    activity.update(state());
    activity.update(state());

    expect(childId).toBeDefined();
    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenNthCalledWith(1, childId);
    expect(remove).toHaveBeenNthCalledWith(2, childId);
  });

  it("removes stopped and replaced IDs once after accepted removal", () => {
    const publisher = fakePublisher();
    const activity = createImplementActivity(
      {} as never,
      {} as never,
      publisher,
    );
    activity.update(
      state({ lane: { id: "lane", phase: "implementing", taskIds: [] } }),
    );
    const firstIds = publisher.upsert.mock.calls.map(
      ([published]) => published.id,
    );

    activity.update(
      state(
        { lane: { id: "lane", phase: "stopped", taskIds: [] } },
        {},
        "replacement",
      ),
    );
    activity.update(
      state(
        { lane: { id: "lane", phase: "stopped", taskIds: [] } },
        {},
        "replacement",
      ),
    );

    expect(publisher.remove).toHaveBeenCalledTimes(2);
    expect(new Set(vi.mocked(publisher.remove).mock.calls.flat())).toEqual(
      new Set(firstIds),
    );
  });

  it("updates the live root with the generated title without rewriting it", () => {
    const publisher = fakePublisher();
    const activity = createImplementActivity(
      {} as never,
      {} as never,
      publisher,
    );
    activity.update(state());
    activity.setTitle("Implement · exact generated title");

    expect(publisher.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Implement · exact generated title" }),
    );
  });

  it("retains failed lanes while a failed run settles its owned work", () => {
    const events = createEventBus();
    const store = new ActivityStore();
    events.on(ACTIVITY_CHANNEL, (event) => store.accept(event));
    const activity = createImplementActivity(events, {} as never);
    const stopping = {
      ...state({ lane: { id: "lane", phase: "failed", taskIds: [] } }),
      phase: "stopping",
      failure: {
        category: "runtime",
        reason: "worker failed",
        originPhase: "running",
        at: new Date().toISOString(),
      },
    } as unknown as RunState;

    activity.update(stopping);

    expect(store.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Implement", state: "running" }),
        expect.objectContaining({
          label: "Workstream 1",
          state: "waiting",
          detail: "Failed",
        }),
      ]),
    );

    activity.update({ ...stopping, phase: "failed" });
    expect(store.records).toEqual([]);
  });

  it("clears all live work at terminal run settlement", () => {
    const publisher = fakePublisher();
    const activity = createImplementActivity(
      {} as never,
      {} as never,
      publisher,
    );
    activity.update(
      state({ lane: { id: "lane", phase: "failed", taskIds: [] } }),
    );
    activity.update({ ...state(), phase: "failed" });

    expect(publisher.dispose).toHaveBeenCalledOnce();
  });

  it("shuts down idempotently and ignores later updates", () => {
    const publisher = fakePublisher();
    const activity = createImplementActivity(
      {} as never,
      {} as never,
      publisher,
    );
    activity.update(state());
    const publishedBeforeShutdown = publisher.upsert.mock.calls.length;

    activity.clear();
    activity.clear();
    activity.update(state());

    expect(publisher.dispose).toHaveBeenCalledOnce();
    expect(publisher.upsert).toHaveBeenCalledTimes(publishedBeforeShutdown);
  });
});
