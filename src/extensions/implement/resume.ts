import { join } from "node:path";
import { ExecGitClient, type GitClient } from "./git.js";
import { loadCheckoutRun } from "./controls.js";
import {
  acquireCheckoutLease,
  RunStore,
  type CheckoutLeaseCapability,
  type RunState,
} from "./store.js";
import {
  restartDeliveredCandidateIds,
  restartPreservedSourceIds,
  interruptedRestartState,
  preflightRestart,
  type RestartResource,
} from "./restart.js";
import {
  inventoryResumeResources,
  inspectResumeResource,
  retireResumeResource,
} from "./resume-resources.js";
import {
  settleProjectionTransactions,
  settlePublicationTransactions,
} from "./transaction-settlement.js";

export type ResumePreview = {
  runId: string;
  generation: number;
  startupRecovery: boolean;
  preservedSourceIds: string[];
  discardedSourceIds: string[];
  resources: RestartResource[];
  remainingSteps: string[];
};

export type PreparedResume = {
  runId: string;
  lease: CheckoutLeaseCapability;
  store: RunStore;
  git: ExecGitClient;
};

async function preview(
  store: RunStore,
  git: GitClient,
): Promise<ResumePreview> {
  const proof = await preflightRestart(store, git);
  const state = interruptedRestartState(store.read());
  const pending = state.restartPreparation;
  if (
    pending &&
    (pending.targetSha !== proof.targetSha ||
      pending.targetTreeSha !== proof.targetTreeSha)
  ) {
    throw new Error(
      "Resume preparation target changed; restore the exact prepared boundary.",
    );
  }
  const startupRecovery =
    !pending && state.generation > 0 && !state.executionStartedAt;
  const preservedSourceIds =
    pending?.preservedSourceIds ??
    restartPreservedSourceIds(state, proof.targetSha);
  const resources =
    pending?.resources ??
    (startupRecovery
      ? []
      : await inventoryResumeResources({
          state,
          git,
          root: join(store.lease.paths.worktrees, state.run.id),
          preservedSourceIds,
          deliveredCandidateIds: restartDeliveredCandidateIds(
            state,
            proof.targetSha,
          ),
        }));
  if (pending) {
    for (const resource of resources) {
      await inspectResumeResource(
        git,
        join(store.lease.paths.worktrees, state.run.id),
        resource,
      );
    }
  }
  const remainingSteps = startupRecovery
    ? ["Recover startup in the activated generation"]
    : [
        ...(!pending?.progress.transactionsSettled
          ? [
              "Settle exact landed publications; abandon provably unlanded intents",
            ]
          : []),
        ...(!pending?.progress.projectionSettled
          ? ["Project delivered task checkboxes"]
          : []),
        ...resources
          .filter((resource) => resource.status === "pending")
          .map((resource) => `Discard ${resource.path} (${resource.branch})`),
        "Validate the exact target and activate",
      ];
  return {
    runId: state.run.id,
    generation:
      pending?.generation ??
      (startupRecovery ? state.generation : state.generation + 1),
    startupRecovery,
    preservedSourceIds,
    discardedSourceIds:
      pending?.resetSourceIds ??
      Object.keys(state.workstreams.source).filter(
        (id) => !preservedSourceIds.includes(id),
      ),
    resources,
    remainingSteps,
  };
}

export function formatResumePreview(value: ResumePreview): string {
  return [
    `Resume ${value.runId} · generation ${value.generation}${value.startupRecovery ? " (startup recovery)" : ""}`,
    `Preserve delivered lanes: ${value.preservedSourceIds.join(", ") || "none"}`,
    `Discard unpublished execution: ${value.discardedSourceIds.join(", ") || "none"}`,
    "Retain the original complete plan, findings and durable evidence. Fresh whole-plan review remains required.",
    "Remaining preparation:",
    ...value.remainingSteps.map((step) => `- ${step}`),
    "Confirm disposal of unfinished changes inside these proven owned workspaces? No unpublished candidate will be salvaged.",
  ].join("\n");
}

/** Holds exclusive ownership across observation, user confirmation, preparation and actor handoff. */
export async function openResume(args: {
  checkoutRoot: string;
  runId: string;
}): Promise<{
  preview: ResumePreview;
  confirm(onPreparation?: (state: RunState) => void): Promise<PreparedResume>;
  release(): Promise<void>;
}> {
  const git = new ExecGitClient(args.checkoutRoot);
  const lease = await acquireCheckoutLease({
    ...args,
    gitDir: await git.checkoutIdentity(),
    timeoutMs: 10_000,
    retained: true,
  });
  try {
    const listed = loadCheckoutRun(args.checkoutRoot, args.runId);
    if (listed.phase === "completed") {
      throw new Error("Completed runs use Restart, not Resume.");
    }
    const store = RunStore.open(
      lease,
      join(lease.paths.runs, args.runId, "run-state.json"),
    );
    const initial = await preview(store, git);
    return {
      preview: initial,
      release: () => lease.release(),
      async confirm(onPreparation) {
        const report = () => {
          try {
            onPreparation?.(store.read());
          } catch {
            // Presentation is not preparation authority.
          }
        };
        try {
          const current = await preview(store, git);
          if (JSON.stringify(initial) !== JSON.stringify(current)) {
            throw new Error(
              "Resume observations changed during confirmation; select Resume again to inspect them.",
            );
          }
          await store.prepareRestart(
            await preflightRestart(store, git),
            current.resources,
          );
          if (store.read().restartPreparation) {
            report();
            const progress = async (
              change: (
                preparation: NonNullable<RunState["restartPreparation"]>,
              ) => void,
            ) => {
              const state = store.read();
              const preparation = state.restartPreparation!;
              change(preparation);
              preparation.blockers = [];
              await store.recordRestartProgress(state.revision, preparation);
              report();
            };
            await settlePublicationTransactions({ store, git });
            await progress((preparation) => {
              preparation.progress.transactionsSettled = true;
            });
            await settleProjectionTransactions({ store });
            await progress((preparation) => {
              preparation.progress.projectionSettled = true;
            });
            for (const resource of store.read().restartPreparation!.resources) {
              await retireResumeResource(
                git,
                join(lease.paths.worktrees, args.runId),
                resource,
              );
              if (resource.status !== "retired") {
                await progress((preparation) => {
                  preparation.resources.find(
                    (item) => item.id === resource.id,
                  )!.status = "retired";
                });
              }
            }
            await preflightRestart(store, git);
            await progress((preparation) => {
              preparation.progress.targetValidated = true;
            });
          }
          await store.activateRestart(await preflightRestart(store, git));
          report();
          return { runId: args.runId, lease, store, git };
        } catch (error) {
          const state = store.read();
          if (state.restartPreparation) {
            await store.recordRestartProgress(state.revision, {
              ...state.restartPreparation,
              blockers: [
                error instanceof Error ? error.message : String(error),
              ],
            });
            report();
          }
          throw error;
        }
      },
    };
  } catch (error) {
    await lease.release();
    throw error;
  }
}
