import { Type, type Static } from "typebox";

export const actions = [
  "definition",
  "type_definition",
  "implementation",
  "references",
  "hover",
  "document_symbols",
  "workspace_symbols",
  "diagnostics",
  "status",
] as const;
export type Action = (typeof actions)[number];
const closed = { additionalProperties: false };
const positive = (description: string) =>
  Type.Integer({ minimum: 1, description });
const file = Type.String({
  minLength: 1,
  description: "Workspace-relative or absolute source file.",
});
const timeout = Type.Optional(
  Type.Number({
    minimum: 0.1,
    description:
      "Request timeout in seconds; defaults to 5 and is capped at 15.",
  }),
);
export const Position = Type.Union(
  [
    Type.Object(
      {
        line: positive("1-indexed source line."),
        column: positive(
          "1-indexed UTF-16 source column, at most one past the line end.",
        ),
      },
      closed,
    ),
    Type.Object(
      {
        line: positive("1-indexed source line."),
        symbol: Type.String({
          minLength: 1,
          description:
            "Literal symbol text resolved on the selected line; no guessed column.",
        }),
        occurrence: Type.Optional(
          positive(
            "1-indexed occurrence of repeated symbol text; defaults to the first match.",
          ),
        ),
      },
      closed,
    ),
  ],
  {
    description:
      "One exact column or literal symbol selection on a source line.",
  },
);
export const PositionParameters = Type.Object(
  { file, position: Position, timeout },
  closed,
);
export const FileParameters = Type.Object({ file, timeout }, closed);
export const WorkspaceParameters = Type.Object(
  {
    query: Type.String({
      description: "Workspace symbol query sent to the selected server.",
    }),
    file: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Workspace-relative or absolute source file used to select the language server and workspace; does not restrict matches to this file. Omit for automatic workspace selection.",
      }),
    ),
    timeout,
  },
  closed,
);
export const StatusParameters = Type.Object({}, closed);
export type OperationInput =
  | Static<typeof PositionParameters>
  | Static<typeof FileParameters>
  | Static<typeof WorkspaceParameters>
  | Static<typeof StatusParameters>;
export const parametersFor = (action: Action) =>
  action === "status"
    ? StatusParameters
    : action === "workspace_symbols"
      ? WorkspaceParameters
      : action === "document_symbols" || action === "diagnostics"
        ? FileParameters
        : PositionParameters;

const rangeFields = {
  line: positive("1-indexed start line."),
  column: positive("1-indexed UTF-16 start column."),
  endLine: positive("1-indexed exclusive end line."),
  endColumn: positive("1-indexed exclusive UTF-16 end column."),
};
export const Range = Type.Object(rangeFields, closed);
export const Location = Type.Object(
  { file: Type.String(), ...rangeFields },
  closed,
);
export const Symbol = Type.Object(
  {
    name: Type.String({ maxLength: 2000 }),
    kind: Type.Optional(Type.Integer()),
    location: Type.Optional(Location),
  },
  closed,
);
export const Diagnostic = Type.Object(
  {
    range: Range,
    severity: Type.Integer(),
    message: Type.String({ maxLength: 2000 }),
    source: Type.Optional(Type.String({ maxLength: 2000 })),
    code: Type.Optional(
      Type.Union([Type.String({ maxLength: 2000 }), Type.Number()]),
    ),
  },
  closed,
);
export const Server = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("typescript"),
      Type.Literal("svelte"),
      Type.Literal("ruby"),
    ]),
    configured: Type.Boolean(),
    available: Type.Boolean(),
    running: Type.Boolean(),
    state: Type.Union([
      Type.Literal("available"),
      Type.Literal("running"),
      Type.Literal("starting"),
      Type.Literal("unavailable"),
    ]),
    workspace: Type.String(),
    reason: Type.Optional(Type.String({ maxLength: 500 })),
  },
  closed,
);
export const errorCodes = [
  "invalid_arguments",
  "invalid_position",
  "workspace_denied",
  "not_found",
  "server_unavailable",
  "unsupported",
  "timeout",
  "cancelled",
  "request_failed",
  "not_current",
] as const;
export type ErrorCode = (typeof errorCodes)[number];
export const Failure = Type.Object(
  {
    ok: Type.Literal(false),
    error: Type.Object(
      { code: Type.Enum(errorCodes), message: Type.String({ maxLength: 500 }) },
      closed,
    ),
  },
  closed,
);
const truncated = Type.Boolean();
const list = <
  T extends typeof Location | typeof Symbol | typeof Diagnostic | typeof Server,
>(
  item: T,
) => Type.Array(item, { maxItems: 100 });
const LocationsResult = Type.Object(
  { ok: Type.Literal(true), locations: list(Location), truncated },
  closed,
);
const HoverResult = Type.Object(
  { ok: Type.Literal(true), text: Type.String({ maxLength: 2000 }), truncated },
  closed,
);
const SymbolsResult = Type.Object(
  { ok: Type.Literal(true), symbols: list(Symbol), truncated },
  closed,
);
const DiagnosticsResult = Type.Object(
  {
    ok: Type.Literal(true),
    diagnostics: list(Diagnostic),
    freshness: Type.Union([
      Type.Literal("current"),
      Type.Literal("stale"),
      Type.Literal("unknown"),
    ]),
    timedOut: Type.Boolean(),
    truncated,
    evidence: Type.Object(
      {
        fresh: Type.Boolean(),
        stale: Type.Boolean(),
        resultId: Type.Optional(Type.String({ maxLength: 2000 })),
      },
      closed,
    ),
  },
  closed,
);
const StatusResult = Type.Object(
  { ok: Type.Literal(true), servers: list(Server), truncated },
  closed,
);
export const outputFor = (action: Action) =>
  Type.Union([
    Failure,
    action === "status"
      ? StatusResult
      : action === "diagnostics"
        ? DiagnosticsResult
        : action === "hover"
          ? HoverResult
          : action === "document_symbols" || action === "workspace_symbols"
            ? SymbolsResult
            : LocationsResult,
  ]);
export type LspData =
  | Static<typeof Failure>
  | Static<typeof LocationsResult>
  | Static<typeof HoverResult>
  | Static<typeof SymbolsResult>
  | Static<typeof DiagnosticsResult>
  | Static<typeof StatusResult>;
export type DisplayLocation = Static<typeof Location>;
export type DisplaySymbol = Static<typeof Symbol>;
export type ServerState = Static<typeof Server>;
