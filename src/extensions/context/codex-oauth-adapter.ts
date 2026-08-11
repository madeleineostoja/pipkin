import { createHash } from "node:crypto";
import { arch, platform, release } from "node:os";
import { calculateCost } from "@earendil-works/pi-ai";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/compat";
import type {
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  Usage,
} from "@earendil-works/pi-ai";

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
const MAX_ARTIFACT_ITEMS = 16;
const MAX_ARTIFACT_BYTES = 64 * 1024;
const MAX_REPLAY_HASHES = 512;
const MAX_STRING_BYTES = 16 * 1024;
const MAX_SSE_BYTES = 256 * 1024;
const MAX_SSE_LINE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 2_000;
const HASH = /^[a-f0-9]{64}$/;

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
  checkpoint: { artifact: Json[]; hash: string; serializedBytes: number };
  replay: {
    hashVersion: "pipkin-codex-replay-v1";
    replacedItemHashes: string[];
  };
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
  | "timeout"
  | "transport"
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
  timeoutMs?: number;
};

type CodexSerializer = (
  model: Model<"openai-codex-responses">,
  context: Context,
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
  replacedItems: Json[];
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
  if (
    url.protocol !== "https:" ||
    url.hostname !== "chatgpt.com" ||
    url.port !== "" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/backend-api/codex/responses"
  ) {
    return undefined;
  }
  return ENDPOINT;
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
  if (!endpoint || !accountId || !boundedString(model.id)) {
    return undefined;
  }
  return {
    provider: "openai-codex",
    api: "openai-codex-responses",
    model: model.id,
    endpoint,
    authMode: "oauth",
    accountFingerprint: digest("pipkin-codex-account-v1", accountId),
    protocol: PROTOCOL,
  };
}

export function canonicalJson(value: Json): string {
  if (!isJson(value, new Set())) {
    throw new TypeError("invalid JSON value");
  }
  return encodeJson(value, new Set());
}

export function validateNativeCompactionDetails(
  value: unknown,
): NativeCompactionDetails | undefined {
  if (!isObject(value) || encodedSize(value) > MAX_ARTIFACT_BYTES * 2) {
    return undefined;
  }
  const details = value as Partial<NativeCompactionDetails>;
  if (
    !hasOnlyKeys(details, [
      "kind",
      "schemaVersion",
      "adapter",
      "identity",
      "checkpoint",
      "replay",
      "lineage",
    ]) ||
    details.kind !== "pipkin-native-compaction" ||
    details.schemaVersion !== 1 ||
    details.adapter !== "openai-codex" ||
    !validIdentity(details.identity) ||
    !isObject(details.checkpoint) ||
    !isObject(details.replay) ||
    !isObject(details.lineage)
  ) {
    return undefined;
  }
  const checkpoint = details.checkpoint;
  const replay = details.replay;
  const lineage = details.lineage;
  if (
    !hasOnlyKeys(checkpoint, ["artifact", "hash", "serializedBytes"]) ||
    !hasOnlyKeys(replay, ["hashVersion", "replacedItemHashes"]) ||
    !hasOnlyKeys(lineage, ["firstKeptEntryId", "leafId"]) ||
    !Array.isArray(checkpoint.artifact) ||
    checkpoint.artifact.length < 1 ||
    checkpoint.artifact.length > MAX_ARTIFACT_ITEMS ||
    typeof checkpoint.hash !== "string" ||
    !HASH.test(checkpoint.hash) ||
    !Number.isSafeInteger(checkpoint.serializedBytes) ||
    checkpoint.serializedBytes < 1 ||
    checkpoint.serializedBytes > MAX_ARTIFACT_BYTES ||
    replay.hashVersion !== "pipkin-codex-replay-v1" ||
    !Array.isArray(replay.replacedItemHashes) ||
    replay.replacedItemHashes.length < 1 ||
    replay.replacedItemHashes.length > MAX_REPLAY_HASHES ||
    !replay.replacedItemHashes.every(
      (hash) => typeof hash === "string" && HASH.test(hash),
    ) ||
    !boundedString(lineage.firstKeptEntryId) ||
    (lineage.leafId !== null && !boundedString(lineage.leafId))
  ) {
    return undefined;
  }
  try {
    const artifact = ensureJsonArray(checkpoint.artifact);
    if (!isValidArtifact(artifact)) {
      return undefined;
    }
    const encoded = canonicalJson(artifact);
    if (
      Buffer.byteLength(encoded) !== checkpoint.serializedBytes ||
      digest("pipkin-codex-artifact-v1", encoded) !== checkpoint.hash
    ) {
      return undefined;
    }
    return details as NativeCompactionDetails;
  } catch {
    return undefined;
  }
}

export function createNativeCheckpoint(input: {
  identity: CodexIdentity;
  artifact: Json[];
  replacedItems: Json[];
  lineage: NativeCompactionDetails["lineage"];
  usage: Usage;
}): Checkpoint | undefined {
  if (!validIdentity(input.identity) || !validLineage(input.lineage)) {
    return undefined;
  }
  try {
    const artifact = ensureJsonArray(input.artifact);
    const replacedItems = ensureJsonArray(input.replacedItems);
    if (
      !isValidArtifact(artifact) ||
      replacedItems.length < 1 ||
      replacedItems.length > MAX_REPLAY_HASHES
    ) {
      return undefined;
    }
    const serialized = canonicalJson(artifact);
    if (Buffer.byteLength(serialized) > MAX_ARTIFACT_BYTES) {
      return undefined;
    }
    const details: NativeCompactionDetails = {
      kind: "pipkin-native-compaction",
      schemaVersion: 1,
      adapter: "openai-codex",
      identity: input.identity,
      checkpoint: {
        artifact,
        hash: digest("pipkin-codex-artifact-v1", serialized),
        serializedBytes: Buffer.byteLength(serialized),
      },
      replay: {
        hashVersion: "pipkin-codex-replay-v1",
        replacedItemHashes: replacedItems.map((item) =>
          digest("pipkin-codex-replay-item-v1", canonicalJson(item)),
        ),
      },
      lineage: input.lineage,
    };
    return validateNativeCompactionDetails(JSON.parse(JSON.stringify(details)))
      ? { summary: MARKER, details, usage: input.usage }
      : undefined;
  } catch {
    return undefined;
  }
}

export function matchesReplayAnchor(
  details: unknown,
  creationItems: Json[],
): boolean {
  const validated = validateNativeCompactionDetails(details);
  if (
    !validated ||
    creationItems.length !== validated.replay.replacedItemHashes.length
  ) {
    return false;
  }
  try {
    return creationItems.every(
      (item, index) =>
        digest("pipkin-codex-replay-item-v1", canonicalJson(item)) ===
        validated.replay.replacedItemHashes[index],
    );
  } catch {
    return false;
  }
}

export function replaceCanonicalInputSegment(
  payload: JsonObject,
  expectedItems: Json[],
  details: unknown,
  currentIdentity: CodexIdentity,
  creationItems: Json[],
): JsonObject | undefined {
  const validated = validateNativeCompactionDetails(details);
  if (
    !validated ||
    !sameIdentity(validated.identity, currentIdentity) ||
    !matchesReplayAnchor(validated, creationItems) ||
    !Array.isArray(payload.input) ||
    expectedItems.length < 1 ||
    expectedItems.length > MAX_REPLAY_HASHES
  ) {
    return undefined;
  }
  try {
    const expected = ensureJsonArray(expectedItems);
    const input = ensureJsonArray(payload.input);
    const target = canonicalJson(expected);
    const indexes: number[] = [];
    for (let index = 0; index <= input.length - expected.length; index++) {
      if (
        canonicalJson(input.slice(index, index + expected.length)) === target
      ) {
        indexes.push(index);
      }
    }
    if (indexes.length !== 1) {
      return undefined;
    }
    const start = indexes[0];
    return {
      ...payload,
      input: [
        ...input.slice(0, start),
        ...validated.checkpoint.artifact,
        ...input.slice(start + expected.length),
      ],
    };
  } catch {
    return undefined;
  }
}

export function createCodexOAuthAdapter(
  dependencies: CodexAdapterDependencies = {},
) {
  const fetchFn = dependencies.fetch ?? globalThis.fetch;
  const serializer = dependencies.serializer;
  const sleep = dependencies.sleep ?? wait;
  const timeoutMs = dependencies.timeoutMs ?? REQUEST_TIMEOUT_MS;

  return {
    supports(
      model: Model<"openai-codex-responses">,
      auth: ResolvedRequestAuth,
      isUsingOAuth: boolean,
    ): CodexIdentity | undefined {
      return createCodexIdentity(model, auth, isUsingOAuth);
    },

    async capture(input: CaptureInput): Promise<JsonObject> {
      let captured: JsonObject | undefined;
      const stop = new CaptureStop();
      const stream = (serializer ?? openAICodexResponsesApi().streamSimple)(
        input.model,
        input.context,
        {
          apiKey: input.auth.apiKey,
          headers: input.auth.headers,
          sessionId: input.sessionId,
          signal: input.signal,
          transport: "sse",
          reasoning: input.thinking,
          onPayload: (payload) => {
            captured = cloneJsonObject(payload);
            throw stop;
          },
        },
      );
      // The serializer turns the deliberate stop into its terminal stream event.
      // Consume it so no rejected/final stream promise remains unobserved.
      for await (const _event of stream) {
        // Intentional capture does not have a successful provider response.
      }
      const terminal = await stream.result();
      if (!captured) {
        throw new CodexAdapterError(
          terminal.stopReason === "aborted" ? "aborted" : "protocol",
          terminal.stopReason === "aborted"
            ? "payload capture aborted"
            : "payload capture failed",
        );
      }
      return captured;
    },

    async compact(input: CompactionInput): Promise<Checkpoint> {
      const current = createCodexIdentity(input.model, input.auth, true);
      if (!current || !sameIdentity(current, input.identity)) {
        throw new CodexAdapterError("validation", "unsupported Codex identity");
      }
      const result = await requestCompaction({
        endpoint: input.identity.endpoint,
        model: input.model,
        auth: input.auth,
        payload: input.payload,
        sessionId: input.sessionId,
        signal: input.signal,
        fetchFn,
        sleep,
        timeoutMs,
      });
      const checkpoint = createNativeCheckpoint({
        identity: input.identity,
        artifact: result.artifact,
        replacedItems: input.replacedItems,
        lineage: input.lineage,
        usage: result.usage,
      });
      if (!checkpoint) {
        throw new CodexAdapterError("validation", "invalid checkpoint");
      }
      return checkpoint;
    },

    validate: validateNativeCompactionDetails,
    isCompatible(details: unknown, identity: CodexIdentity): boolean {
      const validated = validateNativeCompactionDetails(details);
      return !!validated && sameIdentity(validated.identity, identity);
    },
    replay: replaceCanonicalInputSegment,
  };
}

class CaptureStop extends Error {}

async function requestCompaction(input: {
  endpoint: string;
  model: Model<"openai-codex-responses">;
  auth: ResolvedRequestAuth & { ok: true; apiKey: string };
  payload: JsonObject;
  sessionId?: string;
  signal?: AbortSignal;
  fetchFn: typeof globalThis.fetch;
  sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  timeoutMs: number;
}): Promise<{ artifact: Json[]; usage: Usage }> {
  if (input.signal?.aborted) {
    throw new CodexAdapterError("aborted", "request aborted");
  }
  const accountId = extractAccountId(input.auth.apiKey);
  if (!accountId) {
    throw new CodexAdapterError("auth", "invalid Codex OAuth credentials");
  }
  const body = cloneJsonObject(input.payload);
  if (!Array.isArray(body.input)) {
    throw new CodexAdapterError("validation", "invalid canonical payload");
  }
  body.store = false;
  body.input = [...ensureJsonArray(body.input), { type: "compaction_trigger" }];
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
  headers.set("accept", "text/event-stream");
  headers.set("content-type", "application/json");
  if (input.sessionId && boundedString(input.sessionId)) {
    headers.set("session-id", input.sessionId);
    headers.set("x-client-request-id", input.sessionId);
  }

  for (let attempt = 0; ; attempt++) {
    const timeout = AbortSignal.timeout(input.timeoutMs);
    const signal = AbortSignal.any(
      input.signal ? [input.signal, timeout] : [timeout],
    );
    let response: Response;
    try {
      response = await input.fetchFn(input.endpoint, {
        method: "POST",
        headers,
        body: canonicalJson(body),
        signal,
      });
    } catch {
      if (input.signal?.aborted) {
        throw new CodexAdapterError("aborted", "request aborted");
      }
      if (timeout.aborted) {
        throw new CodexAdapterError("timeout", "Codex request timed out");
      }
      if (attempt < MAX_RETRIES) {
        await input.sleep(retryDelay(attempt), input.signal);
        continue;
      }
      throw new CodexAdapterError("transport", "Codex transport failed");
    }
    if (!response.ok) {
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
        signal,
        input.signal,
        input.model,
        ensureJsonArray(body.input),
      );
    } catch (error) {
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

async function parseCompactionSse(
  response: Response,
  signal: AbortSignal,
  parentSignal: AbortSignal | undefined,
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
  signal.addEventListener("abort", onAbort, { once: true });
  const decoder = new TextDecoder();
  const outputItems: Json[] = [];
  let buffer = "";
  let received = 0;
  let completed: JsonObject | undefined;
  try {
    while (true) {
      throwIfAborted(signal, parentSignal);
      const { done, value } = await readSseChunk(reader, signal, parentSignal);
      throwIfAborted(signal, parentSignal);
      if (done) {
        break;
      }
      received += value.byteLength;
      if (received > MAX_SSE_BYTES) {
        throw new CodexAdapterError("protocol", "SSE response too large");
      }
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary < 0) {
          if (Buffer.byteLength(buffer) > MAX_SSE_LINE_BYTES) {
            throw new CodexAdapterError("protocol", "SSE line too large");
          }
          break;
        }
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (Buffer.byteLength(frame) > MAX_SSE_LINE_BYTES) {
          throw new CodexAdapterError("protocol", "SSE frame too large");
        }
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (!data || data === "[DONE]") {
          continue;
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
        if (event.type === "error" || event.type === "response.failed") {
          throw new CodexAdapterError("protocol", "Codex operation failed");
        }
        if (event.type === "response.output_item.done") {
          if (
            !isJson(event.item, new Set()) ||
            outputItems.length >= MAX_ARTIFACT_ITEMS
          ) {
            throw new CodexAdapterError("validation", "invalid output item");
          }
          outputItems.push(event.item);
        }
        if (
          event.type === "response.completed" ||
          event.type === "response.done"
        ) {
          if (!isObject(event.response) || completed) {
            throw new CodexAdapterError("protocol", "invalid completion event");
          }
          completed = event.response;
        }
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  if (!completed || completed.status !== "completed") {
    throw new CodexAdapterError("protocol", "Codex operation did not complete");
  }
  const compactions: Array<
    JsonObject & { type: "compaction"; encrypted_content: string }
  > = [];
  for (const item of outputItems) {
    if (!isObject(item) || item.type !== "compaction") {
      continue;
    }
    if (!isCompactionArtifact(item)) {
      throw new CodexAdapterError("validation", "invalid compaction artifact");
    }
    compactions.push(item);
  }
  if (compactions.length !== 1) {
    throw new CodexAdapterError("validation", "invalid compaction artifact");
  }
  const artifact = [...continuationItems(canonicalInput), compactions[0]];
  if (
    !isValidArtifact(artifact) ||
    Buffer.byteLength(canonicalJson(artifact)) > MAX_ARTIFACT_BYTES
  ) {
    throw new CodexAdapterError("validation", "compaction artifact too large");
  }
  return { artifact, usage: normalizeUsage(completed.usage, model) };
}

async function readSseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  parentSignal: AbortSignal | undefined,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal, parentSignal));
    signal.addEventListener("abort", onAbort, { once: true });
    void reader.read().then(
      (chunk) => {
        signal.removeEventListener("abort", onAbort);
        resolve(chunk);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function throwIfAborted(
  signal: AbortSignal,
  parentSignal: AbortSignal | undefined,
): void {
  if (signal.aborted) {
    throw abortError(signal, parentSignal);
  }
}

function abortError(
  _signal: AbortSignal,
  parentSignal: AbortSignal | undefined,
): CodexAdapterError {
  return parentSignal?.aborted
    ? new CodexAdapterError("aborted", "request aborted")
    : new CodexAdapterError("timeout", "Codex request timed out");
}

function continuationItems(input: Json[]): Json[] {
  // The opaque state needs recent real user turns in their original order, not
  // a synthetic request suffix or any provider output.
  return input.filter(isContinuationItem).slice(-(MAX_ARTIFACT_ITEMS - 1));
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
    hasOnlyKeys(value, [
      "provider",
      "api",
      "model",
      "endpoint",
      "authMode",
      "accountFingerprint",
      "protocol",
    ]) &&
    value.provider === "openai-codex" &&
    value.api === "openai-codex-responses" &&
    boundedString(value.model) &&
    value.endpoint === ENDPOINT &&
    value.authMode === "oauth" &&
    typeof value.accountFingerprint === "string" &&
    HASH.test(value.accountFingerprint) &&
    value.protocol === PROTOCOL
  );
}

function validLineage(
  value: unknown,
): value is NativeCompactionDetails["lineage"] {
  return (
    isObject(value) &&
    boundedString(value.firstKeptEntryId) &&
    (value.leafId === null || boundedString(value.leafId))
  );
}

function sameIdentity(left: CodexIdentity, right: CodexIdentity): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function isCompactionArtifact(value: Json): value is JsonObject & {
  type: "compaction";
  encrypted_content: string;
} {
  return (
    isObject(value) &&
    hasOnlyKeys(value, ["type", "encrypted_content"]) &&
    value.type === "compaction" &&
    typeof value.encrypted_content === "string" &&
    value.encrypted_content.length > 0 &&
    boundedString(value.encrypted_content)
  );
}

function isContinuationItem(value: Json): value is JsonObject {
  return isObject(value) && value.type === "message" && value.role === "user";
}

function isValidArtifact(artifact: Json[]): boolean {
  return (
    artifact.length >= 1 &&
    artifact.length <= MAX_ARTIFACT_ITEMS &&
    artifact.at(-1) !== undefined &&
    isCompactionArtifact(artifact.at(-1)!) &&
    artifact.slice(0, -1).every(isContinuationItem)
  );
}

function cloneJsonObject(value: unknown): JsonObject {
  const json = ensureJson(value);
  if (!isObject(json)) {
    throw new CodexAdapterError("validation", "expected JSON object");
  }
  return JSON.parse(canonicalJson(json)) as JsonObject;
}

function ensureJson(value: unknown): Json {
  if (!isJson(value, new Set())) {
    throw new CodexAdapterError("validation", "invalid JSON value");
  }
  return value;
}

function ensureJsonArray(value: unknown): Json[] {
  const json = ensureJson(value);
  if (!Array.isArray(json)) {
    throw new CodexAdapterError("validation", "expected JSON array");
  }
  return json;
}

function isJson(value: unknown, seen: Set<object>): value is Json {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return typeof value !== "string" || boundedString(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      seen.has(value) ||
      Object.keys(value).length !== value.length
    ) {
      return false;
    }
    seen.add(value);
    const result = value.every((item) => isJson(item, seen));
    seen.delete(value);
    return result;
  }
  if (!isObject(value) || seen.has(value)) {
    return false;
  }
  seen.add(value);
  const result = Object.entries(value).every(
    ([key, item]) => boundedString(key) && isJson(item, seen),
  );
  seen.delete(value);
  return result;
}

function encodeJson(value: Json, seen: Set<object>): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    if (!isJson(value, new Set())) {
      throw new TypeError("invalid JSON scalar");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value) || Object.keys(value).length !== value.length) {
      throw new TypeError("invalid JSON array");
    }
    seen.add(value);
    const encoded = `[${value.map((item) => encodeJson(item, seen)).join(",")}]`;
    seen.delete(value);
    return encoded;
  }
  if (!isObject(value) || seen.has(value)) {
    throw new TypeError("invalid JSON object");
  }
  seen.add(value);
  const encoded = `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${encodeJson(value[key], seen)}`)
    .join(",")}}`;
  seen.delete(value);
  return encoded;
}

function hasOnlyKeys(value: JsonObject, expected: string[]): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  );
}

function isObject(value: unknown): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function extractAccountId(token: string): string | undefined {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return undefined;
    }
    const decoded = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload: unknown = JSON.parse(decoded);
    if (
      !isObject(payload) ||
      !isObject(payload["https://api.openai.com/auth"])
    ) {
      return undefined;
    }
    const accountId = payload["https://api.openai.com/auth"].chatgpt_account_id;
    return typeof accountId === "string" && boundedString(accountId)
      ? accountId
      : undefined;
  } catch {
    return undefined;
  }
}

function digest(label: string, value: string): string {
  return createHash("sha256")
    .update(label)
    .update("\0")
    .update(value, "utf8")
    .digest("hex");
}

function boundedString(value: unknown): value is string {
  return (
    typeof value === "string" && Buffer.byteLength(value) <= MAX_STRING_BYTES
  );
}

function encodedSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return Infinity;
  }
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function isRetryableStatus(status: number): boolean {
  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
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
    if (signal?.aborted) {
      reject(new CodexAdapterError("aborted", "request aborted"));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new CodexAdapterError("aborted", "request aborted"));
      },
      { once: true },
    );
  });
}
