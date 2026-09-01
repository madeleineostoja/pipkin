import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
  toolCallRenderer,
  toolResultRenderer,
} from "#lib/ui/tool-result-renderer";

type McpInput = {
  tool?: string;
  connect?: string;
  describe?: string;
  instructions?: string;
  search?: string;
  server?: string;
  action?: string;
};

type ResultLike = {
  content: unknown;
  details?: unknown;
  isError?: boolean;
};

type RenderOptions = { expanded: boolean; isPartial: boolean };
type RenderContext = {
  isError?: boolean;
  args?: unknown;
  isPartial?: boolean;
  invalidate?: () => void;
  state?: { hasToolOutput?: boolean };
};

type Details = Record<string, unknown>;

export const renderMcpCall = toolCallRenderer<McpInput>({
  name: "mcp",
  detail: mcpCallDetail,
  pending: (input) => mcpPendingText(input),
});

export const renderMcpScriptCall = toolCallRenderer({
  name: "mcpScript",
  pending: "Running MCP script…",
});

const renderResult = toolResultRenderer({
  summary: mcpSummary,
  partial: (_result, context) =>
    isScript(context.args) ? "Running MCP script…" : "Running MCP operation…",
  error: (result) => firstText(result.content) || "MCP operation failed.",
});

/** Treat adapter domain errors as visual errors even though the tool call settled normally. */
export function renderMcpResult(
  result: ResultLike,
  options: RenderOptions,
  theme: Theme,
  context: RenderContext = {},
): Component {
  return renderResult(result, options, theme, {
    ...context,
    isError:
      context.isError || result.isError || hasAdapterError(result.details),
  });
}

function mcpCallDetail(input: McpInput): string {
  if (input.tool) {
    return `call ${input.tool}${input.server ? ` @ ${input.server}` : ""}`;
  }
  if (input.connect) {
    return `connect ${input.connect}`;
  }
  if (input.describe) {
    return `describe ${input.describe}`;
  }
  if (input.instructions) {
    return `instructions ${input.instructions}`;
  }
  if (input.search) {
    return `search ${input.search}${input.server ? ` @ ${input.server}` : ""}`;
  }
  if (input.action) {
    return `${input.action}${input.server ? ` ${input.server}` : ""}`;
  }
  if (input.server) {
    return `list ${input.server}`;
  }
  return "status";
}

function mcpPendingText(input: McpInput): string {
  if (input.connect) {
    return `Connecting to ${input.connect}…`;
  }
  if (input.tool) {
    return "Calling external tool…";
  }
  if (input.search) {
    return "Searching MCP tools…";
  }
  if (input.action?.startsWith("auth-")) {
    return "Processing authentication…";
  }
  return "Querying MCP…";
}

function mcpSummary(
  result: ResultLike,
  context: RenderContext,
): string | readonly string[] {
  const value = details(result.details);
  const mode = value.mode;
  if (mode === "status") {
    const servers = Array.isArray(value.servers)
      ? value.servers.filter(
          (server) =>
            typeof server === "object" &&
            server !== null &&
            (server as { disabled?: unknown }).disabled !== true,
        ).length
      : 0;
    return `MCP status · ${number(value.connectedCount)}/${servers} connected · ${number(value.totalTools)} tools`;
  }
  if (mode === "list") {
    return `${string(value.server, "MCP server")} · ${number(value.count)} tools${value.cached === true ? " · cached" : ""}`;
  }
  if (mode === "search") {
    return `MCP search · ${number(value.count)} matches${value.hasMore === true ? " · more available" : ""}`;
  }
  if (mode === "describe") {
    const tool = details(value.tool);
    return `MCP tool · ${string(tool.name, string(value.requestedTool, "description"))}${typeof value.server === "string" ? ` · ${value.server}` : ""}`;
  }
  if (mode === "instructions") {
    return `MCP instructions · ${string(value.server, "server")} · ${number(value.length)} characters`;
  }
  if (mode === "auth-start") {
    if (value.authenticated === true) {
      return `MCP authenticated · ${string(value.server, "server")}`;
    }
    return [
      `MCP authorization started · ${string(value.server, "server")}`,
      "Expand for the authorization URL and callback instructions.",
    ];
  }
  if (mode === "auth-complete") {
    return `MCP authenticated · ${string(value.server, "server")}`;
  }
  if (mode === "call") {
    const server = string(value.server, string(value.hintServer, "server"));
    const tool = string(
      value.tool,
      string(value.requestedTool, string(value.resourceUri, "operation")),
    );
    return `MCP call · ${server}/${tool} · complete`;
  }
  if (mode === "script" || isScript(context.args)) {
    const calls = Array.isArray(value.calls) ? value.calls.length : 0;
    return `MCP script · ${calls} call${calls === 1 ? "" : "s"} · complete`;
  }
  if (typeof value.sessions === "number") {
    return `MCP UI messages · ${value.sessions} session${value.sessions === 1 ? "" : "s"}`;
  }
  return "MCP operation complete.";
}

function details(value: unknown): Details {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Details)
    : {};
}

function hasAdapterError(value: unknown): boolean {
  return typeof details(value).error === "string";
}

function firstText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  const block = content.find(
    (entry): entry is { type: "text"; text: string } =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as { type?: unknown }).type === "text" &&
      typeof (entry as { text?: unknown }).text === "string",
  );
  return block?.text.split("\n", 1)[0] ?? "";
}

function isScript(value: unknown): boolean {
  return typeof value === "object" && value !== null && "code" in value;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function string(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}
