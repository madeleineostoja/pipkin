import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  toolCallRenderer,
  toolResultRenderer,
} from "#lib/ui/tool-result-renderer";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { findPapercut } from "./inspection.js";
import { createPapercutStoreForCwd } from "./store.js";
import {
  PapercutKeySchema,
  PapercutListResultSchema,
  PapercutGetResultSchema,
  papercutError,
  papercutToolResult,
  publicFinding,
  type PapercutListResult,
  type PapercutGetResult,
} from "./tool-contract.js";

export const PapercutListSchema = Type.Object(
  {
    status: Type.Optional(
      Type.Union(
        [Type.Literal("open"), Type.Literal("closed"), Type.Literal("all")],
        {
          description:
            "Filter by finding status; omitted means all, including closed findings for deduplication.",
        },
      ),
    ),
    offset: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 255,
        description:
          "Zero-based offset into newest-first findings; defaults to 0.",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 25,
        description:
          "Maximum findings to return, from 1 to 25; defaults to 25.",
      }),
    ),
  },
  { additionalProperties: false },
);
export const PapercutGetSchema = Type.Object(
  { key: PapercutKeySchema },
  { additionalProperties: false },
);

const INSPECT_DESCRIPTION =
  "Read recorded Papercut findings in the current repository. Inspect only when the user asks about a finding, or to check for an equivalent existing finding before recording newly encountered qualifying friction. Include closed findings when checking for duplicates. Do not proactively inspect to find work, and do not discuss or address existing findings merely because a deduplication check found them. Inspection does not authorize implementation or closing a finding. Discovery and codemode confer no additional authority.";

const renderer = toolResultRenderer({
  summary(result) {
    return (
      (result.details as { summary?: string } | undefined)?.summary ??
      "Papercut inspection unavailable"
    );
  },
  partial: () => "Inspecting papercuts…",
  error(result) {
    return (
      (result.details as { summary?: string } | undefined)?.summary ??
      "Papercut inspection failed."
    );
  },
});
const namespace = {
  name: "papercuts",
  description:
    "Read or record incidental friction under the personal registry policy, never a proactive work queue.",
};

export function registerInspectTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "papercut_list",
    exposure: "deferred",
    namespace,
    annotations: { readOnlyHint: true, openWorldHint: false },
    label: "papercut_list",
    description: `Check recorded findings for duplicate incidental friction or answer a user-requested inspection; never use this as a work queue. Returns bounded compact summaries, newest first with a stable key tie-breaker. ${INSPECT_DESCRIPTION}`,
    parameters: PapercutListSchema,
    outputSchema: PapercutListResultSchema,
    renderCall: toolCallRenderer({
      name: "papercut_list",
      pending: "Listing papercuts…",
    }),
    renderResult: renderer,
    async execute(
      _id,
      params: Static<typeof PapercutListSchema>,
      _signal,
      _update,
      ctx,
    ) {
      if (!Check(PapercutListSchema, params)) {
        return papercutToolResult(
          papercutError(
            "invalid_arguments",
            "Expected status open|closed|all, offset 0..255 and limit 1..25; no extra fields.",
          ),
          "Invalid papercut list arguments",
        );
      }
      try {
        const file = await (await createPapercutStoreForCwd(ctx.cwd)).load();
        const records = file.records
          .filter(
            (record) =>
              !params.status ||
              params.status === "all" ||
              record.status === params.status,
          )
          .sort(
            (a, b) =>
              b.lastSeenAt.localeCompare(a.lastSeenAt) ||
              a.key.localeCompare(b.key),
          );
        const offset = params.offset ?? 0;
        const page = records.slice(offset, offset + (params.limit ?? 25));
        const nextOffset = offset + page.length;
        const result: PapercutListResult = {
          ok: true,
          findings: page.map((record) => {
            const { key, title, status, occurrences, lastSeenAt } =
              publicFinding(record);
            return { key, title, status, occurrences, lastSeenAt };
          }),
          offset,
          ...(nextOffset < records.length ? { nextOffset } : {}),
          truncated: false,
        };
        return papercutToolResult(
          result,
          `Papercuts · ${page.length} findings (${params.status ?? "all"})`,
        );
      } catch (error) {
        return papercutToolResult(
          papercutError(
            "unavailable",
            error instanceof Error
              ? error.message
              : "Papercut inspection failed.",
          ),
          "Papercut inspection unavailable",
        );
      }
    },
  });
  pi.registerTool({
    name: "papercut_get",
    exposure: "deferred",
    namespace,
    annotations: { readOnlyHint: true, openWorldHint: false },
    label: "papercut_get",
    description: `Retrieve all recorded details by exact key. ${INSPECT_DESCRIPTION}`,
    parameters: PapercutGetSchema,
    outputSchema: PapercutGetResultSchema,
    renderCall: toolCallRenderer({
      name: "papercut_get",
      detail: (args: Static<typeof PapercutGetSchema>) => args.key,
      pending: "Inspecting papercut…",
    }),
    renderResult: renderer,
    async execute(
      _id,
      params: Static<typeof PapercutGetSchema>,
      _signal,
      _update,
      ctx,
    ) {
      if (!Check(PapercutGetSchema, params)) {
        return papercutToolResult(
          papercutError(
            "invalid_arguments",
            "Expected an exact lowercase finding key of 1..64 characters; no extra fields.",
          ),
          "Invalid papercut get arguments",
        );
      }
      try {
        const file = await (await createPapercutStoreForCwd(ctx.cwd)).load();
        const record = findPapercut(file, params.key);
        if (!record) {
          return papercutToolResult(
            papercutError("not_found", `Papercut not found: ${params.key}`),
            "Papercut not found",
          );
        }
        const result: PapercutGetResult = {
          ok: true,
          finding: publicFinding(record),
        };
        return papercutToolResult(
          result,
          `Papercut · ${record.key} · ${record.status}`,
        );
      } catch (error) {
        return papercutToolResult(
          papercutError(
            "unavailable",
            error instanceof Error
              ? error.message
              : "Papercut inspection failed.",
          ),
          "Papercut inspection unavailable",
        );
      }
    },
  });
}
