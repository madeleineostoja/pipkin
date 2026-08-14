import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TargetBoundaryError,
  WorkstreamCandidateLifecycleError,
} from "../workstream-candidate.js";
import { SchedulerActor } from "./scheduler-actor.js";
import {
  cleanupSchedulerStores,
  createSchedulerStore,
  createUnboundSchedulerRun,
  deferred,
} from "./scheduler-test-support.js";

afterEach(() => cleanupSchedulerStores());

describe("global safety boundaries", () => {
  it("aborts independent workers when target authority cannot be proven", async () => {
    const store = await createSchedulerStore(2, true);
    let independentSignal: AbortSignal | undefined;
    const actor = new SchedulerActor({
      store,
      executeEffect: async ({ effect, signal }) => {
        if (effect.kind !== "run_implementation") {
          return;
        }
        if (effect.workstream.kind !== "source") {
          throw new Error("expected source implementation");
        }
        if (effect.workstream.id === "first-stream") {
          throw new TargetBoundaryError("target checkout changed");
        }
        independentSignal = signal;
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    });

    await actor.start();
    await vi.waitFor(() => expect(independentSignal?.aborted).toBe(true));
    await actor.settle();

    expect(store.read()).toMatchObject({
      phase: "failed",
      failure: { category: "workspace_unsafe" },
    });
  });

  it("contains a scheduler failure raised while a background effect unwinds", async () => {
    const store = await createSchedulerStore();
    const entered = deferred();
    const release = deferred();
    const actor = new SchedulerActor({
      store,
      executeEffect: async ({ effect }) => {
        if (effect.kind !== "run_implementation") {
          return;
        }
        entered.resolve();
        await release.promise;
      },
    });

    await actor.start();
    await entered.promise;
    actor.drive = async () => {
      throw new Error("final scheduler drive failed");
    };
    release.resolve();

    await vi.waitFor(() => expect(store.read().phase).toBe("failed"));
    expect(store.read().failure).toMatchObject({
      category: "persistence_runtime_failure",
      reason: "final scheduler drive failed",
    });
  });

  it("reports a background failure that cannot be persisted", async () => {
    const store = await createSchedulerStore();
    const entered = deferred();
    const release = deferred();
    const reported = deferred<unknown>();
    const actor = new SchedulerActor({
      store,
      onBackgroundError: (error) => reported.resolve(error),
      executeEffect: async ({ effect }) => {
        if (effect.kind !== "run_implementation") {
          return;
        }
        entered.resolve();
        await release.promise;
      },
    });

    await actor.start();
    await entered.promise;
    actor.drive = async () => {
      throw new Error("final scheduler drive failed");
    };
    store.update = async () => {
      throw new Error("state persistence failed");
    };
    release.resolve();

    await expect(reported.promise).resolves.toMatchObject({
      message: "state persistence failed",
    });
    expect(store.read().phase).toBe("running");
  });

  it("contains a scheduler failure after the planner binds the run", async () => {
    const { run: store, plan } = createUnboundSchedulerRun();
    const actor = new SchedulerActor({
      store,
      executePlanner: async () => plan,
    });
    actor.schedule = async () => {
      throw new Error("post-planning scheduler drive failed");
    };

    await actor.start();

    await vi.waitFor(() => expect(store.read().phase).toBe("failed"));
    expect(store.read().failure).toMatchObject({
      category: "persistence_runtime_failure",
      reason: "post-planning scheduler drive failed",
    });
  });

  it("contains a scheduler failure raised while the planner unwinds", async () => {
    const { run: store, plan } = createUnboundSchedulerRun();
    const entered = deferred();
    const release = deferred();
    const actor = new SchedulerActor({
      store,
      executePlanner: async () => {
        entered.resolve();
        await release.promise;
        return plan;
      },
    });

    await actor.start();
    await entered.promise;
    const originalFinalizeFailure = Reflect.get(actor, "finalizeFailure") as (
      this: SchedulerActor,
    ) => Promise<void>;
    let firstFinalization = true;
    Object.defineProperty(actor, "finalizeFailure", {
      value: async () => {
        if (firstFinalization) {
          firstFinalization = false;
          throw new Error("planner finalization failed");
        }
        await originalFinalizeFailure.call(actor);
      },
    });
    release.resolve();

    await vi.waitFor(() => expect(store.read().phase).toBe("failed"));
    expect(store.read().failure).toMatchObject({
      category: "persistence_runtime_failure",
      reason: "planner finalization failed",
    });
  });

  it("aborts independent workers when owned candidate identity is invalid", async () => {
    const store = await createSchedulerStore(2, true);
    let independentSignal: AbortSignal | undefined;
    const actor = new SchedulerActor({
      store,
      executeEffect: async ({ effect, signal }) => {
        if (effect.kind !== "run_implementation") {
          return;
        }
        if (effect.workstream.kind !== "source") {
          throw new Error("expected source implementation");
        }
        if (effect.workstream.id === "first-stream") {
          throw new WorkstreamCandidateLifecycleError(
            "owned branch changed",
            "workspace_unsafe",
            undefined,
            {
              branch: "unexpected-branch",
              head: "base-sha",
              tree: "base-tree",
              clean: false,
              status: [{ status: " M", path: "src/endpoint.ts" }],
            },
          );
        }
        independentSignal = signal;
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    });

    await actor.start();
    await vi.waitFor(() => expect(independentSignal?.aborted).toBe(true));
    await actor.settle();

    expect(store.read().phase).toBe("failed");
  });
});
