import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  toolCallRenderer,
  toolResultRenderer,
} from "#lib/ui/tool-result-renderer";
import { Type, type Static } from "typebox";
import {
  findPapercut,
  formatPapercutDetail,
  sortedPapercuts,
} from "./inspection.js";
import { createPapercutStoreForCwd } from "./store.js";

const requestSchema = Type.Union(
  [
    Type.Object(
      {
        action: Type.Literal("list", {
          description:
            "List compact finding summaries for deduplication or at the user's request.",
        }),
        status: Type.Optional(
          Type.Union(
            [Type.Literal("open"), Type.Literal("closed"), Type.Literal("all")],
            {
              description:
                "Filter by finding status; omitted means all, including closed findings.",
            },
          ),
        ),
        offset: Type.Optional(
          Type.Integer({
            minimum: 0,
            maximum: 255,
            description:
              "Zero-based offset into the filtered, sorted findings; defaults to 0.",
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
    ),
    Type.Object(
      {
        action: Type.Literal("get", {
          description: "Retrieve all recorded details for one finding.",
        }),
        key: Type.String({
          minLength: 1,
          maxLength: 64,
          pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$",
          description: "Exact stable lowercase key of the finding to inspect.",
        }),
      },
      { additionalProperties: false },
    ),
  ],
  {
    description:
      "Select one read-only operation: list findings or get one finding by key.",
  },
);

export const InspectPapercutsSchema = Type.Object({
  request: requestSchema,
});

type InspectRequest = Static<typeof InspectPapercutsSchema>;

export function registerInspectTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "inspect_papercuts",
    label: "inspect_papercuts",
    description:
      "Read recorded Papercut findings in the current repository. Inspect only when the user asks about a finding, or to check for an equivalent existing finding before recording newly encountered qualifying friction. Include closed findings when checking for duplicates. Do not proactively inspect to find work, and do not discuss or address existing findings merely because a deduplication check found them. Inspection does not authorize implementation or closing a finding.",
    parameters: InspectPapercutsSchema,
    renderCall: toolCallRenderer({
      name: "inspect_papercuts",
      detail: (args: InspectRequest) =>
        args.request.action === "get" ? args.request.key : "list",
      pending: "Inspecting papercuts…",
    }),
    renderResult: toolResultRenderer({
      summary(result) {
        const details = result.details as { summary?: string } | undefined;
        return details?.summary ?? "Papercut inspection unavailable";
      },
      partial() {
        return "Inspecting papercuts…";
      },
      error(result) {
        const content = result.content;
        if (Array.isArray(content)) {
          const text = content.find(
            (block): block is { type: "text"; text: string } =>
              typeof block === "object" &&
              block !== null &&
              block.type === "text" &&
              typeof block.text === "string",
          )?.text;
          if (text) {
            return text.split("\n", 1)[0];
          }
        }
        return "Papercut inspection failed.";
      },
    }),
    async execute(_id, params: InspectRequest, _signal, _update, ctx) {
      try {
        const file = await (await createPapercutStoreForCwd(ctx.cwd)).load();
        const request = params.request;
        if (request.action === "get") {
          const record = findPapercut(file, request.key);
          if (!record) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Papercut not found: ${request.key}`,
                },
              ],
              details: { summary: "Papercut not found" },
            };
          }
          return {
            content: [
              { type: "text" as const, text: formatPapercutDetail(record) },
            ],
            details: { summary: `Papercut · ${record.key} · ${record.status}` },
          };
        }
        const status = request.status === "all" ? undefined : request.status;
        const records = sortedPapercuts(file, status);
        const offset = request.offset ?? 0;
        const page = records.slice(offset, offset + (request.limit ?? 25));
        const lines = [
          `Papercuts: ${records.length} ${request.status ?? "all"} finding${records.length === 1 ? "" : "s"}; showing ${page.length} from offset ${offset}.`,
          ...page.map(
            (record) =>
              `${record.key} · ${record.title} · ${record.status} · ${record.occurrences} occurrence${record.occurrences === 1 ? "" : "s"} · last seen ${record.lastSeenAt}`,
          ),
        ];
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: {
            summary: `Papercuts · ${page.length} of ${records.length} (${request.status ?? "all"})`,
          },
        };
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Papercut inspection failed.";
        return {
          content: [
            {
              type: "text" as const,
              text: `Papercut inspection failed: ${message}`,
            },
          ],
          details: { summary: "Papercut inspection failed" },
        };
      }
    },
  });
}
