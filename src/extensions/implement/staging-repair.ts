import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeAtomicJson } from "./atomic-json.js";
import type { ReplayStaging } from "./candidate-replay.js";
import type { FailureCommandEvidence } from "./failure-policy.js";
import type { StagingRepairCompletion } from "./result-schemas.js";
import type {
  ImplementRoles,
  SubagentClient,
  SubagentResult,
} from "./subagents.js";
import { spawnValidatedWorker } from "./worker-invocation.js";

export async function runStagingRepair(args: {
  staging: ReplayStaging;
  command: FailureCommandEvidence;
  subagents: SubagentClient;
  roles: ImplementRoles;
  artifactsPath: string;
  signal?: AbortSignal;
}): Promise<{ retry: boolean; evidence: string }> {
  const packet = {
    completionKind: "staging-repair" as const,
    identity: args.staging.id,
    workspace: { path: args.staging.worktreePath },
    candidateCommitSha: args.staging.candidateCommitSha,
    candidateTreeSha: args.staging.candidateTreeSha,
    targetBaseSha: args.staging.targetBaseSha,
    failedHook: args.command,
  };
  let response: SubagentResult<StagingRepairCompletion>;
  try {
    // Provisioning may create missing runtime roots; host snapshots enforce unchanged source and Git state.
    const handle = await spawnValidatedWorker({
      packet,
      subagents: args.subagents,
      roles: args.roles,
      taskId: args.staging.id,
      description: "Repair staging hook environment",
      render: (
        input,
      ) => `Repair the environment for one rejected publication commit hook in this assigned disposable staging worktree.

Read repository guidance and the relevant hook/setup code. Use repository-prescribed preparation to repair missing or stale installed dependencies or other disposable runtime state. Do not guess an installer when the repository does not establish one. Follow host/devcontainer restrictions.

Change only ignored runtime state inside this workspace, temporary files, and ordinary tool caches permitted by repository guidance. Do not change tracked files, create nonignored files, stage, commit, reset, switch branches, or start a Git operation. Do not alter hooks or Git configuration, disable hooks, weaken checks, or access the target checkout or candidate worktree. If a source correction is required, report blocked with concrete evidence instead of editing it here.

Do not run the commit yourself. Report retry only if an environment repair justifies one host-owned ordinary commit retry with hooks enabled; otherwise report blocked. This assignment has one attempt, not an open-ended repair loop.

${JSON.stringify(input, null, 2)}`,
    });
    response = await args.subagents.waitFor<StagingRepairCompletion>(
      handle,
      args.signal,
    );
  } catch (error) {
    response = {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  mkdirSync(args.artifactsPath, { recursive: true });
  const artifactPath = join(
    args.artifactsPath,
    `staging-repair-${args.staging.id}.json`,
  );
  writeAtomicJson(artifactPath, { packet, response });
  return {
    retry:
      response.status === "completed" && response.result.outcome === "retry",
    evidence: `${response.status === "completed" ? response.result.summary : response.error} Evidence: ${artifactPath}`,
  };
}
