import { stripVTControlCharacters } from "node:util";

export type LspPosition = { line: number; character: number };
export type LspRange = { start: LspPosition; end: LspPosition };
export type NormalizedLocation = { uri: string; range: LspRange };
export type NormalizedDiagnostic = {
  range: LspRange;
  severity: number;
  message: string;
  source?: string;
  code?: string | number;
};
export type NormalizedSymbol = {
  name: string;
  kind?: number;
  location?: NormalizedLocation;
};
export type NormalizedResult<T> = { items: T[]; truncated: boolean };

export const MAX_LSP_TEXT = 2_000;

export function safeText(value: string): string {
  return stripVTControlCharacters(value).replace(/\p{Cc}/gu, " ");
}

function text(value: unknown): { value: string; truncated: boolean } {
  const normalized = safeText(String(value ?? ""))
    .replace(/\s+/g, " ")
    .trim();
  return {
    value: normalized.slice(0, MAX_LSP_TEXT),
    truncated: normalized.length > MAX_LSP_TEXT,
  };
}
function position(value: unknown): LspPosition {
  const item = value as Partial<LspPosition> | undefined;
  if (
    !Number.isSafeInteger(item?.line) ||
    !Number.isSafeInteger(item?.character) ||
    item!.line! < 0 ||
    item!.character! < 0
  ) {
    throw new Error("Invalid LSP range position");
  }
  return { line: item!.line!, character: item!.character! };
}
function range(value: unknown): LspRange {
  const item = value as { start?: unknown; end?: unknown } | undefined;
  const start = position(item?.start);
  const end = position(item?.end);
  if (
    end.line < start.line ||
    (end.line === start.line && end.character < start.character)
  ) {
    throw new Error("Invalid LSP range end");
  }
  return { start, end };
}
export function normalizeLocation(value: unknown): NormalizedLocation {
  const item = value as
    | {
        uri?: unknown;
        range?: unknown;
        targetUri?: unknown;
        targetSelectionRange?: unknown;
        targetRange?: unknown;
      }
    | undefined;
  const uri =
    typeof item?.uri === "string"
      ? item.uri
      : typeof item?.targetUri === "string"
        ? item.targetUri
        : undefined;
  if (!uri) {
    throw new Error("Invalid LSP location URI");
  }
  return {
    uri,
    range: range(
      item?.range ?? item?.targetSelectionRange ?? item?.targetRange,
    ),
  };
}

export function normalizeLocations(
  value: unknown,
  limit = 100,
): NormalizedResult<NormalizedLocation> {
  const locations = (
    value === null ? [] : Array.isArray(value) ? value : [value]
  ).map(normalizeLocation);
  return {
    items: locations.slice(0, limit),
    truncated: locations.length > limit,
  };
}

export function normalizeDiagnosticsResult(
  value: unknown,
  limit = 100,
): NormalizedResult<NormalizedDiagnostic> {
  if (!Array.isArray(value)) {
    throw new Error("Invalid LSP diagnostic list");
  }
  const seen = new Set<string>();
  let textTruncated = false;
  const diagnostics = value
    .flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error("Invalid LSP diagnostic entry");
      }
      const item = entry as {
        range?: unknown;
        severity?: unknown;
        message?: unknown;
        source?: unknown;
        code?: unknown;
      };
      if (typeof item.message !== "string") {
        throw new Error("Invalid LSP diagnostic message");
      }
      if (
        (item.severity !== undefined &&
          (!Number.isSafeInteger(item.severity) ||
            (item.severity as number) < 1 ||
            (item.severity as number) > 4)) ||
        (item.source !== undefined && typeof item.source !== "string") ||
        (item.code !== undefined &&
          typeof item.code !== "string" &&
          !(typeof item.code === "number" && Number.isFinite(item.code)))
      ) {
        throw new Error("Invalid LSP diagnostic fields");
      }
      const messageText = text(item.message);
      const sourceText =
        typeof item.source === "string" ? text(item.source) : undefined;
      const codeText =
        typeof item.code === "string" ? text(item.code) : undefined;
      textTruncated ||=
        messageText.truncated ||
        Boolean(sourceText?.truncated) ||
        Boolean(codeText?.truncated);
      const message = messageText.value;
      const normalized = {
        range: range(item.range),
        severity: Number.isSafeInteger(item.severity)
          ? (item.severity as number)
          : 1,
        message,
        ...(sourceText ? { source: sourceText.value } : {}),
        ...(codeText
          ? { code: codeText.value }
          : typeof item.code === "number" && Number.isFinite(item.code)
            ? { code: item.code }
            : {}),
      };
      const key = JSON.stringify(normalized);
      if (!message || seen.has(key)) {
        return [];
      }
      seen.add(key);
      return [normalized];
    })
    .sort((a, b) => a.severity - b.severity);
  return {
    items: diagnostics.slice(0, limit),
    truncated: textTruncated || diagnostics.length > limit,
  };
}

export function normalizeDiagnostics(
  value: unknown,
  limit = 100,
): NormalizedDiagnostic[] {
  return normalizeDiagnosticsResult(value, limit).items;
}

export function normalizeHoverResult(value: unknown): {
  text?: string;
  truncated: boolean;
} {
  if (value === null) {
    return { truncated: false };
  }
  const hover = value as { contents?: unknown; range?: unknown } | undefined;
  if (hover?.range !== undefined) {
    range(hover.range);
  }
  const contents = hover?.contents;
  const values = (Array.isArray(contents) ? contents : [contents]).map(
    (part) => {
      if (typeof part === "string") {
        return part;
      }
      const item = part as {
        value?: unknown;
        kind?: unknown;
        language?: unknown;
      } | null;
      if (
        !item ||
        Array.isArray(item) ||
        typeof item.value !== "string" ||
        !(
          item.kind === "plaintext" ||
          item.kind === "markdown" ||
          typeof item.language === "string"
        )
      ) {
        throw new Error("Invalid LSP hover contents");
      }
      return item.value;
    },
  );
  const combined = values.join("\n");
  const normalized = text(combined);
  return normalized.value
    ? { text: normalized.value, truncated: normalized.truncated }
    : { truncated: false };
}

export function normalizeHover(value: unknown): string | undefined {
  return normalizeHoverResult(value).text;
}

export function normalizeSymbolsResult(
  value: unknown,
  limit = 100,
  defaultUri?: string,
): NormalizedResult<NormalizedSymbol> {
  if (value !== null && !Array.isArray(value)) {
    throw new Error("Invalid LSP symbol list");
  }
  const symbols: NormalizedSymbol[] = [];
  let textTruncated = false;
  const visit = (entries: unknown[]): void => {
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error("Invalid LSP symbol entry");
      }
      const item = entry as {
        name?: unknown;
        kind?: unknown;
        location?: unknown;
        range?: unknown;
        selectionRange?: unknown;
        uri?: unknown;
        children?: unknown;
      };
      if (typeof item.name !== "string") {
        throw new Error("Invalid LSP symbol name");
      }
      if (
        (item.kind !== undefined && !Number.isSafeInteger(item.kind)) ||
        (item.children !== undefined && !Array.isArray(item.children))
      ) {
        throw new Error("Invalid LSP symbol fields");
      }
      let resolvedLocation: NormalizedLocation | undefined;
      if (item.location !== undefined) {
        const location = item.location as {
          uri?: unknown;
          range?: unknown;
        } | null;
        if (
          !location ||
          Array.isArray(location) ||
          typeof location.uri !== "string" ||
          !location.uri
        ) {
          throw new Error("Invalid LSP symbol location");
        }
        // Workspace symbols may carry an unresolved URI without a range.
        if (location.range !== undefined) {
          resolvedLocation = normalizeLocation(location);
        }
      }
      if (defaultUri && item.location === undefined) {
        range(item.range);
        range(item.selectionRange);
      }
      const symbolRange = item.selectionRange ?? item.range;
      const normalizedRange =
        symbolRange === undefined ? undefined : range(symbolRange);
      const nameText = text(item.name);
      textTruncated ||= nameText.truncated;
      const name = nameText.value;
      // Document symbols are resolved evidence. Only workspace-symbol queries
      // may return URI-only entries for a later workspaceSymbol/resolve request.
      if (
        defaultUri &&
        (!name ||
          (item.location !== undefined ? !resolvedLocation : !normalizedRange))
      ) {
        throw new Error("Invalid LSP document symbol name or location");
      }
      if (name) {
        const location =
          resolvedLocation ??
          (normalizedRange && (typeof item.uri === "string" || defaultUri)
            ? {
                uri: typeof item.uri === "string" ? item.uri : defaultUri!,
                range: normalizedRange,
              }
            : undefined);
        symbols.push({
          name,
          ...(Number.isSafeInteger(item.kind)
            ? { kind: item.kind as number }
            : {}),
          ...(location ? { location } : {}),
        });
      }
      if (Array.isArray(item.children)) {
        visit(item.children);
      }
    }
  };
  visit(Array.isArray(value) ? value : []);
  return {
    items: symbols.slice(0, limit),
    truncated: textTruncated || symbols.length > limit,
  };
}

export function normalizeSymbols(
  value: unknown,
  limit = 100,
): NormalizedSymbol[] {
  return normalizeSymbolsResult(value, limit).items;
}
