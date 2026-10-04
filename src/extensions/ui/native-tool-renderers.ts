import type {
  CodemodeToolDetails,
  ToolRendererResolver,
} from "@earendil-works/pi-coding-agent";
import {
  compactDisplayText,
  toolCallRenderer,
  toolResultRenderer,
} from "#lib/ui/tool-result-renderer";
import { formatDuration, formatUsdCost } from "#lib/ui/metrics";

type NativeResult = Parameters<ReturnType<typeof toolResultRenderer>>[0];
type NestedCall = CodemodeToolDetails["calls"][number];
type TextBlock = { type: "text"; text: string };

const SCRIPT_HEADER =
  /^Script (completed|failed)\nWall time ([\d.]+) seconds\nOutput:\n$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function property(value: unknown, name: string): unknown {
  return isRecord(value) ? value[name] : undefined;
}

function stringProperty(value: unknown, name: string): string | undefined {
  const field = property(value, name);
  return typeof field === "string" ? field : undefined;
}

function isTextBlock(value: unknown): value is TextBlock {
  return (
    isRecord(value) && value.type === "text" && typeof value.text === "string"
  );
}

function textBlocks(result: NativeResult): TextBlock[] {
  return Array.isArray(result.content)
    ? result.content.filter(isTextBlock)
    : [];
}

function outputPath(result: NativeResult): string | undefined {
  const path = stringProperty(result.details, "fullOutputPath");
  return path ? `Full output: ${path}` : undefined;
}

function preview(result: NativeResult): string | undefined {
  return compactDisplayText(textBlocks(result)[0]?.text) || undefined;
}

function argumentPreview(args: unknown): string | undefined {
  return args === undefined ? undefined : JSON.stringify(args);
}

function expandedArguments(args: unknown): string | undefined {
  return args === undefined ? undefined : JSON.stringify(args, null, 2);
}

const renderMcpResult = toolResultRenderer({
  summary: (result, context) => [
    preview(result) ?? "Completed.",
    context.expanded ? "" : (outputPath(result) ?? ""),
  ],
  partial: () => "Waiting for MCP result…",
  error: (result, context) => [
    preview(result) ?? "MCP request failed.",
    context.expanded ? "" : (outputPath(result) ?? ""),
  ],
  expandedCompleteDetails: (result, context) => [
    expandedArguments(context.args) ?? "",
    outputPath(result) ?? "",
  ],
});

function loadedTools(result: NativeResult): string[] | undefined {
  const loaded = property(result.details, "loaded");
  return Array.isArray(loaded)
    ? loaded.filter((name): name is string => typeof name === "string")
    : undefined;
}

const searchRenderers = {
  renderCall: toolCallRenderer({
    name: "tool_search",
    detail: (args: unknown) => stringProperty(args, "query"),
    pending: false,
  }),
  renderResult: toolResultRenderer({
    summary(result) {
      const loaded = loadedTools(result);
      return loaded
        ? loaded.length === 0
          ? "No matching tools found."
          : `Loaded ${loaded.length} tool${loaded.length === 1 ? "" : "s"}.`
        : (preview(result) ?? "Tool search completed.");
    },
    partial: () => "Finding tools…",
    error: (result) => preview(result) ?? "Tool search failed.",
    expandedCompleteDetails: (result, context) => [
      expandedArguments(context.args) ?? "",
      ...(loadedTools(result) ?? []),
    ],
  }),
};

function isNestedCall(value: unknown): value is NestedCall {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.args === "string" &&
    (value.status === "running" ||
      value.status === "ok" ||
      value.status === "error" ||
      value.status === "cancelled") &&
    (value.durationMs === undefined ||
      (typeof value.durationMs === "number" &&
        Number.isFinite(value.durationMs))) &&
    (value.cost === undefined ||
      (typeof value.cost === "number" && Number.isFinite(value.cost))) &&
    (value.error === undefined || typeof value.error === "string")
  );
}

function calls(result: NativeResult): NestedCall[] {
  const nested = property(result.details, "calls");
  return Array.isArray(nested) ? nested.filter(isNestedCall) : [];
}

function callSummary(result: NativeResult): string | undefined {
  const nested = calls(result);
  if (nested.length === 0) {
    return undefined;
  }
  const counts = { running: 0, ok: 0, error: 0, cancelled: 0 };
  for (const call of nested) {
    counts[call.status]++;
  }
  return [
    `${nested.length} calls`,
    `${counts.ok} succeeded`,
    ...(counts.running ? [`${counts.running} running`] : []),
    ...(counts.error ? [`${counts.error} failed`] : []),
    ...(counts.cancelled ? [`${counts.cancelled} cancelled`] : []),
  ].join(" · ");
}

function scriptSummary(
  result: NativeResult,
  failed: boolean,
  expanded: boolean | undefined,
): string[] {
  const blocks = textBlocks(result);
  const header = SCRIPT_HEADER.exec(blocks[0]?.text ?? "");
  const elapsed = header
    ? ` · ${formatDuration(Number(header[2]) * 1000)}`
    : "";
  const error = failed
    ? compactDisplayText(
        blocks.find((block) => block.text.startsWith("Script error:"))?.text ??
          (header ? undefined : blocks[0]?.text),
      )
    : "";
  return [
    `Script ${failed ? "failed" : "completed"}.${elapsed}`,
    callSummary(result) ?? "",
    expanded ? "" : (outputPath(result) ?? error),
  ];
}

function expandedCalls(result: NativeResult): string[] {
  return calls(result).map((call) => {
    const duration =
      call.durationMs === undefined
        ? ""
        : ` · ${call.durationMs < 1000 ? `${Math.round(call.durationMs)}ms` : formatDuration(call.durationMs)}`;
    const cost =
      call.cost === undefined
        ? ""
        : ` · ${call.cost > 0 && call.cost < 0.01 ? `$${call.cost.toPrecision(2)}` : formatUsdCost(call.cost)}`;
    return `${call.name} · ${call.status}${duration}${cost}${call.args ? `\nArguments: ${call.args}` : ""}${call.error ? `\nError: ${call.error}` : ""}`;
  });
}

const codemodeRenderers = {
  renderCall: toolCallRenderer({
    name: "codemode",
    pending: false,
  }),
  renderResult: toolResultRenderer({
    summary: (result, context) =>
      scriptSummary(result, false, context.expanded),
    partial: (result) => ["Running script…", callSummary(result) ?? ""],
    error: (result, context) => scriptSummary(result, true, context.expanded),
    tone(result, context) {
      return context.isError
        ? "error"
        : context.isPartial ||
            calls(result).some(
              (call) =>
                call.status === "error" ||
                call.status === "cancelled" ||
                call.status === "running",
            )
          ? "warning"
          : "toolOutput";
    },
    expandedCompleteDetails: (result, context) => [
      stringProperty(context.args, "code") ?? "",
      ...expandedCalls(result),
      outputPath(result) ?? "",
    ],
    expandedContent(result) {
      const content = result.content;
      // Strip only Pi's standalone status header, never arbitrary script output or rejection text.
      return Array.isArray(content) &&
        isTextBlock(content[0]) &&
        SCRIPT_HEADER.test(content[0].text)
        ? content.slice(1)
        : content;
    },
  }),
};

/**
 * Presentation only: execution, discovery, authentication, and result data stay native.
 * HTML exports never expand call headers and mark them partial even after settlement,
 * so arguments/scripts live in expanded results and pending labels stay out of calls.
 */
export const resolveNativeToolRenderers: ToolRendererResolver = (
  name,
  next,
) => {
  if (name === "codemode") {
    return codemodeRenderers;
  }
  if (name === "tool_search") {
    return searchRenderers;
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) {
    return {
      renderCall: toolCallRenderer({
        name: `${mcp[1]}/${mcp[2]}`,
        detail: argumentPreview,
        pending: false,
      }),
      renderResult: renderMcpResult,
    };
  }
  return next();
};
