import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  toolCallRenderer,
  toolResultRenderer,
} from "#lib/ui/tool-result-renderer";
import { Check } from "typebox/value";
import type { PapercutObservation } from "./store.js";
import { createPapercutStatusController } from "./status.js";
import {
  PapercutObservationSchema,
  PapercutRecordResultSchema,
  papercutError,
  papercutToolResult,
  publicFinding,
  type PapercutRecordResult,
} from "./tool-contract.js";

const TOOL_DESCRIPTION = `Record factual incidental friction only when all of these are true: while completing an assigned subject that was something else, you concretely encountered avoidable friction, actually exercised at least one workaround or detour, and then completed or safely continued the task. No outage, exception, failed command or run, or user-visible failure is required. Examples: recover from a flaky documented test with a narrower command; discover an undocumented validation convention and use it; or perform an avoidable manual worktree setup sequence and safely continue. Qualifying friction includes context reconstruction or ambiguous output. Each workaround is an action actually taken, not a suggestion.

Do not record the current task subject, a review finding or unmet requirement, unresolved correctness or safety issues, inferred architecture, unused suggestions, expected proportionate guided steps, adequately documented proportionate procedures, one-off agent mistakes, typos, malformed commands, or transient service/provider failures. This trusted-agent instruction is not runtime classification. Before recording, use papercut_list and, as needed, papercut_get to check existing open and closed findings for equivalent friction. Skip if this same incident was already recorded; reuse the existing key for an independently encountered recurrence, and create a new key only for materially different friction. Deduplication inspection does not authorize discussing or addressing existing findings. Records are candidates for repository guidance or small fixes; this tool only writes personal registry metadata. Discovery and codemode confer no additional authority and do not authorize automatic recording of arbitrary failures.`;

type PapercutStatusController = ReturnType<
  typeof createPapercutStatusController
>;

export function registerRecordTool(
  pi: ExtensionAPI,
  status: PapercutStatusController,
): void {
  pi.registerTool({
    name: "papercut_record",
    exposure: "deferred",
    namespace: {
      name: "papercuts",
      description:
        "Read or record incidental friction under the personal registry policy, never a proactive work queue.",
    },
    label: "papercut_record",
    description: TOOL_DESCRIPTION,
    parameters: PapercutObservationSchema,
    outputSchema: PapercutRecordResultSchema,
    renderCall: toolCallRenderer({
      name: "papercut_record",
      detail: (args: PapercutObservation) => `${args.key} · ${args.title}`,
      pending: "Recording papercut…",
    }),
    renderResult: toolResultRenderer({
      summary(result) {
        return (
          (result.details as { summary?: string } | undefined)?.summary ??
          "Papercut recording unavailable"
        );
      },
      partial: () => "Recording papercut…",
      error(result) {
        return (
          (result.details as { summary?: string } | undefined)?.summary ??
          "Papercut recording failed."
        );
      },
    }),
    async execute(
      _id,
      observation: PapercutObservation,
      _signal,
      _update,
      ctx,
    ) {
      if (!Check(PapercutObservationSchema, observation)) {
        return papercutToolResult(
          papercutError(
            "invalid_arguments",
            "Papercut observation fields are invalid; provide the bounded factual record fields and no extra fields.",
          ),
          "Papercut was not recorded: invalid arguments",
        );
      }
      try {
        const result = await (await status.storeFor(ctx)).record(observation);
        if (result.kind === "rejected") {
          return papercutToolResult(
            papercutError("invalid_arguments", result.reason),
            "Papercut was not recorded: invalid arguments",
          );
        }
        await status.refreshStatus(ctx);
        const { key, title, occurrences } = publicFinding(result.record);
        const identity: PapercutRecordResult = {
          ok: true,
          outcome: result.kind,
          key,
          title,
          occurrences,
        };
        return papercutToolResult(
          identity,
          `Recorded · ${result.kind} · ${key}`,
        );
      } catch (error) {
        return papercutToolResult(
          papercutError(
            "persistence_failed",
            error instanceof Error
              ? error.message
              : "Papercut recording failed.",
          ),
          "Papercut was not recorded: persistence failed",
        );
      }
    },
  });
}
