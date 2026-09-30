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

const TOOL_DESCRIPTION = `Record factual avoidable friction encountered incidentally while completing a different assigned subject, only after exercising at least one workaround or detour and completing or safely continuing the task. Each workaround must be an action actually taken, not a suggestion. No outage, exception, failed command or run, or user-visible failure is required.

Before recording, use papercut_list and, as needed, papercut_get to check equivalent existing open and closed findings. Skip an already-recorded incident; reuse the existing key for an independently encountered recurrence, and create a new key only for materially different friction. Deduplication does not authorize discussing or addressing existing findings.

Do not record the task subject, review findings or unmet requirements, unresolved correctness or safety issues, inferred architecture, unused suggestions, expected proportionate guided steps, adequately documented proportionate procedures, one-off agent mistakes, typos, malformed commands, or transient service/provider failures. Qualifying examples include a flaky documented test handled with a narrower command, an undocumented validation convention discovered and used, avoidable manual worktree setup, context reconstruction, or ambiguous output followed by a concrete workaround.

This tool writes personal registry metadata only, not source or Git changes. Findings are candidates for future guidance or fixes, not authorization to implement them. Qualification is trusted-agent policy, not runtime classification; discovery and codemode confer no additional authority or permission to automatically record arbitrary failures.`;

type PapercutStatusController = ReturnType<
  typeof createPapercutStatusController
>;

export function registerRecordTool(
  pi: ExtensionAPI,
  status: PapercutStatusController,
): void {
  pi.registerTool({
    name: "papercut_record",
    exposure: "direct",
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
