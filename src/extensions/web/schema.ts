import { Type, type Static } from "typebox";
import { LIMITS } from "./constants.js";
import { WebError } from "./errors.js";

export const WebFetchParameters = Type.Object(
  {
    url: Type.String({
      minLength: 1,
      maxLength: LIMITS.urlChars,
      description: "Public credential-free HTTP(S) URL to retrieve.",
    }),
    raw: Type.Optional(
      Type.Boolean({
        description:
          "Save the untouched textual response as a temporary artifact instead of returning automatically detected readable content.",
      }),
    ),
    maxChars: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: LIMITS.maxChars,
        description:
          "Maximum returned text or raw preview characters; defaults to 40000. Byte and line bounds also apply.",
      }),
    ),
    timeoutMs: Type.Optional(
      Type.Integer({
        minimum: 1_000,
        maximum: LIMITS.maxTimeoutMs,
        description: "Request deadline in milliseconds; defaults to 15000.",
      }),
    ),
  },
  { additionalProperties: false },
);
export type WebFetchInput = Static<typeof WebFetchParameters>;
export type NormalizedWebFetchInput = Required<WebFetchInput>;

export function normalizeInput(input: WebFetchInput): NormalizedWebFetchInput {
  assertInputShape(input);
  const url = input.url.trim();
  if (
    !url ||
    Array.from(url).length > LIMITS.urlChars ||
    [...url].some((character) => {
      const code = character.codePointAt(0)!;
      return code < 32 || code === 127;
    })
  ) {
    throw new WebError(
      "target",
      "Web Fetch URL must be a bounded non-empty URL.",
    );
  }
  return {
    url,
    raw: input.raw ?? false,
    maxChars: input.maxChars ?? LIMITS.defaultMaxChars,
    timeoutMs: input.timeoutMs ?? LIMITS.defaultTimeoutMs,
  };
}

function assertInputShape(input: WebFetchInput): void {
  if (
    !isRecord(input) ||
    !hasOnly(input, ["url", "raw", "maxChars", "timeoutMs"]) ||
    typeof input.url !== "string" ||
    (input.raw !== undefined && typeof input.raw !== "boolean") ||
    (input.maxChars !== undefined &&
      (!Number.isInteger(input.maxChars) ||
        input.maxChars < 1 ||
        input.maxChars > LIMITS.maxChars)) ||
    (input.timeoutMs !== undefined &&
      (!Number.isInteger(input.timeoutMs) ||
        input.timeoutMs < 1_000 ||
        input.timeoutMs > LIMITS.maxTimeoutMs))
  ) {
    throw new WebError("content", "Web Fetch request has an invalid schema.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnly(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
