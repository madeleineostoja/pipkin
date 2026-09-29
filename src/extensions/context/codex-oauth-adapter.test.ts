import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import type { Context, Model, Usage } from "@earendil-works/pi-ai";
import {
  createCodexIdentity,
  createCodexOAuthAdapter,
  createNativeCheckpoint,
  normalizeCodexEndpoint,
  replaceCanonicalInputSegment,
  validateNativeCompactionDetails,
} from "./codex-oauth-adapter.ts";

const account = "account-fixture";
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
  cost: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 },
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
const opaque = { type: "compaction", encrypted_content: "opaque-fixture" };
const lineage = { firstKeptEntryId: "first", leafId: "leaf" };

function identity() {
  return createCodexIdentity(model, auth, true)!;
}

function sse(...events: unknown[]) {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
  );
}

function completion(artifact = opaque) {
  return [
    { type: "response.output_item.done", item: artifact },
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
  ];
}

function compact(
  adapter: ReturnType<typeof createCodexOAuthAdapter>,
  options: Partial<Parameters<typeof adapter.compact>[0]> = {},
) {
  return adapter.compact({
    identity: identity(),
    model,
    auth,
    payload: { model: model.id, input: [old] },
    lineage,
    ...options,
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("Codex OAuth adapter", () => {
  it("uses only the exact ChatGPT OAuth route and resolves endpoint overrides", () => {
    expect(normalizeCodexEndpoint("https://chatgpt.com/backend-api")).toBe(
      "https://chatgpt.com/backend-api/codex/responses",
    );
    for (const endpoint of [
      "http://chatgpt.com/backend-api",
      "https://other.chatgpt.com/backend-api",
      "https://chatgpt.com/backend-api?x=1",
      "https://token@chatgpt.com/backend-api",
      "https://chatgpt.com:444/backend-api",
    ]) {
      expect(normalizeCodexEndpoint(endpoint)).toBeUndefined();
    }
    expect(createCodexIdentity(model, auth, true)).toMatchObject({
      accountFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(
      createCodexIdentity({ ...model, provider: "openai" }, auth, true),
    ).toBeUndefined();
    expect(createCodexIdentity(model, auth, false)).toBeUndefined();
    expect(
      createCodexIdentity(
        { ...model, baseUrl: "https://invalid.example" },
        { ...auth, baseUrl: model.baseUrl },
        true,
      ),
    ).toEqual(identity());
    expect(
      createCodexIdentity(
        model,
        { ...auth, baseUrl: "https://invalid.example" },
        true,
      ),
    ).toBeUndefined();
  });

  it("captures large Pi instructions, schemas, and tool results without dispatching", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const instructions = "instructions ".repeat(4_000);
    const description = "tool schema ".repeat(3_000);
    const result = "tool output ".repeat(8_000);
    const context: Context = {
      systemPrompt: instructions,
      tools: [
        {
          name: "inspect",
          description,
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
            {
              type: "toolCall",
              id: "call-inspect",
              name: "inspect",
              arguments: { path: "file" },
            },
          ],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage,
          stopReason: "toolUse",
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call-inspect",
          toolName: "inspect",
          content: [{ type: "text", text: result }],
          isError: false,
          timestamp: 3,
        },
      ],
    };
    const payload = await createCodexOAuthAdapter().capture({
      model,
      context,
      auth,
      thinking: "high",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(payload.instructions).toContain(instructions);
    expect(payload.tools).toEqual([
      expect.objectContaining({ name: "inspect", description }),
    ]);
    expect(JSON.stringify(payload.input)).toContain(result);
    expect(JSON.stringify(payload.input)).toContain("signature");
  });

  it("normalizes persisted prompt and tool transitions through Pi", async () => {
    const inspect = {
      name: "inspect",
      description: "inspect",
      parameters: Type.Object({ path: Type.String() }),
    };
    const lookup = {
      name: "lookup",
      description: "lookup",
      parameters: Type.Object({ query: Type.String() }),
    };
    const payload = await createCodexOAuthAdapter().capture({
      model,
      auth,
      context: {
        messages: [
          {
            role: "system",
            content: "base prompt",
            sections: { mode: "old mode" },
            toolsAdded: [inspect],
            timestamp: 1,
          },
          { role: "user", content: "first turn", timestamp: 2 },
          {
            role: "system",
            content: "",
            sections: { mode: "new mode" },
            toolsRemoved: [{ name: "inspect" }],
            toolsAdded: [lookup],
            timestamp: 3,
          },
          { role: "user", content: "resumed turn", timestamp: 4 },
        ],
      },
    });
    expect(payload.instructions).toContain("base prompt");
    expect(payload.instructions).toContain("new mode");
    expect(payload.instructions).not.toContain("old mode");
    expect(payload.tools).toEqual([
      expect.objectContaining({ name: "lookup" }),
    ]);
  });

  it("preserves a large provider artifact and all user continuations through persistence and replay", async () => {
    const artifact = {
      ...opaque,
      id: "cmp-1",
      encrypted_content: "opaque".repeat(60_000),
      metadata: { provider: "retained" },
    };
    let request: RequestInit | undefined;
    const fetch = vi.fn(async (_url, init) => {
      request = init;
      return sse(
        {
          type: "response.output_item.done",
          item: {
            type: "message",
            role: "assistant",
            content: "discard output",
          },
        },
        ...completion(artifact),
      );
    }) as typeof globalThis.fetch;
    const adapter = createCodexOAuthAdapter({ fetch });
    const payload = await adapter.capture({
      model,
      auth,
      context: {
        systemPrompt: "instructions ".repeat(3_000),
        messages: Array.from({ length: 20 }, (_, i) => ({
          role: "user" as const,
          content: `turn ${i}`,
          timestamp: i,
        })),
      },
    });
    const result = await compact(adapter, {
      payload,
      sessionId: "session",
      auth: {
        ...auth,
        headers: { "x-codex-beta-features": "existing_feature" },
      },
    });
    const persisted = validateNativeCompactionDetails(
      JSON.parse(JSON.stringify(result.details)),
    )!;
    expect(persisted.checkpoint.artifact).toEqual([
      ...(payload.input as unknown[]),
      artifact,
    ]);
    expect(JSON.stringify(persisted)).not.toContain("discard output");
    expect(JSON.stringify(persisted)).not.toContain(token);
    expect(JSON.stringify(persisted)).not.toContain(account);
    expect(result.usage).toMatchObject({
      input: 15,
      cacheRead: 3,
      cacheWrite: 2,
      output: 7,
      reasoning: 4,
      totalTokens: 27,
    });
    expect(result.usage.cost.total).toBeGreaterThan(0);
    const headers = new Headers(request?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(headers.get("chatgpt-account-id")).toBe(account);
    expect(headers.get("openai-beta")).toBe("responses=experimental");
    expect(headers.get("x-codex-beta-features")).toBe(
      "existing_feature, remote_compaction_v2",
    );
    expect(headers.get("session-id")).toBe("session");
    expect(JSON.parse(request?.body as string).input).toEqual([
      ...(payload.input as unknown[]),
      { type: "compaction_trigger" },
    ]);
    expect(payload.input).toHaveLength(20);

    const marker = { role: "user", content: "marker" };
    const tail = { role: "user", content: "later" };
    expect(
      adapter.replay(
        { ...payload, input: [marker, tail] },
        [marker],
        persisted,
        identity(),
      ),
    ).toEqual({ ...payload, input: [...persisted.checkpoint.artifact, tail] });
  });

  it("rejects incomplete operations and missing, malformed, or multiple artifacts", async () => {
    for (const response of [
      sse({ type: "response.completed", response: { status: "failed" } }),
      sse({ type: "response.completed", response: { status: "completed" } }),
      sse({ type: "response.output_item.done", item: opaque }),
      sse(...completion({ ...opaque, encrypted_content: "" })),
      sse({ type: "response.output_item.done", item: opaque }, ...completion()),
      new Response("data: not-json\n\n"),
    ]) {
      await expect(
        compact(
          createCodexOAuthAdapter({ fetch: vi.fn(async () => response) }),
        ),
      ).rejects.toMatchObject({ code: "protocol" });
    }
    expect(
      validateNativeCompactionDetails({ kind: "pipkin-native-compaction" }),
    ).toBeUndefined();
  });

  it("handles split CRLF SSE and settles on completion without waiting for connection close", async () => {
    const bytes = new TextEncoder().encode(
      completion()
        .map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`)
        .join(""),
    );
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 17));
        controller.enqueue(bytes.slice(17));
      },
      cancel,
    });
    await expect(
      compact(
        createCodexOAuthAdapter({
          fetch: vi.fn(async () => new Response(body)),
        }),
      ),
    ).resolves.toMatchObject({
      details: { checkpoint: { artifact: [old, opaque] } },
    });
    expect(cancel).toHaveBeenCalled();
  });

  it("retries transient HTTP failures, honors provider delay, and never retries authentication", async () => {
    const sleep = vi.fn(async () => {});
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("busy", {
          status: 503,
          headers: { "retry-after-ms": "12" },
        }),
      )
      .mockResolvedValueOnce(sse(...completion()));
    await compact(createCodexOAuthAdapter({ fetch, sleep }));
    expect(sleep).toHaveBeenCalledWith(12, undefined);
    expect(fetch).toHaveBeenCalledTimes(2);
    const unauthorized = vi.fn(async () => new Response("no", { status: 401 }));
    await expect(
      compact(createCodexOAuthAdapter({ fetch: unauthorized, sleep })),
    ).rejects.toMatchObject({ code: "auth" });
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });

  it("cancels both pending HTTP requests and stalled response bodies", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("", "AbortError")),
          );
        }),
    ) as typeof globalThis.fetch;
    const pending = compact(createCodexOAuthAdapter({ fetch }), {
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(fetch).toHaveBeenCalledTimes(1);

    const bodyController = new AbortController();
    const cancel = vi.fn();
    const stalled = compact(
      createCodexOAuthAdapter({
        fetch: vi.fn(
          async () => new Response(new ReadableStream<Uint8Array>({ cancel })),
        ),
      }),
      { signal: bodyController.signal },
    );
    await Promise.resolve();
    bodyController.abort();
    await expect(stalled).rejects.toMatchObject({ code: "aborted" });
    expect(cancel).toHaveBeenCalled();
  });

  it("requires compatible identity and a unique replay target, preserving unrelated input", () => {
    const details = createNativeCheckpoint({
      identity: identity(),
      artifact: [old, opaque],
      lineage,
      usage,
    }).details;
    const persisted = validateNativeCompactionDetails(
      JSON.parse(JSON.stringify(details)),
    )!;
    const tail = { role: "user", content: "later" };
    const prefix = { role: "user", content: "before" };
    const payload = { input: [prefix, old, tail], untouched: { key: "value" } };
    expect(
      replaceCanonicalInputSegment(payload, [old], persisted, identity()),
    ).toEqual({ ...payload, input: [prefix, old, opaque, tail] });
    expect(
      replaceCanonicalInputSegment(
        { input: [old, old] },
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
    expect(
      replaceCanonicalInputSegment(payload, [old], persisted, {
        ...identity(),
        model: "other",
      }),
    ).toBeUndefined();
    expect(
      replaceCanonicalInputSegment(payload, [old], persisted, {
        ...identity(),
        accountFingerprint: "other",
      }),
    ).toBeUndefined();
  });
});
