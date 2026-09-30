import { Type, type Static } from "typebox";
export const Presentation = Type.Union(
  [Type.Literal("output"), Type.Literal("status")],
  {
    description:
      "Output by default; status suppresses only successful output, never failure diagnostics.",
  },
);
export const ErrorSchema = Type.Object(
  { code: Type.String(), message: Type.String() },
  { additionalProperties: false },
);
export const ExecutionSchema = Type.Object(
  {
    state: Type.Union(
      [
        "running",
        "completed",
        "failed",
        "cancelled",
        "timed_out",
        "stopped",
      ].map((state) => Type.Literal(state)),
    ),
    exitCode: Type.Union([Type.Integer(), Type.Null()]),
    signal: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    startedAt: Type.String(),
    endedAt: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export const RetentionFields = {
  retention: Type.Union([Type.Literal("retained"), Type.Literal("failed")]),
  outputRef: Type.Optional(Type.String()),
};
const BashExecutionSchema = Type.Object(
  {
    ...ExecutionSchema.properties,
    state: Type.Union([
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("cancelled"),
      Type.Literal("timed_out"),
    ]),
  },
  { additionalProperties: false },
);
export const BashResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    error: Type.Optional(ErrorSchema),
    execution: BashExecutionSchema,
    output: Type.String(),
    truncated: Type.Boolean(),
    ...RetentionFields,
  },
  { additionalProperties: false },
);
export const OutputSelector = Type.Union(
  [
    Type.Object(
      {
        lines: Type.String({
          description:
            "Positive 1-based line or start-end range, end >= start.",
        }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        tailLines: Type.Integer({
          minimum: 1,
          maximum: 200,
          description: "Newest 1..200 source lines.",
        }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        find: Type.String({
          description:
            "Trimmed 1..256 UTF-8-byte case-insensitive literal; up to 10 ordered matches with 3 context lines.",
        }),
      },
      { additionalProperties: false },
    ),
  ],
  {
    description:
      "One immutable textual source selection; not valid on mixed or image content.",
  },
);
export type OutputSelector = Static<typeof OutputSelector>;
export const TextContentSchema = Type.Object(
  { type: Type.Literal("text"), text: Type.String() },
  { additionalProperties: false },
);
export const ImageContentSchema = Type.Object(
  { type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() },
  { additionalProperties: false },
);
export const ContentSchema = Type.Array(
  Type.Union([TextContentSchema, ImageContentSchema]),
);
export type OutputContent = Static<typeof ContentSchema>;
export const SourceSchema = Type.Object(
  {
    sourceTool: Type.String(),
    isError: Type.Optional(Type.Boolean()),
    callId: Type.Optional(Type.String()),
    jobId: Type.Optional(Type.String()),
    command: Type.Optional(Type.String()),
    cwd: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    commandTruncated: Type.Optional(Type.Boolean()),
    cwdTruncated: Type.Optional(Type.Boolean()),
    execution: Type.Optional(ExecutionSchema),
    outputComplete: Type.Optional(Type.Boolean()),
    droppedBytes: Type.Optional(Type.Integer()),
  },
  { additionalProperties: false },
);
export const SelectionSchema = Type.Object(
  {
    type: Type.Union([
      Type.Literal("full"),
      Type.Literal("lines"),
      Type.Literal("tail"),
      Type.Literal("find"),
    ]),
    sourceLines: Type.Optional(Type.Integer()),
    returnedLines: Type.Optional(Type.Integer()),
    start: Type.Optional(Type.Integer()),
    end: Type.Optional(Type.Integer()),
    totalMatches: Type.Optional(Type.Integer()),
    selectedMatches: Type.Optional(Type.Integer()),
    omittedMatches: Type.Optional(Type.Integer()),
    omittedLines: Type.Optional(Type.Integer()),
  },
  { additionalProperties: false },
);
export const ReadOutputSchema = Type.Object(
  {
    ok: Type.Boolean(),
    error: Type.Optional(ErrorSchema),
    reference: Type.String(),
    source: Type.Optional(SourceSchema),
    content: ContentSchema,
    selection: Type.Optional(SelectionSchema),
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
);
export const PageParams = Type.Object(
  {
    offset: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
        description:
          "Nonnegative safe-integer authorized record offset; defaults to 0.",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 25,
        description: "Authorized page size 1..25; defaults to 25.",
      }),
    ),
  },
  { additionalProperties: false },
);
export const PageFields = {
  count: Type.Integer(),
  nextOffset: Type.Optional(Type.Integer()),
  truncated: Type.Boolean(),
};
export const OutputListSchema = Type.Object(
  {
    ok: Type.Boolean(),
    error: Type.Optional(ErrorSchema),
    outputs: Type.Array(
      Type.Object(
        {
          reference: Type.String(),
          sourceTool: Type.String(),
          createdAt: Type.String(),
          state: Type.Optional(Type.String()),
          jobId: Type.Optional(Type.String()),
          truncated: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
    ...PageFields,
  },
  { additionalProperties: false },
);
