import { createHash } from "node:crypto";
import { arch, platform, release } from "node:os";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { calculateCost, normalizeContext } from "@earendil-works/pi-ai";
import { createParser } from "eventsource-parser";
import type {
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
  Usage,
} from "@earendil-works/pi-ai";

// Pi 0.99's Jiti root alias also matches API subpaths. A native ESM bridge
// keeps this public export on Node's resolver instead of the compat.js alias.
const { streamSimple } = createRequire(import.meta.url)(
  "./codex-api.mjs",
) as typeof import("@earendil-works/pi-ai/api/openai-codex-responses");

type ResolvedRequestAuth =
  | {
      ok: true;
      apiKey?: string;
      headers?: Record<string, string | null>;
      baseUrl?: string;
    }
  | { ok: false; error: string };

const ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const PROTOCOL = "pipkin-codex-compaction-trigger-v1";
const MARKER =
  "[Context compacted by OpenAI Codex. The authoritative prior context is an opaque provider checkpoint and is not portable to another model or provider.]";
const MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 2_000;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

type CodexIdentity = {
  provider: "openai-codex";
  api: "openai-codex-responses";
  model: string;
  endpoint: string;
  authMode: "oauth";
  accountFingerprint: string;
  protocol: typeof PROTOCOL;
};

type NativeCompactionDetails = {
  kind: "pipkin-native-compaction";
  schemaVersion: 1;
  adapter: "openai-codex";
  identity: CodexIdentity;
  checkpoint: { artifact: Json[] };
  lineage: { firstKeptEntryId: string; leafId: string | null };
};

type Checkpoint = {
  summary: typeof MARKER;
  details: NativeCompactionDetails;
  usage: Usage;
};

type AdapterErrorCode =
  | "aborted"
  | "auth"
  | "http"
  | "transport"
  | "capture"
  | "protocol"
  | "validation";

export class CodexAdapterError extends Error {
  constructor(
    readonly code: AdapterErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CodexAdapterError";
  }
}

export type CodexAdapterDependencies = {
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  serializer?: CodexSerializer;
};

type CodexSerializer = (
  model: Model<"openai-codex-responses">,
  context: TranscriptContext,
  options: SimpleStreamOptions,
) => AssistantMessageEventStream;

export type CaptureInput = {
  model: Model<"openai-codex-responses">;
  context: Context;
  auth: ResolvedRequestAuth & { ok: true; apiKey: string };
  thinking?: SimpleStreamOptions["reasoning"];
  sessionId?: string;
  signal?: AbortSignal;
};

export type CompactionInput = {
  identity: CodexIdentity;
  model: Model<"openai-codex-responses">;
  auth: ResolvedRequestAuth & { ok: true; apiKey: string };
  payload: JsonObject;
  lineage: NativeCompactionDetails["lineage"];
  sessionId?: string;
  signal?: AbortSignal;
};

export function normalizeCodexEndpoint(
  baseUrl: string | undefined,
): string | undefined {
  if (!baseUrl?.trim()) {
    return undefined;
  }
  let raw = baseUrl.trim().replace(/\/+$/, "");
  if (raw.endsWith("/codex/responses")) {
    // Already a Pi-AI Codex Responses endpoint.
  } else if (raw.endsWith("/codex")) {
    raw += "/responses";
  } else {
    raw += "/codex/responses";
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  return url.href === ENDPOINT ? ENDPOINT : undefined;
}

export function createCodexIdentity(
  model: Model<"openai-codex-responses">,
  auth: ResolvedRequestAuth,
  isUsingOAuth: boolean,
): CodexIdentity | undefined {
  if (
    model.provider !== "openai-codex" ||
    model.api !== "openai-codex-responses" ||
    !isUsingOAuth ||
    !auth.ok ||
    !auth.apiKey
  ) {
    return undefined;
  }
  const endpoint = normalizeCodexEndpoint(auth.baseUrl ?? model.baseUrl);
  const accountId = extractAccountId(auth.apiKey);
  if (!endpoint || !accountId) {
    return undefined;
  }
  return {
    provider: "openai-codex",
    api: "openai-codex-responses",
    model: model.id,
    endpoint,
    authMode: "oauth",
    accountFingerprint: createHash("sha256")
      .update("pipkin-codex-account-v1\0")
      .update(accountId)
      .digest("hex"),
    protocol: PROTOCOL,
  };
}

export function validateNativeCompactionDetails(
  value: unknown,
): NativeCompactionDetails | undefined {
  if (
    !isObject(value) ||
    value.kind !== "pipkin-native-compaction" ||
    value.schemaVersion !== 1 ||
    value.adapter !== "openai-codex" ||
    !validIdentity(value.identity) ||
    !isObject(value.checkpoint) ||
    !Array.isArray(value.checkpoint.artifact) ||
    !isValidArtifact(value.checkpoint.artifact) ||
    !isObject(value.lineage) ||
    !nonemptyString(value.lineage.firstKeptEntryId) ||
    (value.lineage.leafId !== null && !nonemptyString(value.lineage.leafId))
  ) {
    return undefined;
  }
  return value as NativeCompactionDetails;
}

export function createNativeCheckpoint(input: {
  identity: CodexIdentity;
  artifact: Json[];
  lineage: NativeCompactionDetails["lineage"];
  usage: Usage;
}): Checkpoint {
  return {
    summary: MARKER,
    details: {
      kind: "pipkin-native-compaction",
      schemaVersion: 1,
      adapter: "openai-codex",
      identity: input.identity,
      checkpoint: { artifact: input.artifact },
      lineage: input.lineage,
    },
    usage: input.usage,
  };
}

export function replaceCanonicalInputSegment(
  payload: JsonObject,
  expectedItems: Json[],
  details: NativeCompactionDetails,
  currentIdentity: CodexIdentity,
): JsonObject | undefined {
  if (
    !isDeepStrictEqual(details.identity, currentIdentity) ||
    !Array.isArray(payload.input) ||
    expectedItems.length === 0
  ) {
    return undefined;
  }
  let start: number | undefined;
  for (
    let index = 0;
    index <= payload.input.length - expectedItems.length;
    index++
  ) {
    if (
      expectedItems.every((item, offset) =>
        isDeepStrictEqual(item, (payload.input as Json[])[index + offset]),
      )
    ) {
      if (start !== undefined) {
        return undefined;
      }
      start = index;
    }
  }
  if (start === undefined) {
    return undefined;
  }
  return {
    ...payload,
    input: [
      ...payload.input.slice(0, start),
      ...details.checkpoint.artifact,
      ...payload.input.slice(start + expectedItems.length),
    ],
  };
}

export function createCodexOAuthAdapter(
  dependencies: CodexAdapterDependencies = {},
) {
  const fetchFn = dependencies.fetch ?? globalThis.fetch;
  const serializer = dependencies.serializer ?? streamSimple;
  const sleep = dependencies.sleep ?? wait;

  return {
    supports: createCodexIdentity,

    async capture(input: CaptureInput): Promise<JsonObject> {
      let captured: JsonObject | undefined;
      const stream = serializer(input.model, normalizeContext(input.context), {
        apiKey: input.auth.apiKey,
        headers: input.auth.headers,
        sessionId: input.sessionId,
        signal: input.signal,
        transport: "sse",
        reasoning: input.thinking,
        onPayload: (payload) => {
          captured = payload as JsonObject;
          throw new CaptureStop();
        },
      });
      // Pi turns the deliberate stop into a terminal stream event. Consume it
      // so the serializer completes without dispatching a provider request.
      for await (const _event of stream) {
      }
      const terminal = await stream.result();
      if (!captured) {
        throw new CodexAdapterError(
          terminal.stopReason === "aborted" ? "aborted" : "capture",
          terminal.stopReason === "aborted"
            ? "payload capture aborted"
            : "payload capture failed",
        );
      }
      return captured;
    },

    async compact(input: CompactionInput): Promise<Checkpoint> {
      const result = await requestCompaction({ ...input, fetchFn, sleep });
      return createNativeCheckpoint({
        identity: input.identity,
        artifact: result.artifact,
        lineage: input.lineage,
        usage: result.usage,
      });
    },

    validate: validateNativeCompactionDetails,
    isCompatible(
      details: NativeCompactionDetails,
      identity: CodexIdentity,
    ): boolean {
      return isDeepStrictEqual(details.identity, identity);
    },
    replay: replaceCanonicalInputSegment,
  };
}

class CaptureStop extends Error {}

async function requestCompaction(
  input: CompactionInput & {
    fetchFn: typeof globalThis.fetch;
    sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  },
): Promise<{ artifact: Json[]; usage: Usage }> {
  throwIfAborted(input.signal);
  const accountId = extractAccountId(input.auth.apiKey);
  if (!accountId) {
    throw new CodexAdapterError("auth", "invalid Codex OAuth credentials");
  }
  const body = {
    ...input.payload,
    store: false,
    input: [...(input.payload.input as Json[]), { type: "compaction_trigger" }],
  };
  const headers = new Headers(input.model.headers);
  for (const [name, value] of Object.entries(input.auth.headers ?? {})) {
    if (value === null) {
      headers.delete(name);
    } else {
      headers.set(name, value);
    }
  }
  headers.set("authorization", `Bearer ${input.auth.apiKey}`);
  headers.set("chatgpt-account-id", accountId);
  headers.set("originator", "pi");
  headers.set("user-agent", `pi (${platform()} ${release()}; ${arch()})`);
  headers.set("openai-beta", "responses=experimental");
  appendHeaderToken(headers, "x-codex-beta-features", "remote_compaction_v2");
  headers.set("accept", "text/event-stream");
  headers.set("content-type", "application/json");
  if (input.sessionId) {
    headers.set("session-id", input.sessionId);
    headers.set("x-client-request-id", input.sessionId);
  }

  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await input.fetchFn(input.identity.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: input.signal,
      });
    } catch {
      throwIfAborted(input.signal);
      if (attempt < MAX_RETRIES) {
        await input.sleep(retryDelay(attempt), input.signal);
        continue;
      }
      throw new CodexAdapterError("transport", "Codex transport failed");
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (isRetryableStatus(response.status) && attempt < MAX_RETRIES) {
        const delay = retryAfter(response.headers) ?? retryDelay(attempt);
        if (delay <= MAX_RETRY_DELAY_MS) {
          await input.sleep(delay, input.signal);
          continue;
        }
      }
      throw new CodexAdapterError(
        response.status === 401 || response.status === 403 ? "auth" : "http",
        `Codex request failed (${response.status})`,
      );
    }
    try {
      return await parseCompactionSse(
        response,
        input.signal,
        input.model,
        input.payload.input as Json[],
      );
    } catch (error) {
      throwIfAborted(input.signal);
      if (error instanceof CodexAdapterError) {
        throw error;
      }
      if (attempt < MAX_RETRIES) {
        await input.sleep(retryDelay(attempt), input.signal);
        continue;
      }
      throw new CodexAdapterError("transport", "Codex stream failed");
    }
  }
}

function appendHeaderToken(
  headers: Headers,
  name: string,
  requiredToken: string,
): void {
  const tokens = (headers.get(name) ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  if (
    !tokens.some((token) => token.toLowerCase() === requiredToken.toLowerCase())
  ) {
    tokens.push(requiredToken);
  }
  headers.set(name, tokens.join(", "));
}

async function parseCompactionSse(
  response: Response,
  signal: AbortSignal | undefined,
  model: Model<"openai-codex-responses">,
  canonicalInput: Json[],
): Promise<{ artifact: Json[]; usage: Usage }> {
  if (!response.body) {
    throw new CodexAdapterError("protocol", "missing response body");
  }
  const reader = response.body.getReader();
  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const decoder = new TextDecoder();
  let compaction: JsonObject | undefined;
  let completed: JsonObject | undefined;
  const parser = createParser({
    onEvent: ({ data }) => {
      if (completed || data === "[DONE]") {
        return;
      }
      let event: unknown;
      try {
        event = JSON.parse(data);
      } catch {
        throw new CodexAdapterError("protocol", "invalid SSE JSON");
      }
      if (!isObject(event)) {
        throw new CodexAdapterError("protocol", "invalid SSE event");
      }
      if (
        event.type === "error" ||
        event.type === "response.failed" ||
        event.type === "response.incomplete"
      ) {
        throw new CodexAdapterError("protocol", "Codex operation failed");
      }
      if (
        event.type === "response.output_item.done" &&
        isObject(event.item) &&
        event.item.type === "compaction"
      ) {
        if (compaction || !isCompactionArtifact(event.item)) {
          throw new CodexAdapterError(
            "protocol",
            "invalid compaction artifact",
          );
        }
        compaction = event.item;
      }
      if (
        event.type === "response.completed" ||
        event.type === "response.done"
      ) {
        if (
          !isObject(event.response) ||
          event.response.status !== "completed"
        ) {
          throw new CodexAdapterError(
            "protocol",
            "Codex operation did not complete",
          );
        }
        completed = event.response;
      }
    },
  });
  try {
    while (!completed) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      throwIfAborted(signal);
      if (done) {
        break;
      }
      parser.feed(decoder.decode(value, { stream: true }));
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!completed || !compaction) {
    throw new CodexAdapterError(
      "protocol",
      "missing completed compaction artifact",
    );
  }
  // Codex continuation retains real user turns in order before the opaque item.
  // Neither synthetic controls nor other provider output belong in the checkpoint.
  return {
    artifact: [...canonicalInput.filter(isContinuationItem), compaction],
    usage: normalizeUsage(completed.usage, model),
  };
}

function normalizeUsage(
  value: unknown,
  model: Model<"openai-codex-responses">,
): Usage {
  const usage = isObject(value) ? value : {};
  const inputDetails = isObject(usage.input_tokens_details)
    ? usage.input_tokens_details
    : {};
  const outputDetails = isObject(usage.output_tokens_details)
    ? usage.output_tokens_details
    : {};
  const cacheRead = nonNegative(inputDetails.cached_tokens) ?? 0;
  const cacheWrite = nonNegative(inputDetails.cache_write_tokens) ?? 0;
  const reportedInput = nonNegative(usage.input_tokens ?? usage.input) ?? 0;
  const input = Math.max(0, reportedInput - cacheRead - cacheWrite);
  const output = nonNegative(usage.output_tokens ?? usage.output) ?? 0;
  const result: Usage = {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning: nonNegative(outputDetails.reasoning_tokens) ?? undefined,
    totalTokens:
      nonNegative(usage.total_tokens) ??
      input + cacheRead + cacheWrite + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model, result);
  return result;
}

function validIdentity(value: unknown): value is CodexIdentity {
  return (
    isObject(value) &&
    value.provider === "openai-codex" &&
    value.api === "openai-codex-responses" &&
    nonemptyString(value.model) &&
    value.endpoint === ENDPOINT &&
    value.authMode === "oauth" &&
    nonemptyString(value.accountFingerprint) &&
    value.protocol === PROTOCOL
  );
}

function isCompactionArtifact(value: unknown): value is JsonObject {
  return (
    isObject(value) &&
    value.type === "compaction" &&
    nonemptyString(value.encrypted_content)
  );
}

function isContinuationItem(value: unknown): value is JsonObject {
  return (
    isObject(value) &&
    (value.type === undefined || value.type === "message") &&
    value.role === "user"
  );
}

function isValidArtifact(artifact: unknown[]): boolean {
  return (
    artifact.length > 0 &&
    isCompactionArtifact(artifact.at(-1)) &&
    artifact.slice(0, -1).every(isContinuationItem)
  );
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function extractAccountId(token: string): string | undefined {
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
    );
    if (
      !isObject(payload) ||
      !isObject(payload["https://api.openai.com/auth"])
    ) {
      return undefined;
    }
    const accountId = payload["https://api.openai.com/auth"].chatgpt_account_id;
    return nonemptyString(accountId) ? accountId : undefined;
  } catch {
    return undefined;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new CodexAdapterError("aborted", "request aborted");
  }
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function isRetryableStatus(status: number): boolean {
  return [429, 500, 502, 503, 504].includes(status);
}

function retryAfter(headers: Headers): number | undefined {
  const milliseconds = headers.get("retry-after-ms");
  if (milliseconds !== null) {
    const value = Number(milliseconds);
    if (Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  const retryAfter = headers.get("retry-after");
  if (!retryAfter) {
    return undefined;
  }
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const date = Date.parse(retryAfter);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function retryDelay(attempt: number): number {
  return Math.min(250 * 2 ** attempt, MAX_RETRY_DELAY_MS);
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CodexAdapterError("aborted", "request aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
