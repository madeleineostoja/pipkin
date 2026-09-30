import { stripVTControlCharacters } from "node:util";
import { Type, type Static } from "typebox";
import type { PapercutRecord } from "./store.js";

const destination = Type.Union(
  [
    Type.Literal("agents"),
    Type.Literal("skill"),
    Type.Literal("test"),
    Type.Literal("lint"),
    Type.Literal("tooling"),
    Type.Literal("docs"),
    Type.Literal("code"),
  ],
  {
    description:
      "Optional repository area most likely to own a future guardrail.",
  },
);

function prose(maxLength: number, description: string) {
  return Type.String({ minLength: 1, maxLength, pattern: "\\S", description });
}

export const PapercutKeySchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$",
  description: "Exact stable lowercase registry key, one to 64 characters.",
});

export const PapercutObservationSchema = Type.Object(
  {
    key: PapercutKeySchema,
    title: prose(120, "Concise title identifying the recurring friction."),
    task: prose(
      1_000,
      "Assigned subject being completed when the unrelated friction occurred.",
    ),
    incident: prose(
      2_000,
      "Factual account of the avoidable friction encountered.",
    ),
    evidence: prose(
      2_000,
      "Concrete observed evidence that the friction occurred.",
    ),
    workarounds: Type.Array(
      prose(
        1_000,
        "One workaround or detour actually exercised while continuing safely.",
      ),
      {
        minItems: 1,
        maxItems: 5,
        description: "One to five workarounds actually used, not suggestions.",
      },
    ),
    taskOutcome: prose(
      1_000,
      "How the assigned task completed or safely continued after the workaround.",
    ),
    guardrailCandidate: Type.Optional(
      prose(
        1_000,
        "Optional concrete guardrail that could prevent the friction.",
      ),
    ),
    suggestedDestination: Type.Optional(destination),
  },
  { additionalProperties: false },
);

const status = Type.Union([Type.Literal("open"), Type.Literal("closed")]);
const occurrences = Type.Integer({ minimum: 1, maximum: 2_147_483_647 });
const timestamp = Type.String({ minLength: 24, maxLength: 27 });
const summary = Type.Object(
  {
    key: PapercutKeySchema,
    title: PapercutObservationSchema.properties.title,
    status,
    occurrences,
    lastSeenAt: timestamp,
  },
  { additionalProperties: false },
);
const finding = Type.Object(
  {
    ...PapercutObservationSchema.properties,
    status,
    occurrences,
    firstSeenAt: timestamp,
    lastSeenAt: timestamp,
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
          Type.Literal("persistence_failed"),
        ]),
        message: Type.String({ minLength: 1, maxLength: 512 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const PapercutListResultSchema = Type.Union([
  Type.Object(
    {
      ok: Type.Literal(true),
      findings: Type.Array(summary, { maxItems: 25 }),
      offset: Type.Integer({ minimum: 0, maximum: 255 }),
      nextOffset: Type.Optional(Type.Integer({ minimum: 1, maximum: 255 })),
      truncated: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  error,
]);
export const PapercutGetResultSchema = Type.Union([
  Type.Object(
    { ok: Type.Literal(true), finding },
    { additionalProperties: false },
  ),
  error,
]);
export const PapercutRecordResultSchema = Type.Union([
  Type.Object(
    {
      ok: Type.Literal(true),
      outcome: Type.Union([
        Type.Literal("created"),
        Type.Literal("merged"),
        Type.Literal("reopened"),
      ]),
      key: PapercutKeySchema,
      title: PapercutObservationSchema.properties.title,
      occurrences,
    },
    { additionalProperties: false },
  ),
  error,
]);
export type PapercutListResult = Static<typeof PapercutListResultSchema>;
export type PapercutGetResult = Static<typeof PapercutGetResultSchema>;
export type PapercutRecordResult = Static<typeof PapercutRecordResultSchema>;
type PapercutError = Static<typeof error>;

export function papercutError(
  code: PapercutError["error"]["code"],
  message: string,
): PapercutError {
  return {
    ok: false,
    error: { code, message: safeText(message).slice(0, 512) },
  };
}

function safeText(value: string): string {
  return (
    stripVTControlCharacters(value)
      // Intentionally remove remaining control characters from public projections.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, " ")
      .trim() || "(control characters)"
  );
}

// Preserve personal data on disk; only the public projection is control-safe.
export function publicFinding(record: PapercutRecord): PapercutRecord {
  return {
    ...record,
    title: safeText(record.title),
    task: safeText(record.task),
    incident: safeText(record.incident),
    evidence: safeText(record.evidence),
    workarounds: record.workarounds.map(safeText),
    taskOutcome: safeText(record.taskOutcome),
    ...(record.guardrailCandidate === undefined
      ? {}
      : { guardrailCandidate: safeText(record.guardrailCandidate) }),
  };
}

export function papercutToolResult(
  structuredContent:
    | PapercutListResult
    | PapercutGetResult
    | PapercutRecordResult,
  summary: string,
) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(structuredContent, null, 2),
      },
    ],
    structuredContent,
    isError: !structuredContent.ok,
    details: { summary },
  };
}
