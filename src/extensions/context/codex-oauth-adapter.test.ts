import type { Context, Model, Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexAdapterError,
  createCodexIdentity,
  createCodexOAuthAdapter,
  createNativeCheckpoint,
  normalizeCodexEndpoint,
  replaceCanonicalInputSegment,
  validateNativeCompactionDetails,
} from "./codex-oauth-adapter.ts";

const account = "account-fixture-do-not-persist";
const token = `header.${Buffer.from(
  JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: account },
  }),
).toString("base64url")}.signature`;
const model: Model<"openai-codex-responses"> = {
  id: "gpt-5-codex",
  name: "Codex",
  provider: "openai-codex",
  api: "openai-codex-responses",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text"],
  cost: {
    input: 2,
    output: 8,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    tiers: [
      {
        inputTokensAbove: 10,
        input: 4,
        output: 16,
        cacheRead: 0.4,
        cacheWrite: 5,
      },
    ],
  },
  contextWindow: 1_000_000,
  maxTokens: 10_000,
};
const auth = { ok: true as const, apiKey: token };
const usage: Usage = {
  input: 10,
  output: 2,
  cacheRead: 1,
  cacheWrite: 0,
  totalTokens: 13,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const old = { type: "message", role: "user", content: "old" };

function identity() {
  const value = createCodexIdentity(model, auth, true);
  if (!value) {
    throw new Error("expected test identity");
  }
  return value;
}

function checkpoint(
  artifact: Parameters<typeof createNativeCheckpoint>[0]["artifact"] = [
    { type: "compaction", encrypted_content: "opaque-fixture" },
  ],
) {
  const value = createNativeCheckpoint({
    identity: identity(),
    artifact,
    replacedItems: [old],
    lineage: { firstKeptEntryId: "first", leafId: "leaf" },
    usage,
  });
  if (!value) {
    throw new Error("expected test checkpoint");
  }
  return value;
}

function sse(...events: unknown[]) {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
  );
}

function successfulSse(extraOutput: unknown[] = []) {
  return sse(
    ...extraOutput.map((item) => ({ type: "response.output_item.done", item })),
    {
      type: "response.output_item.done",
      item: { type: "compaction", encrypted_content: "opaque-fixture" },
    },
    {
      type: "response.completed",
      response: {
        status: "completed",
        usage: {
          input_tokens: 20,
          output_tokens: 7,
          total_tokens: 27,
          input_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
          output_tokens_details: { reasoning_tokens: 4 },
        },
      },
    },
  );
}

function compact(
  adapter: ReturnType<typeof createCodexOAuthAdapter>,
  options: Partial<Parameters<typeof adapter.compact>[0]> = {},
) {
  return adapter.compact({
    identity: identity(),
    model,
    auth,
    payload: { model: model.id, store: true, input: [old] },
    replacedItems: [old],
    lineage: { firstKeptEntryId: "first", leafId: null },
    ...options,
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("Codex OAuth adapter", () => {
  it("accepts only the exact normalized ChatGPT OAuth surface", () => {
    expect(normalizeCodexEndpoint("https://chatgpt.com/backend-api")).toBe(
      "https://chatgpt.com/backend-api/codex/responses",
    );
    for (const endpoint of [
      "http://chatgpt.com/backend-api",
      "https://other.chatgpt.com/backend-api",
      "https://chatgpt.com/backend-api?x=1",
      "https://token@chatgpt.com/backend-api",
      "https://chatgpt.com:444/backend-api",
      "https://chatgpt.com/api",
    ]) {
      expect(normalizeCodexEndpoint(endpoint)).toBeUndefined();
    }
    expect(createCodexIdentity(model, auth, true)).toEqual(
      expect.objectContaining({
        endpoint: "https://chatgpt.com/backend-api/codex/responses",
        accountFingerprint:
          "ea222337f26968a1a3fda35c833d7fdaf2cedca3fca0d9507d8451cbca4f4347",
      }),
    );
    expect(
      createCodexIdentity({ ...model, provider: "openai" }, auth, true),
    ).toBeUndefined();
    expect(createCodexIdentity(model, auth, false)).toBeUndefined();
  });

  it("captures a reasoning and tool-signature payload without dispatching and rejects serializer failure", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const context: Context = {
      systemPrompt: "be precise",
      tools: [
        {
          name: "inspect",
          description: "inspect",
          parameters: Type.Object({ path: Type.String() }),
        },
      ],
      messages: [
        { role: "user", content: "inspect this", timestamp: 1 },
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "reasoning",
              thinkingSignature:
                '{"type":"reasoning","encrypted_content":"signature"}',
            },
          ],
          api: "openai-codex-responses",
          provider: "openai-codex",
          model: model.id,
          usage,
          stopReason: "stop",
          timestamp: 2,
        },
      ],
    };
    const payload = await createCodexOAuthAdapter().capture({
      model,
      context,
      auth,
      thinking: "high",
      sessionId: "session",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(payload).toEqual(
      expect.objectContaining({
        model: model.id,
        store: false,
        stream: true,
        input: expect.any(Array),
        tools: expect.any(Array),
      }),
    );
    expect(JSON.stringify(payload)).toContain("signature");

    const serializer = (() => {
      throw new Error("serializer failed");
    }) as never;
    await expect(
      createCodexOAuthAdapter({ serializer }).capture({ model, context, auth }),
    ).rejects.toThrow("serializer failed");
  });

  it("parses output-item SSE, retains only the latest user continuation, normalizes usage, and sends Codex headers", async () => {
    let request: RequestInit | undefined;
    const fetch = vi.fn((...args: Parameters<typeof globalThis.fetch>) => {
      request = args[1];
      return Promise.resolve(
        successfulSse([
          { type: "message", role: "assistant", content: providerSecret },
        ]),
      );
    });
    const providerSecret = "provider-response-secret";
    const result = await compact(createCodexOAuthAdapter({ fetch }), {
      sessionId: "session-fixture",
      payload: {
        model: model.id,
        input: [
          old,
          { type: "reasoning", encrypted_content: "do-not-persist" },
          { type: "function_call", name: "inspect", arguments: "{}" },
          { type: "message", role: "user", content: "continue" },
        ],
      },
      replacedItems: [old],
    });
    expect(result.details.checkpoint.artifact).toEqual([
      { type: "compaction", encrypted_content: "opaque-fixture" },
      { type: "message", role: "user", content: "continue" },
    ]);
    expect(JSON.stringify(result.details)).not.toContain("do-not-persist");
    expect(JSON.stringify(result.details)).not.toContain(providerSecret);
    expect(result.usage).toMatchObject({
      input: 15,
      cacheRead: 3,
      cacheWrite: 2,
      output: 7,
      reasoning: 4,
      totalTokens: 27,
    });
    expect(result.usage.cost.total).toBeGreaterThan(0);
    expect(new Headers(request?.headers)).toMatchObject({});
    const headers = new Headers(request?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(headers.get("chatgpt-account-id")).toBe(account);
    expect(headers.get("originator")).toBe("pi");
    expect(headers.get("openai-beta")).toBe("responses=experimental");
    expect(headers.get("accept")).toBe("text/event-stream");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("user-agent")).toMatch(/^pi \(/);
    expect(headers.get("session-id")).toBe("session-fixture");
    expect(headers.get("x-client-request-id")).toBe("session-fixture");
    expect(JSON.parse(request?.body as string)).toEqual(
      expect.objectContaining({
        store: false,
        input: expect.arrayContaining([{ type: "compaction_trigger" }]),
      }),
    );
  });

  it("rejects unsuccessful, malformed, absent, multiple, and oversized SSE artifacts", async () => {
    const responses = [
      sse({ type: "response.completed", response: { status: "failed" } }),
      sse({ type: "response.completed", response: { status: "completed" } }),
      sse(
        {
          type: "response.output_item.done",
          item: { type: "compaction", encrypted_content: "one" },
        },
        {
          type: "response.output_item.done",
          item: { type: "compaction", encrypted_content: "two" },
        },
        { type: "response.completed", response: { status: "completed" } },
      ),
      sse(
        {
          type: "response.output_item.done",
          item: {
            type: "compaction",
            encrypted_content: "x".repeat(17_000),
          },
        },
        { type: "response.completed", response: { status: "completed" } },
      ),
      new Response(`data: ${"x".repeat(70_000)}`),
    ];
    for (const response of responses) {
      await expect(
        compact(
          createCodexOAuthAdapter({ fetch: vi.fn(async () => response) }),
        ),
      ).rejects.toMatchObject({
        code: expect.stringMatching(/protocol|validation/),
      } satisfies Partial<CodexAdapterError>);
    }
  });

  it("retries bounded transient failures with provider delay precedence and never retries auth failures", async () => {
    const sleep = vi.fn(async () => {});
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(successfulSse());
    await expect(
      compact(createCodexOAuthAdapter({ fetch, sleep })),
    ).resolves.toBeDefined();
    expect(sleep).toHaveBeenCalledWith(250, undefined);
    expect(fetch).toHaveBeenCalledTimes(2);

    const milliseconds = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("busy", {
          status: 503,
          headers: { "retry-after-ms": "12", "retry-after": "1" },
        }),
      )
      .mockResolvedValueOnce(successfulSse());
    await compact(createCodexOAuthAdapter({ fetch: milliseconds, sleep }));
    expect(sleep).toHaveBeenLastCalledWith(12, undefined);

    const seconds = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("busy", { status: 503, headers: { "retry-after": "1" } }),
      )
      .mockResolvedValueOnce(successfulSse());
    await compact(createCodexOAuthAdapter({ fetch: seconds, sleep }));
    expect(sleep).toHaveBeenLastCalledWith(1_000, undefined);

    const fixedNow = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(fixedNow);
    const dated = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("busy", {
          status: 503,
          headers: { "retry-after": new Date(fixedNow + 1_000).toUTCString() },
        }),
      )
      .mockResolvedValueOnce(successfulSse());
    await compact(createCodexOAuthAdapter({ fetch: dated, sleep }));
    expect(sleep).toHaveBeenLastCalledWith(1_000, undefined);
    vi.restoreAllMocks();

    const cappedSleep = vi.fn(async () => {});
    await expect(
      compact(
        createCodexOAuthAdapter({
          fetch: vi.fn(
            async () =>
              new Response("busy", {
                status: 503,
                headers: { "retry-after": "3" },
              }),
          ),
          sleep: cappedSleep,
        }),
      ),
    ).rejects.toMatchObject({
      code: "http",
    } satisfies Partial<CodexAdapterError>);
    expect(cappedSleep).not.toHaveBeenCalled();

    await expect(
      compact(
        createCodexOAuthAdapter({
          fetch: vi.fn(async () => new Response("no", { status: 401 })),
          sleep,
        }),
      ),
    ).rejects.toMatchObject({
      code: "auth",
    } satisfies Partial<CodexAdapterError>);
  });

  it("classifies fetch and stalled-body timeouts separately from user cancellation", async () => {
    const stalledFetch = vi.fn(
      (_url: URL | RequestInfo, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("", "AbortError")),
          ),
        ),
    ) as typeof globalThis.fetch;
    await expect(
      compact(createCodexOAuthAdapter({ fetch: stalledFetch, timeoutMs: 5 })),
    ).rejects.toMatchObject({
      code: "timeout",
    } satisfies Partial<CodexAdapterError>);

    const body = new ReadableStream<Uint8Array>({ start() {} });
    await expect(
      compact(
        createCodexOAuthAdapter({
          fetch: vi.fn(async () => new Response(body)),
          timeoutMs: 5,
        }),
      ),
    ).rejects.toMatchObject({
      code: "timeout",
    } satisfies Partial<CodexAdapterError>);

    const controller = new AbortController();
    const pending = compact(
      createCodexOAuthAdapter({
        fetch: vi.fn(
          async () =>
            new Response(new ReadableStream<Uint8Array>({ start() {} })),
        ),
        timeoutMs: 100,
      }),
      { signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: "aborted",
    } satisfies Partial<CodexAdapterError>);
  });

  it("fails closed after JSON persistence, identity changes, bounds tampering, and ambiguous replay", () => {
    const result = checkpoint([
      { type: "compaction", encrypted_content: "opaque-fixture" },
      { type: "message", role: "user", content: "continue" },
    ]);
    const persisted = JSON.parse(JSON.stringify(result.details));
    expect(validateNativeCompactionDetails(persisted)).toEqual(persisted);
    expect(JSON.stringify(persisted)).not.toContain(token);
    expect(JSON.stringify(persisted)).not.toContain(account);

    const payload = {
      model: model.id,
      input: [old, { type: "message", role: "user", content: "later" }],
      untouched: { key: "value" },
    };
    expect(
      replaceCanonicalInputSegment(payload, [old], persisted, identity()),
    ).toEqual({
      ...payload,
      input: [...persisted.checkpoint.artifact, payload.input[1]],
    });
    expect(
      replaceCanonicalInputSegment(
        { ...payload, input: [old, old] },
        [old],
        persisted,
        identity(),
      ),
    ).toBeUndefined();
    expect(
      replaceCanonicalInputSegment(
        payload,
        [{ ...old, content: "missing" }],
        persisted,
        identity(),
      ),
    ).toBeUndefined();

    for (const mutate of [
      (details: typeof persisted) => {
        details.schemaVersion = 2;
      },
      (details: typeof persisted) => {
        details.checkpoint.hash = "0".repeat(64);
      },
      (details: typeof persisted) => {
        details.checkpoint.serializedBytes++;
      },
      (details: typeof persisted) => {
        (details.identity as { provider: string }).provider = "other";
      },
      (details: typeof persisted) => {
        (details.identity as { api: string }).api = "other";
      },
      (details: typeof persisted) => {
        (details.identity as { endpoint: string }).endpoint =
          "https://other.example";
      },
      (details: typeof persisted) => {
        (details.identity as { authMode: string }).authMode = "api-key";
      },
      (details: typeof persisted) => {
        (details.identity as { protocol: string }).protocol = "other";
      },
      (details: typeof persisted) => {
        (details.checkpoint as { artifact: unknown }).artifact = [undefined];
      },
      (details: typeof persisted) => {
        details.checkpoint.artifact = Array.from({ length: 17 }, () => ({
          type: "message",
          role: "user",
          content: "x",
        }));
      },
      (details: typeof persisted) => {
        details.checkpoint.artifact[0].encrypted_content = "x".repeat(17_000);
      },
    ]) {
      const changed = JSON.parse(JSON.stringify(persisted));
      mutate(changed);
      expect(validateNativeCompactionDetails(changed)).toBeUndefined();
    }
    for (const mutate of [
      (details: typeof persisted) => {
        details.identity.model = "other";
      },
      (details: typeof persisted) => {
        details.identity.accountFingerprint = "0".repeat(64);
      },
    ]) {
      const changed = JSON.parse(JSON.stringify(persisted));
      mutate(changed);
      expect(
        replaceCanonicalInputSegment(payload, [old], changed, identity()),
      ).toBeUndefined();
    }
  });
});
