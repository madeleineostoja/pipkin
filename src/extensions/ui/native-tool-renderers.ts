import type {
  CodemodeToolDetails,
  Theme,
  ThemeColor,
  ToolRendererResolver,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import {
  compactDisplayText,
  toolCallRenderer,
  toolResultRenderer,
} from "#lib/ui/tool-result-renderer";
import { formatDuration } from "#lib/ui/metrics";
import type { CodemodeProgress } from "./codemode-progress.js";

type NativeResult = Parameters<ReturnType<typeof toolResultRenderer>>[0];
type NestedCall = CodemodeToolDetails["calls"][number];
type TextBlock = { type: "text"; text: string };
type CompactRenderers = Required<
  Pick<ToolRenderers, "renderCall" | "renderResult">
>;
type NativeRenderContext = Omit<
  Parameters<NonNullable<ToolRenderers["renderCall"]>>[2],
  "state"
> & {
  state: {
    sawPending?: boolean;
    hasToolOutput?: boolean;
    expandedCallRendered?: boolean;
  };
};

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

const renderCodemodeSummary = toolResultRenderer({
  summary: (result, context) => scriptSummary(result, false, context.expanded),
  partial: (result) => ["Running script…", callSummary(result) ?? ""],
  error: (result, context) => scriptSummary(result, true, context.expanded),
  tone(result, context) {
    return context.isError
      ? "error"
      : calls(result).some(
            (call) => call.status === "error" || call.status === "cancelled",
          )
        ? "warning"
        : "toolOutput";
  },
  expandedCompleteDetails: (result, context) => [
    stringProperty(context.args, "code") ?? "",
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
});

const COMPACT_CALL_LIMIT = 8;
const callStyles: Record<
  NestedCall["status"],
  { icon: string; color: ThemeColor }
> = {
  running: { icon: "…", color: "toolOutput" },
  ok: { icon: "✓", color: "success" },
  error: { icon: "✗", color: "error" },
  cancelled: { icon: "⊘", color: "muted" },
};

function previewString(preview: string, field: string): string | undefined {
  try {
    return stringProperty(JSON.parse(preview), field);
  } catch {
    // Pi truncates previews at 200 characters. Recover only a complete leading
    // string field; later or incomplete values stay omitted rather than guessed.
    try {
      const leading = new RegExp(
        `^\\{\\s*"${field}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`,
        "u",
      ).exec(preview);
      return leading ? JSON.parse(leading[1]!) : undefined;
    } catch {
      return undefined;
    }
  }
}

function destination(preview: string): string | undefined {
  const value = previewString(preview, "url");
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? `${url.origin}${url.pathname}`
      : undefined;
  } catch {
    return undefined;
  }
}

function nestedCallDetail(call: NestedCall): string {
  const field = (name: string) => previewString(call.args, name);
  let detail: string | undefined;
  if (["read", "write", "edit"].includes(call.name)) {
    detail = field("path");
  } else if (call.name.startsWith("lsp_")) {
    detail = field("file");
  } else if (call.name === "agent_start" || call.name === "process_start") {
    detail = field("description");
    if (!detail && call.name === "agent_start") {
      detail = field("type");
    }
  } else if (
    /^(?:agent_(?:inspect|wait|stop|steer)|process_(?:inspect|wait|stop))$/u.test(
      call.name,
    )
  ) {
    detail = field("id");
  } else if (
    ["web_fetch", "browser_navigate", "browser_open_tab"].includes(call.name)
  ) {
    detail = destination(call.args);
  } else if (
    call.name === "browser_switch_tab" ||
    call.name === "browser_close_tab"
  ) {
    detail = field("tabId");
  } else if (call.name === "browser_history") {
    detail = field("action");
  } else if (call.name.startsWith("browser_")) {
    try {
      const target = property(JSON.parse(call.args), "target");
      if (stringProperty(target, "kind") === "ref") {
        detail = stringProperty(target, "value");
      }
    } catch {
      // A truncated target preview is not a complete snapshot ref.
    }
  } else if (call.name === "implement_inspect") {
    detail = field("runId");
  } else if (call.name === "papercut_get" || call.name === "papercut_record") {
    detail = field("key");
  }
  return compactDisplayText(detail, 120);
}

function codemodeRenderers(progress?: CodemodeProgress): CompactRenderers {
  return {
    renderCall(args: unknown, theme: Theme, context: NativeRenderContext) {
      // Live rows observe a pre-execution phase; HTML exports start after execution
      // and serialize their call header once, so must never acquire a pending label.
      if (!context.executionStarted) {
        context.state.sawPending = true;
      }
      const elapsed = context.isPartial
        ? progress?.elapsed(context.toolCallId, context.invalidate)
        : undefined;
      const identity = toolCallRenderer({
        name: "codemode",
        detail: () =>
          elapsed === undefined ? undefined : `· ${formatDuration(elapsed)}`,
        pending: false,
      })(args, theme, context);
      if (
        !context.isPartial ||
        !context.state.sawPending ||
        context.state.hasToolOutput
      ) {
        return identity;
      }
      const view = new Container();
      view.addChild(identity);
      view.addChild(
        new Text(
          theme.fg(
            "muted",
            context.executionStarted ? "Running script…" : "Preparing script…",
          ),
          0,
          0,
        ),
      );
      return view;
    },
    renderResult(result, options, theme, context) {
      const summary = renderCodemodeSummary(result, options, theme, context);
      const nested = calls(result);
      if (options.expanded || nested.length === 0) {
        return summary;
      }
      const view = new Container();
      view.addChild(summary);
      if (nested.length > COMPACT_CALL_LIMIT) {
        const hidden = nested.length - COMPACT_CALL_LIMIT;
        view.addChild(
          new Text(
            theme.fg(
              "muted",
              `${hidden} earlier ${hidden === 1 ? "call" : "calls"} hidden — expand to inspect.`,
            ),
            0,
            0,
          ),
        );
      }
      for (const call of nested.slice(-COMPACT_CALL_LIMIT)) {
        const style = callStyles[call.status];
        const detail = nestedCallDetail(call);
        view.addChild(
          new Text(
            theme.fg(
              style.color,
              `${style.icon} ${compactDisplayText(call.name)}`,
            ) + (detail ? theme.fg("toolOutput", ` ${detail}`) : ""),
            0,
            0,
          ),
        );
      }
      return view;
    },
  };
}

function compactWithNativeExpansion(
  compact: CompactRenderers,
  next: () => ToolRenderers | undefined,
  progress?: CodemodeProgress,
): ToolRenderers {
  return {
    renderCall(args: unknown, theme: Theme, context: NativeRenderContext) {
      const nativeCall = context.expanded ? next()?.renderCall : undefined;
      context.state.expandedCallRendered = Boolean(nativeCall);
      // Native renderers may reuse incompatible compact components when toggling expansion.
      if (!nativeCall) {
        return compact.renderCall(args, theme, context);
      }
      const output = nativeCall(args, theme, {
        ...context,
        lastComponent: undefined,
      });
      const elapsed = context.isPartial
        ? progress?.elapsed(context.toolCallId, context.invalidate)
        : undefined;
      if (elapsed === undefined) {
        return output;
      }
      const view = new Container();
      view.addChild(
        new Text(theme.fg("muted", `Elapsed ${formatDuration(elapsed)}`), 0, 0),
      );
      view.addChild(output);
      return view;
    },
    renderResult(result, options, theme, context: NativeRenderContext) {
      const native = options.expanded ? next() : undefined;
      if (!native?.renderResult) {
        return compact.renderResult(result, options, theme, context);
      }
      const nativeContext = { ...context, lastComponent: undefined };
      const output = native.renderResult(result, options, theme, nativeContext);
      if (context.state.expandedCallRendered || !native.renderCall) {
        return output;
      }
      // HTML exports expand only results: include the native call view to retain script/arguments.
      const view = new Container();
      view.addChild(
        native.renderCall(context.args, theme, {
          ...nativeContext,
          expanded: true,
        }),
      );
      view.addChild(output);
      return view;
    },
  };
}

/** Presentation only: execution, discovery, authentication, and result data stay native. */
export function resolveNativeToolRenderers(
  name: Parameters<ToolRendererResolver>[0],
  next: Parameters<ToolRendererResolver>[1],
  progress?: CodemodeProgress,
): ReturnType<ToolRendererResolver> {
  if (name === "codemode") {
    return compactWithNativeExpansion(
      codemodeRenderers(progress),
      next,
      progress,
    );
  }
  if (name === "tool_search") {
    return compactWithNativeExpansion(searchRenderers, next);
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) {
    return compactWithNativeExpansion(
      {
        renderCall: toolCallRenderer({
          name: `${mcp[1]}/${mcp[2]}`,
          detail: argumentPreview,
          pending: false,
        }),
        renderResult: renderMcpResult,
      },
      next,
    );
  }
  return next();
}
