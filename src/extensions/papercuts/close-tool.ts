import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  toolCallRenderer,
  toolResultRenderer,
} from "#lib/ui/tool-result-renderer";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { createPapercutStoreForCwd, PapercutNotFoundError } from "./store.js";
import type { createPapercutStatusController } from "./status.js";
import {
  PapercutKeySchema,
  PapercutCloseResultSchema,
  papercutError,
  papercutToolResult,
  publicFinding,
  type PapercutCloseResult,
} from "./tool-contract.js";

const PapercutCloseSchema = Type.Object(
  { key: PapercutKeySchema },
  { additionalProperties: false },
);

export function registerCloseTool(
  pi: ExtensionAPI,
  status: ReturnType<typeof createPapercutStatusController>,
): void {
  pi.registerTool({
    name: "papercut_close",
    exposure: "deferred",
    namespace: {
      name: "papercuts",
      description:
        "Inspect, record, or explicitly close incidental friction under the personal registry policy, never a proactive work queue.",
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    label: "papercut_close",
    description:
      "Close one existing Papercut finding by exact key when the user explicitly asks for or authorizes closure. Available only in the parent session, not workers. Inspection, deduplication, or implementing a fix does not by itself authorize closure. Preserves the observation, occurrence count, and timestamps; closing an already closed finding succeeds, and a later qualifying recurrence can reopen it. Writes only controlled personal registry metadata, not source or Git changes. Use this tool instead of editing the protected registry directly; discovery and codemode grant no additional authority.",
    parameters: PapercutCloseSchema,
    outputSchema: PapercutCloseResultSchema,
    renderCall: toolCallRenderer({
      name: "papercut_close",
      detail: (args: Static<typeof PapercutCloseSchema>) => args.key,
      pending: "Closing papercut…",
    }),
    renderResult: toolResultRenderer({
      summary(result) {
        return (
          (result.details as { summary?: string } | undefined)?.summary ??
          "Papercut closure unavailable"
        );
      },
      partial: () => "Closing papercut…",
      error(result) {
        return (
          (result.details as { summary?: string } | undefined)?.summary ??
          "Papercut closure failed."
        );
      },
    }),
    async execute(_id, params, _signal, _update, ctx) {
      if (!Check(PapercutCloseSchema, params)) {
        return papercutToolResult(
          papercutError(
            "invalid_arguments",
            "Expected an exact lowercase finding key of 1..64 characters; no extra fields.",
          ),
          "Invalid papercut close arguments",
        );
      }
      try {
        const store = await createPapercutStoreForCwd(ctx.cwd);
        const record = await store.close(params.key);
        await status.refreshStatus(ctx);
        const { key, title, occurrences } = publicFinding(record);
        const result: PapercutCloseResult = {
          ok: true,
          key,
          title,
          status: "closed",
          occurrences,
        };
        return papercutToolResult(result, `Closed · ${key}`);
      } catch (error) {
        return papercutToolResult(
          papercutError(
            error instanceof PapercutNotFoundError
              ? "not_found"
              : "persistence_failed",
            error instanceof Error ? error.message : "Papercut closure failed.",
          ),
          error instanceof PapercutNotFoundError
            ? "Papercut not found"
            : "Papercut was not closed: persistence failed",
        );
      }
    },
  });
}
