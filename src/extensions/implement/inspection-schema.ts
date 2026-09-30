import { Type, type Static } from "typebox";

const text = Type.String({ maxLength: 2000 });
export const RunSummarySchema = Type.Object(
  {
    runId: text,
    phase: Type.Union([
      Type.Literal("planning"),
      Type.Literal("running"),
      Type.Literal("whole_plan_review"),
      Type.Literal("stopping"),
      Type.Literal("failed"),
      Type.Literal("incomplete"),
      Type.Literal("completed"),
    ]),
    createdAt: text,
    updatedAt: text,
    tasks: Type.Integer({ minimum: 0 }),
    publishedTasks: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export const ArtifactDescriptorSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("state"),
      Type.Literal("execution_plan"),
      Type.Literal("source_corpus"),
      Type.Literal("planner_attempt"),
      Type.Literal("artifacts"),
      Type.Literal("execution"),
      Type.Literal("evidence"),
    ]),
    path: text,
    retained: Type.Boolean(),
    candidateId: Type.Optional(text),
    attemptId: Type.Optional(text),
    outcome: Type.Optional(
      Type.Union([Type.Literal("passed"), Type.Literal("failed")]),
    ),
  },
  { additionalProperties: false },
);
export const VerificationDescriptorSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("execution"),
      Type.Literal("inspection"),
      Type.Literal("not_run"),
      Type.Literal("legacy"),
    ]),
    candidateId: text,
    context: Type.Union([
      Type.Literal("implementation"),
      Type.Literal("correction"),
    ]),
    text,
    artifactPath: Type.Optional(text),
    attemptId: Type.Optional(text),
    candidateCommitSha: Type.Optional(text),
    capturedAt: Type.Optional(text),
    outcome: Type.Optional(
      Type.Union([Type.Literal("passed"), Type.Literal("failed")]),
    ),
    truncated: Type.Optional(Type.Boolean()),
    commandTruncated: Type.Optional(Type.Boolean()),
    candidateCoverage: Type.Optional(Type.Literal("not_attested")),
    sourceTool: Type.Optional(text),
    executionState: Type.Optional(
      Type.Union([Type.Literal("completed"), Type.Literal("failed")]),
    ),
    exitCode: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
    outputComplete: Type.Optional(Type.Boolean()),
    droppedBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    startedAt: Type.Optional(text),
    endedAt: Type.Optional(text),
  },
  { additionalProperties: false },
);
export const RunInspectionSchema = Type.Object(
  {
    ...RunSummarySchema.properties,
    workstreams: Type.Array(
      Type.Object({ id: text, phase: text }, { additionalProperties: false }),
      { maxItems: 25 },
    ),
    outcomes: Type.Array(
      Type.Object({ kind: text, text }, { additionalProperties: false }),
      { maxItems: 25 },
    ),
    verification: Type.Array(VerificationDescriptorSchema, { maxItems: 25 }),
    artifacts: Type.Array(ArtifactDescriptorSchema, { maxItems: 25 }),
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
);
const error = Type.Object(
  {
    ok: Type.Literal(false),
    error: Type.Object(
      {
        code: Type.Union([
          Type.Literal("invalid_arguments"),
          Type.Literal("not_found"),
          Type.Literal("unavailable"),
        ]),
        message: text,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export const ListRunsResultSchema = Type.Union([
  Type.Object(
    {
      ok: Type.Literal(true),
      runs: Type.Array(RunSummarySchema, { maxItems: 25 }),
      truncated: Type.Boolean(),
      nextOffset: Type.Optional(Type.Integer({ minimum: 0 })),
    },
    { additionalProperties: false },
  ),
  error,
]);
export const InspectResultSchema = Type.Union([
  Type.Object(
    {
      ok: Type.Literal(true),
      run: RunInspectionSchema,
    },
    { additionalProperties: false },
  ),
  error,
]);
export type RunSummary = Static<typeof RunSummarySchema>;
export type RunInspection = Static<typeof RunInspectionSchema>;
