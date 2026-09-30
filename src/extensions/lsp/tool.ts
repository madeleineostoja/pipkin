import { existsSync, readFileSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  compactDisplayText,
  toolCallRenderer,
  toolResultRenderer,
} from "#lib/ui/tool-result-renderer";
import { Value } from "typebox/value";
import {
  actions,
  outputFor,
  parametersFor,
  type Action,
  type LspData,
  type ErrorCode,
  type OperationInput,
  type DisplayLocation,
  type DisplaySymbol,
  type ServerState,
} from "./contracts.js";
import {
  isRequestCancelledError,
  isRequestTimeoutError,
  RequestTimeoutError,
} from "./protocol.js";
import {
  normalizeHoverResult,
  normalizeLocations,
  normalizeSymbolsResult,
  safeText,
  type NormalizedLocation,
} from "./normalize.js";
import { getLspPool, type LspPool } from "./pool.js";
import {
  resolveServer,
  type ResolvedServer,
  type UnavailableServer,
} from "./server.js";
import {
  assertWorkspaceFile,
  canonicalPath,
  isWithin,
  nearestWorkspaceRoot,
  serverForFile,
  type ServerKind,
} from "./workspace.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 15_000;
const warningKey = Symbol.for("pipkin:lsp:unavailable-warnings");
const capabilityFor = {
  definition: "definition",
  type_definition: "typeDefinition",
  implementation: "implementation",
  references: "references",
  hover: "hover",
  document_symbols: "documentSymbol",
  workspace_symbols: "workspaceSymbol",
} as const;
type LspInput = {
  action: Action;
  file?: string;
  line?: number;
  column?: number;
  symbol?: string;
  occurrence?: number;
  query?: string;
  timeout?: number;
};
type Context = Pick<ExtensionContext, "cwd" | "ui">;
type Route = {
  kind: ServerKind;
  workspaceRoot: string;
  server: ResolvedServer | UnavailableServer;
};

const descriptions: Record<Action, string> = {
  definition:
    "Resolve a symbol use to its definitions using language semantics, not textual matching.",
  type_definition:
    "Find definitions of a symbol's type, rather than the symbol itself.",
  implementation:
    "Find concrete implementations of a symbol or contract, rather than its declaration or type definition.",
  references:
    "Find semantic usages of a symbol for impact analysis, including its declaration. Bounded results may not be exhaustive.",
  hover:
    "Read type and documentation text at a source position; empty text is valid.",
  document_symbols:
    "Read a source file's named-symbol outline for structural orientation.",
  workspace_symbols:
    "Search symbol names through one selected workspace language server, not full-text content or every language at once.",
  diagnostics:
    "Request advisory file diagnostics on demand, with explicit freshness and timeout evidence. Neither current nor cached results replace project tests, lint, or typechecking.",
  status:
    "Inspect configured server availability and running state without starting servers.",
};
export function registerLsp(pi: ExtensionAPI): void {
  for (const action of actions) {
    const name = `lsp_${action}`;
    pi.registerTool({
      name,
      label: name,
      exposure:
        action === "definition" || action === "references"
          ? "direct"
          : "deferred",
      namespace: {
        name: "lsp",
        description:
          "Read workspace language semantics and bounded on-demand diagnostics through shared lazy language servers.",
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      description: `${descriptions[action]} Read-only and workspace-scoped; results are bounded, coordinates are 1-based UTF-16 with exclusive ends. Unavailable or unsupported requests return structured errors.`,
      parameters: parametersFor(action),
      outputSchema: outputFor(action),
      renderCall: toolCallRenderer({
        name,
        detail: (args: OperationInput) =>
          compactDisplayText(
            "file" in args
              ? args.file
              : "query" in args
                ? args.query
                : undefined,
            100,
          ),
        pending: "Querying language server…",
      }),
      async execute(_id, input, signal, _onUpdate, ctx) {
        return executeLspOperation(action, input, signal, ctx);
      },
      renderResult: toolResultRenderer({
        summary(result) {
          return lspSummary(result.details);
        },
        partial() {
          return "Querying language server…";
        },
        error(result) {
          return lspSummary(result.details)[0] ?? "LSP request failed.";
        },
      }),
    });
  }
}

async function executeLspOperation(
  action: Action,
  input: OperationInput,
  signal: AbortSignal | undefined,
  ctx: Context,
) {
  if (!Value.Check(parametersFor(action), input)) {
    return failure(
      "invalid_arguments",
      "Invalid LSP arguments; use the operation's closed input schema.",
    );
  }
  const position = "position" in input ? input.position : undefined;
  return executeLsp({ action, ...input, ...position }, signal, ctx);
}

async function executeLsp(
  input: LspInput,
  signal: AbortSignal | undefined,
  ctx: Context,
) {
  if (signal?.aborted) {
    return failure("cancelled", "LSP request cancelled.");
  }
  if (input.action === "status") {
    return result(lspStatus(ctx.cwd));
  }
  let target: string | undefined;
  try {
    if (input.file) {
      const candidate = resolve(canonicalPath(ctx.cwd), input.file);
      if (!isWithin(ctx.cwd, candidate)) {
        return failure("workspace_denied", "LSP target is outside workspace.");
      }
      target = assertWorkspaceFile(ctx.cwd, candidate);
      if (!existsSync(target)) {
        return failure("not_found", "LSP target does not exist.");
      }
    }
  } catch (error) {
    return failure("invalid_arguments", conciseError(error));
  }
  try {
    const selected = routeFor(target, ctx.cwd);
    if ("error" in selected) {
      return failure("unsupported", selected.error);
    }
    const route = selected;
    let position: { line: number; character: number } | undefined;
    if (input.line !== undefined) {
      try {
        position = positionFor(input, target!);
      } catch (error) {
        return failure("invalid_position", conciseError(error));
      }
    }
    if ("available" in route.server) {
      return unavailable(route, route.server.reason, ctx);
    }
    const deadline =
      Date.now() +
      Math.min(
        MAX_TIMEOUT_MS,
        Math.round((input.timeout ?? DEFAULT_TIMEOUT_MS / 1000) * 1000),
      );
    const client = await getLspPool().acquire(
      route.server,
      route.workspaceRoot,
      { timeoutMs: remainingTimeout(deadline), signal },
    );
    if ("available" in client) {
      return client.timedOut
        ? failure("timeout", client.reason)
        : unavailable(route, client.reason, ctx);
    }
    if (input.action === "diagnostics") {
      const diagnostics = await client.diagnostics(
        target!,
        languageId(route.kind, target!),
        client.capabilities,
        { timeoutMs: remainingTimeout(deadline), signal },
      );
      if (!diagnostics.fresh && !diagnostics.hasSnapshot) {
        return failure(
          diagnostics.timedOut ? "timeout" : "not_current",
          "No usable diagnostic snapshot was available; run project validation for authoritative results.",
        );
      }
      const resultId =
        diagnostics.resultId === undefined
          ? undefined
          : safeText(diagnostics.resultId);
      return result({
        ok: true,
        diagnostics: diagnostics.diagnostics.map((diagnostic) => ({
          ...diagnostic,
          range: displayRange(diagnostic.range),
        })),
        freshness: diagnostics.fresh
          ? "current"
          : diagnostics.stale || diagnostics.timedOut
            ? "stale"
            : "unknown",
        timedOut: Boolean(diagnostics.timedOut),
        truncated: diagnostics.truncated || (resultId?.length ?? 0) > 2000,
        evidence: {
          fresh: diagnostics.fresh,
          stale: Boolean(diagnostics.stale),
          ...(resultId === undefined
            ? {}
            : { resultId: resultId.slice(0, 2000) }),
        },
      });
    }
    const capability =
      capabilityFor[input.action as keyof typeof capabilityFor];
    if (!capability || !client.supports(capability)) {
      return failure(
        "unsupported",
        `The ${route.kind} LSP server does not support ${input.action}.`,
      );
    }
    const raw =
      input.action === "workspace_symbols"
        ? await client.workspaceSymbols(input.query ?? "", {
            timeoutMs: remainingTimeout(deadline),
            signal,
          })
        : await client.semantic(
            capability as Exclude<typeof capability, "workspaceSymbol">,
            target!,
            languageId(route.kind, target!),
            position,
            { timeoutMs: remainingTimeout(deadline), signal },
          );
    return semanticResult(input.action, raw, target, ctx.cwd);
  } catch (error) {
    if (signal?.aborted || isRequestCancelledError(error)) {
      return failure("cancelled", "LSP request cancelled.");
    }
    if (isRequestTimeoutError(error)) {
      return failure("timeout", conciseError(error));
    }
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === -32601
    ) {
      return failure(
        "unsupported",
        "The language server does not implement this request.",
      );
    }
    return failure("request_failed", conciseError(error));
  }
}

function routeFor(
  target: string | undefined,
  cwd: string,
): Route | { error: string } {
  if (target) {
    const kind = serverForFile(target);
    if (!kind) {
      return { error: "Unsupported LSP file type." };
    }
    const workspaceRoot = nearestWorkspaceRoot(kind, target, cwd);
    return { kind, workspaceRoot, server: resolveServer(kind, workspaceRoot) };
  }
  const workspace = canonicalPath(cwd);
  const running = getLspPool()
    .status()
    .filter(
      (entry) =>
        entry.state === "running" && isWithin(workspace, entry.workspaceRoot),
    );
  const active = running.length === 1 ? running[0] : undefined;
  const kind = active?.kind ?? discoverKind(workspace);
  if (!kind) {
    return {
      error:
        "No supported TypeScript, Svelte, or Ruby workspace was discovered; provide file to select one.",
    };
  }
  const workspaceRoot = active?.workspaceRoot ?? workspace;
  return { kind, workspaceRoot, server: resolveServer(kind, workspaceRoot) };
}
function discoverKind(workspace: string): ServerKind | undefined {
  if (
    ["Gemfile", ".ruby-version"].some((name) =>
      existsSync(resolve(workspace, name)),
    )
  ) {
    return "ruby";
  }
  if (
    [
      "svelte.config.js",
      "svelte.config.mjs",
      "svelte.config.cjs",
      "svelte.config.ts",
    ].some((name) => existsSync(resolve(workspace, name)))
  ) {
    return "svelte";
  }
  if (
    ["tsconfig.json", "jsconfig.json", "package.json"].some((name) =>
      existsSync(resolve(workspace, name)),
    )
  ) {
    return "typescript";
  }
  return undefined;
}
function positionFor(
  input: LspInput,
  file: string,
): { line: number; character: number } {
  const line = readFileSync(file, "utf8").split(/\r?\n/)[input.line! - 1];
  if (line === undefined) {
    throw new Error(`line ${input.line} is outside the source file`);
  }
  if (input.column !== undefined) {
    if (input.column > line.length + 1) {
      throw new Error("column is outside the source line");
    }
    return { line: input.line! - 1, character: input.column - 1 };
  }
  const symbol = input.symbol!;
  let start = -1;
  let from = 0;
  for (let count = 0; count < (input.occurrence ?? 1); count++) {
    start = line.indexOf(symbol, from);
    if (start < 0) {
      throw new Error(
        `symbol occurrence ${input.occurrence ?? 1} was not found on line ${input.line}`,
      );
    }
    from = start + symbol.length;
  }
  return { line: input.line! - 1, character: start };
}
function semanticResult(
  action: Action,
  raw: unknown,
  target: string | undefined,
  workspace: string,
) {
  if (action === "hover") {
    const hover = normalizeHoverResult(raw);
    return result({
      ok: true,
      text: hover.text ?? "",
      truncated: hover.truncated,
    });
  }
  if (action === "document_symbols" || action === "workspace_symbols") {
    const normalized = normalizeSymbolsResult(
      raw,
      100,
      action === "document_symbols" && target
        ? pathToFileURL(target).href
        : undefined,
    );
    const symbols: DisplaySymbol[] = normalized.items.map((symbol) => ({
      name: symbol.name,
      ...(symbol.kind === undefined ? {} : { kind: symbol.kind }),
      ...(symbol.location
        ? { location: displayLocation(symbol.location, workspace) }
        : {}),
    }));
    return result({ ok: true, symbols, truncated: normalized.truncated });
  }
  const normalized = normalizeLocations(raw, 100);
  return result({
    ok: true,
    locations: normalized.items.map((location) =>
      displayLocation(location, workspace),
    ),
    truncated: normalized.truncated,
  });
}
function displayRange(range: NormalizedLocation["range"]) {
  return {
    line: range.start.line + 1,
    column: range.start.character + 1,
    endLine: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}
function displayLocation(
  location: NormalizedLocation,
  workspace: string,
): DisplayLocation {
  let file = location.uri;
  if (file.startsWith("file:")) {
    try {
      file = fileURLToPath(file);
    } catch {
      /* Keep legitimate non-local identifiers as URIs. */
    }
  }
  if (isAbsolute(file) && isWithin(workspace, file)) {
    file =
      relative(canonicalPath(workspace), canonicalPath(file))
        .split(sep)
        .join("/") || ".";
  }
  return { file: safeText(file), ...displayRange(location.range) };
}
function remainingTimeout(deadline: number): number {
  const timeoutMs = deadline - Date.now();
  if (timeoutMs <= 0) {
    throw new RequestTimeoutError("LSP request timed out");
  }
  return timeoutMs;
}
function languageId(kind: ServerKind, file: string): string {
  if (kind !== "typescript") {
    return kind;
  }
  const extension = extname(file).toLowerCase();
  if ([".js", ".mjs", ".cjs"].includes(extension)) {
    return "javascript";
  }
  if (extension === ".jsx") {
    return "javascriptreact";
  }
  if (extension === ".tsx") {
    return "typescriptreact";
  }
  return "typescript";
}
function failure(code: ErrorCode, message: string) {
  return result({
    ok: false,
    error: { code, message: safeText(message).slice(0, 500) },
  });
}
function result(data: LspData) {
  // Bound the actual shared payload, not just prose hiding a larger codemode result.
  const items = data.ok
    ? "locations" in data
      ? data.locations
      : "symbols" in data
        ? data.symbols
        : "diagnostics" in data
          ? data.diagnostics
          : "servers" in data
            ? data.servers
            : undefined
    : undefined;
  let text = JSON.stringify(data, null, 2);
  while (
    items?.length &&
    truncateHead(text, {
      maxLines: DEFAULT_MAX_LINES,
      maxBytes: DEFAULT_MAX_BYTES,
    }).truncated
  ) {
    items.pop();
    if (data.ok) {
      data.truncated = true;
    }
    text = JSON.stringify(data, null, 2);
  }
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: data,
    details: data,
    isError: !data.ok,
  };
}
function unavailable(route: Route, reason: string, ctx: Context) {
  const bounded = conciseError(reason);
  const scope = globalThis as Record<symbol, unknown>;
  const warnings = (scope[warningKey] ??= new Set<string>()) as Set<string>;
  const key = `${route.workspaceRoot}|${route.kind}|${bounded}`;
  if (!warnings.has(key)) {
    warnings.add(key);
    ctx.ui.notify(`LSP ${route.kind} unavailable: ${bounded}`, "warning");
  }
  return failure(
    "server_unavailable",
    `LSP ${route.kind} is unavailable: ${bounded}. Continue with source search or project CLI tooling; do not install dependencies unless asked.`,
  );
}
export function lspStatus(
  cwd: string,
  pool: LspPool = getLspPool(),
): Extract<LspData, { servers: ServerState[] }> {
  const workspace = canonicalPath(cwd);
  const active = pool
    .status()
    .filter((entry) => isWithin(workspace, entry.workspaceRoot));
  const servers: ServerState[] = [];
  for (const kind of ["typescript", "svelte", "ruby"] as const) {
    const entries = active.filter((entry) => entry.kind === kind);
    for (const entry of entries) {
      servers.push({
        kind,
        configured: true,
        available: entry.state !== "cooling-down",
        running: entry.state === "running",
        state: entry.state === "cooling-down" ? "unavailable" : entry.state,
        workspace: entry.workspaceRoot,
        ...(entry.reason ? { reason: conciseError(entry.reason) } : {}),
      });
    }
    if (!entries.length) {
      const server = resolveServer(kind, workspace);
      const available = !("available" in server);
      servers.push({
        kind,
        configured: true,
        available,
        running: false,
        state: available ? "available" : "unavailable",
        workspace,
        ...("reason" in server ? { reason: conciseError(server.reason) } : {}),
      });
    }
  }
  const truncated = servers.length > 100;
  return { ok: true, servers: servers.slice(0, 100), truncated };
}
function conciseError(error: unknown): string {
  return safeText(error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .slice(0, 500);
}
function lspSummary(details: unknown): string[] {
  const data = details as LspData | undefined;
  if (!data) {
    return [];
  }
  if (!data.ok) {
    return [compactDisplayText(data.error.message, 240)];
  }
  if ("freshness" in data && data.freshness !== "current") {
    return [
      `Diagnostics are ${data.freshness}${data.timedOut ? " after the timeout" : ""}.`,
    ];
  }
  const items =
    "locations" in data
      ? data.locations
      : "symbols" in data
        ? data.symbols
        : "diagnostics" in data
          ? data.diagnostics
          : "servers" in data
            ? data.servers
            : undefined;
  return items
    ? [
        `${items.length} ${"servers" in data ? "servers" : "results"}${data.truncated ? " (truncated)" : ""}`,
      ]
    : [data.truncated ? "Hover text (truncated)" : "Hover text"];
}
