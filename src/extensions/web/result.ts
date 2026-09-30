import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { LIMITS } from "./constants.js";
import { ARTIFACT_LIMITS } from "./artifacts.js";
import { DeadlineError, WebError } from "./errors.js";

const Source = Type.Object(
  {
    title: Type.Optional(Type.String({ maxLength: LIMITS.metadataChars })),
    site: Type.Optional(Type.String({ maxLength: LIMITS.metadataChars })),
    published: Type.Optional(Type.String({ maxLength: LIMITS.metadataChars })),
  },
  { additionalProperties: false },
);
const ArtifactDescriptor = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 4096 }),
    mediaType: Type.String({ maxLength: LIMITS.metadataChars }),
    bytes: Type.Integer({ minimum: 0, maximum: ARTIFACT_LIMITS.binaryBytes }),
    lifetime: Type.Literal("temporary"),
    kind: StringEnum(["raw-text", "binary"] as const),
  },
  { additionalProperties: false },
);
const SuccessFields = {
  ok: Type.Literal(true),
  url: Type.String({ minLength: 1, maxLength: LIMITS.urlChars }),
  finalUrl: Type.String({ minLength: 1, maxLength: LIMITS.urlChars }),
  status: Type.Integer({ minimum: 200, maximum: 299 }),
  contentType: Type.String({ maxLength: LIMITS.metadataChars }),
  source: Type.Optional(Source),
  truncated: Type.Boolean(),
};
export const WebFetchOutput = Type.Union([
  Type.Object(
    {
      ...SuccessFields,
      format: StringEnum(["markdown", "json", "text"] as const),
      text: Type.String({ maxLength: LIMITS.resultBytes }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...SuccessFields,
      format: Type.Literal("artifact"),
      artifact: ArtifactDescriptor,
      text: Type.Optional(Type.String({ maxLength: LIMITS.resultBytes })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ok: Type.Literal(false),
      error: Type.Object(
        {
          code: StringEnum([
            "target",
            "dns",
            "network",
            "redirect",
            "oversize",
            "http",
            "content",
            "extract",
            "artifact",
            "timeout",
            "cancelled",
          ] as const),
          message: Type.String({ maxLength: LIMITS.metadataChars }),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
]);
export type WebFetchData = Static<typeof WebFetchOutput>;
export type WebFetchDetails = {
  output?: "markdown" | "json" | "text" | "artifact";
  contentType?: string;
  contentChars?: number;
  truncated?: boolean;
  errorCode?: Extract<WebFetchData, { ok: false }>["error"]["code"];
};
export type WebFetchResult = {
  content: Array<{ type: "text"; text: string }>;
  details: WebFetchDetails;
  structuredContent: WebFetchData;
  isError: boolean;
};

export function controlSafeText(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const code = character.codePointAt(0)!;
      return (
        code === 9 || code === 10 || (code >= 32 && (code < 127 || code > 159))
      );
    })
    .join("");
}

export function webFetchFailure(
  error: unknown,
  signal?: AbortSignal,
): WebFetchResult {
  const code = signal?.aborted
    ? "cancelled"
    : error instanceof DeadlineError
      ? "timeout"
      : error instanceof WebError
        ? error.kind
        : error instanceof Error && error.name === "AbortError"
          ? "cancelled"
          : "network";
  const message =
    code === "cancelled"
      ? "Web Fetch was cancelled."
      : error instanceof WebError || error instanceof DeadlineError
        ? controlSafeText(error.message).slice(0, LIMITS.metadataChars)
        : "Web Fetch could not complete the public request.";
  const structuredContent: WebFetchData = {
    ok: false,
    error: { code, message },
  };
  return {
    content: [{ type: "text", text: `Web Fetch ${code}: ${message}` }],
    details: { errorCode: code },
    structuredContent,
    isError: true,
  };
}
