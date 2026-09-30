import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  toolCallRenderer,
  toolResultRenderer,
} from "#lib/ui/tool-result-renderer";
import {
  outputScope,
  transcriptEntryIdentity,
  entryFingerprint,
  boundedPreview,
  metadataPreview,
} from "./retained-output.ts";
import {
  ContentSchema,
  OutputListSchema,
  OutputSelector,
  PageParams,
  ReadOutputSchema,
} from "./output-contract.ts";
import { selectOutput } from "./output-selection.ts";
import { Value } from "typebox/value";
const namespace = {
  name: "execution",
  description:
    "Run commands, manage session processes, and retrieve immutable authorized output.",
};
const renderResult = toolResultRenderer({
  summary: () => "Retrieved authorized output.",
  error: () => "Output retrieval failed.",
});
export function registerOutputTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "output_list",
    label: "output_list",
    exposure: "deferred",
    namespace,
    annotations: { readOnlyHint: true, openWorldHint: false },
    description:
      "List bounded metadata of execution captures authorized by raw active history; never output bodies.",
    parameters: PageParams,
    outputSchema: OutputListSchema,
    renderCall: toolCallRenderer({
      name: "output_list",
      pending: "Listing retained outputs…",
    }),
    renderResult,
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const page = outputScope(pi.events).list(
          ctx,
          params.offset,
          params.limit,
        );
        const payload = { ok: true, ...page };
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          structuredContent: payload,
          details: { count: payload.outputs.length },
        };
      } catch {
        const payload = {
          ok: false,
          error: {
            code: "invalid_arguments",
            message: "Output list unavailable or invalid pagination.",
          },
          outputs: [],
          count: 0,
          truncated: false,
        };
        return {
          content: [{ type: "text", text: payload.error.message }],
          structuredContent: payload,
          details: undefined,
          isError: true,
        };
      }
    },
  });
  pi.registerTool({
    name: "read_output",
    label: "read_output",
    exposure: "deferred",
    namespace,
    annotations: { readOnlyHint: true, openWorldHint: false },
    description:
      "Read an immutable execution capture or original transcript entry without replaying execution. Selectors require one textual source. Forward returned image blocks explicitly with image(block), not the whole JSON payload.",
    parameters: Type.Object(
      {
        reference: Type.String({
          minLength: 1,
          maxLength: 800,
          description:
            "Opaque 1..800-character output or transcript reference from output_list or a pruning stub.",
        }),
        selector: Type.Optional(OutputSelector),
      },
      { additionalProperties: false },
    ),
    outputSchema: ReadOutputSchema,
    renderCall: toolCallRenderer({
      name: "read_output",
      pending: "Reading retained output…",
    }),
    renderResult,
    async execute(_id, params, _signal, _update, ctx) {
      let code = "not_found";
      try {
        const identity = transcriptEntryIdentity(params.reference);
        const record = identity
          ? undefined
          : outputScope(pi.events).read(params.reference, ctx);
        const entry = identity
          ? ctx.sessionManager
              .getBranch()
              .find(
                (entry) =>
                  entry.id === identity.id &&
                  entryFingerprint(entry) === identity.fingerprint,
              )
          : undefined;
        const message =
          entry?.type === "message" && entry.message.role === "toolResult"
            ? entry.message
            : undefined;
        const content = record
          ? [{ type: "text" as const, text: record.text }]
          : message?.content;
        if (!content || !Value.Check(ContentSchema, content)) {
          throw new Error("Output not found.");
        }
        code = "invalid_arguments";
        const selected = selectOutput(content, params.selector);
        const source = record
          ? {
              ...record.source,
              execution: record.execution,
              outputComplete: record.outputComplete,
              droppedBytes: record.droppedBytes,
            }
          : {
              sourceTool:
                typeof message!.toolName === "string"
                  ? boundedPreview(metadataPreview(message!.toolName).text, 120)
                      .text || "tool"
                  : "tool",
              ...(typeof message!.isError === "boolean"
                ? { isError: message!.isError }
                : {}),
              ...(typeof message!.toolCallId === "string" &&
              Buffer.byteLength(message!.toolCallId) <= 512 &&
              !/\p{C}/u.test(message!.toolCallId)
                ? { callId: message!.toolCallId }
                : {}),
            };
        const payload = {
          ok: true,
          reference: params.reference,
          source,
          ...selected,
          truncated: selected.truncated || (record?.truncated ?? false),
        };
        return {
          content: payload.content,
          structuredContent: payload,
          details: {
            sourceTool: source.sourceTool,
            selection: payload.selection,
          },
        };
      } catch (error) {
        const payload = {
          ok: false,
          error: {
            code,
            message:
              code === "not_found"
                ? "Output not found."
                : error instanceof Error
                  ? error.message
                  : "Invalid selection.",
          },
          reference: params.reference,
          content: [],
          truncated: false,
        };
        return {
          content: [{ type: "text", text: payload.error.message }],
          structuredContent: payload,
          details: undefined,
          isError: true,
        };
      }
    },
  });
}
