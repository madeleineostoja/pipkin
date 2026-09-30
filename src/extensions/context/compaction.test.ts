import {
  SessionManager,
  buildSessionProjection,
  convertToLlm,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createCompactionCoordinator } from "./compaction.ts";
import {
  CodexAdapterError,
  createNativeCheckpoint,
  createCodexOAuthAdapter,
  createCodexIdentity,
} from "./codex-oauth-adapter.ts";

const model = {
  id: "low-model",
  name: "Low",
  provider: "test",
  api: "openai-completions",
  baseUrl: "https://example.test",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 8_000,
} as Model<"openai-completions">;

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function event(
  overrides: Partial<SessionBeforeCompactEvent> = {},
): SessionBeforeCompactEvent {
  return {
    type: "session_before_compact",
    preparation: {
      firstKeptEntryId: "kept",
      messagesToSummarize: [
        { role: "user", content: "old work", timestamp: 1 },
      ],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 123,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: {
        enabled: true,
        reserveTokens: 8_000,
        keepRecentTokens: 1_000,
      },
    },
    branchEntries: [],
    reason: "manual",
    willRetry: false,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function context(response = vi.fn(async () => assistant("summary"))) {
  const notify = vi.fn();
  const streamSimple = vi.fn(() => assistantStream(() => response()));
  return {
    response,
    streamSimple,
    notify,
    ctx: {
      model,
      thinkingLevel: "high",
      modelRegistry: {
        find: vi.fn(() => model),
        streamSimple,
      },
      ui: { notify },
      sessionManager: { getBranch: () => [], getSessionId: () => "session" },
      getSystemPrompt: () => "system",
    } as unknown as ExtensionContext,
  };
}

function assistantStream(response: () => Promise<AssistantMessage>) {
  const stream = createAssistantMessageEventStream();
  void response().then(
    (message) => stream.end(message),
    (error: unknown) =>
      stream.end({
        ...assistant(""),
        stopReason: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
      }),
  );
  return stream;
}

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason: "stop" as const,
    timestamp: 2,
  };
}

describe("CompactionCoordinator textual route", () => {
  it("uses the configured low model and thinking level for instructed manual compaction", async () => {
    const fixture = context();
    const coordinator = createCompactionCoordinator({
      low: { model: "test/low-model", thinking: "high" },
      configPath: "config.json",
    });

    const result = await coordinator.beforeCompact(
      event({ customInstructions: "Keep the deployment decision." }),
      fixture.ctx,
    );

    expect(result).toEqual(
      expect.objectContaining({
        compaction: expect.objectContaining({
          firstKeptEntryId: "kept",
          tokensBefore: 123,
          summary: expect.stringContaining("summary"),
        }),
      }),
    );
    expect(fixture.streamSimple).toHaveBeenCalledWith(
      model,
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            content: [
              expect.objectContaining({
                text: expect.stringContaining("Keep the deployment decision."),
              }),
            ],
          }),
        ]),
      }),
      expect.objectContaining({ reasoning: "high", cacheRetention: "none" }),
    );
  });

  it("preserves Pi split-turn calls and represents configured off by omitting reasoning", async () => {
    const fixture = context(vi.fn(async () => assistant("part")));
    const coordinator = createCompactionCoordinator({
      low: { model: "test/low-model", thinking: "off" },
      configPath: "config.json",
    });
    const split = event({
      reason: "overflow",
      willRetry: true,
      preparation: {
        ...event().preparation,
        isSplitTurn: true,
        turnPrefixMessages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "prefix" }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage,
            stopReason: "stop",
            timestamp: 2,
          },
        ],
      },
    });

    const result = await coordinator.beforeCompact(split, fixture.ctx);

    expect(fixture.streamSimple).toHaveBeenCalledTimes(2);
    expect(fixture.streamSimple.mock.calls).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([
          model,
          expect.anything(),
          expect.not.objectContaining({ reasoning: expect.anything() }),
        ]),
      ]),
    );
    expect(result).toEqual(
      expect.objectContaining({
        compaction: expect.objectContaining({
          summary: expect.stringContaining("Turn Context (split turn)"),
        }),
      }),
    );
  });

  it("cancels already-aborted requests before resolving any native or low model", async () => {
    const fixture = context();
    const controller = new AbortController();
    controller.abort();
    const coordinator = createCompactionCoordinator({
      low: undefined,
      configPath: "config.json",
    });
    fixture.ctx.model = {
      ...model,
      provider: "openai-codex",
      api: "openai-codex-responses",
    };

    await expect(
      coordinator.beforeCompact(
        event({ signal: controller.signal }),
        fixture.ctx,
      ),
    ).resolves.toEqual({ cancel: true });
    expect(fixture.ctx.modelRegistry.find).not.toHaveBeenCalled();
    expect(fixture.streamSimple).not.toHaveBeenCalled();
    expect(fixture.notify).not.toHaveBeenCalled();
  });

  it.each(["stop", "error"] as const)(
    "cancels when the low request aborts even if it finishes with %s",
    async (stopReason) => {
      const controller = new AbortController();
      const fixture = context(
        vi.fn(async () => {
          controller.abort();
          return { ...assistant("summary"), stopReason };
        }),
      );
      const coordinator = createCompactionCoordinator({
        low: { model: "test/low-model", thinking: "minimal" },
        configPath: "config.json",
      });

      await expect(
        coordinator.beforeCompact(
          event({
            signal: controller.signal,
            customInstructions: "Keep decisions",
          }),
          fixture.ctx,
        ),
      ).resolves.toEqual({ cancel: true });
      expect(fixture.streamSimple).toHaveBeenCalledOnce();
      expect(fixture.notify).not.toHaveBeenCalled();
    },
  );

  it("returns no hook result when the low completion fails", async () => {
    const fixture = context(
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const coordinator = createCompactionCoordinator({
      low: { model: "test/low-model", thinking: "minimal" },
      configPath: "config.json",
    });

    await expect(
      coordinator.beforeCompact(event({ reason: "threshold" }), fixture.ctx),
    ).resolves.toBeUndefined();
    expect(fixture.notify).toHaveBeenCalledWith(
      expect.stringContaining("using Pi's current model compaction"),
      "warning",
    );
  });

  it("falls back after eligible native failures and reports only bounded allowlisted reasons", async () => {
    const nativeModel = {
      ...model,
      id: "gpt-5-codex",
      provider: "openai-codex",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
    } as Model<"openai-codex-responses">;
    const unsafe = `Bearer secret-account\n${"payload".repeat(100)}`;
    const compact = vi
      .fn()
      .mockRejectedValueOnce(
        new CodexAdapterError("http", "Codex request failed (503)"),
      )
      .mockRejectedValueOnce(new CodexAdapterError("protocol", unsafe))
      .mockRejectedValueOnce(new Error(unsafe))
      .mockRejectedValueOnce(
        new CodexAdapterError("aborted", "request aborted"),
      );
    const response = vi.fn(async () => assistant("text fallback"));
    const streamSimple = vi.fn(() => assistantStream(() => response()));
    const reportNativeFailure = vi.fn();
    const isUsingOAuth = vi.fn(() => false);
    const notify = vi.fn();
    const ctx = {
      model: nativeModel,
      thinkingLevel: "high",
      modelRegistry: {
        getApiKeyAndHeaders: vi.fn(async () => ({
          ok: true,
          apiKey: "token",
        })),
        isUsingOAuth,
        find: vi.fn(() => model),
        streamSimple,
      },
      ui: { notify },
      sessionManager: {
        getBranch: () => [],
        buildSessionProjection: () => buildSessionProjection([kept]),
        getLeafId: () => null,
        getSessionId: () => "session",
      },
      getSystemPrompt: () => "system",
    } as unknown as ExtensionContext;
    const coordinator = createCompactionCoordinator({
      low: { model: "test/low-model", thinking: "low" },
      configPath: "config.json",
      reportNativeFailure,
      adapter: {
        supports: (_model: unknown, _auth: unknown, oauth: boolean) =>
          oauth
            ? {
                provider: "openai-codex",
                api: "openai-codex-responses",
                model: nativeModel.id,
                endpoint: "https://chatgpt.com/backend-api/codex/responses",
                authMode: "oauth",
                accountFingerprint: "a".repeat(64),
                protocol: "pipkin-codex-compaction-trigger-v1",
              }
            : undefined,
        capture: vi.fn(async () => ({ input: [] })),
        compact,
      } as never,
    });
    const kept = {
      type: "message" as const,
      id: "kept",
      parentId: null,
      timestamp: new Date(1).toISOString(),
      message: { role: "user" as const, content: "kept", timestamp: 1 },
    };
    const nativeEvent = event({ branchEntries: [kept] });

    await expect(coordinator.beforeCompact(nativeEvent, ctx)).resolves.toEqual(
      expect.objectContaining({ compaction: expect.anything() }),
    );
    expect(reportNativeFailure).not.toHaveBeenCalled();
    isUsingOAuth.mockReturnValue(true);
    streamSimple.mockClear();

    await expect(coordinator.beforeCompact(nativeEvent, ctx)).resolves.toEqual(
      expect.objectContaining({ compaction: expect.anything() }),
    );
    await expect(coordinator.beforeCompact(nativeEvent, ctx)).resolves.toEqual(
      expect.objectContaining({ compaction: expect.anything() }),
    );
    await expect(coordinator.beforeCompact(nativeEvent, ctx)).resolves.toEqual(
      expect.objectContaining({ compaction: expect.anything() }),
    );
    await expect(coordinator.beforeCompact(nativeEvent, ctx)).resolves.toEqual({
      cancel: true,
    });

    expect(reportNativeFailure.mock.calls).toEqual([
      ["request failed (503)", "models-low"],
      ["provider response was invalid", "models-low"],
      ["internal adapter failure", "models-low"],
    ]);
    expect(JSON.stringify(reportNativeFailure.mock.calls)).not.toContain(
      "secret-account",
    );

    compact.mockRejectedValueOnce(
      new CodexAdapterError("transport", "Codex transport failed"),
    );
    reportNativeFailure.mockImplementationOnce(() => {
      throw new Error("session persistence failed");
    });
    await expect(coordinator.beforeCompact(nativeEvent, ctx)).resolves.toEqual(
      expect.objectContaining({ compaction: expect.anything() }),
    );
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("transport failed"),
      "warning",
    );

    compact.mockRejectedValueOnce(
      new CodexAdapterError("capture", "payload capture failed"),
    );
    response.mockRejectedValueOnce(new Error("low model unavailable"));
    await expect(
      coordinator.beforeCompact(nativeEvent, ctx),
    ).resolves.toBeUndefined();
    expect(reportNativeFailure).toHaveBeenLastCalledWith(
      "provider payload capture failed",
      "pi",
    );
    expect(streamSimple).toHaveBeenCalledTimes(5);
  });

  it("uses Pi's current prompt while converting prior compaction summaries", async () => {
    const nativeModel = {
      ...model,
      id: "gpt-5-codex",
      provider: "openai-codex",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
    } as Model<"openai-codex-responses">;
    const capture = vi.fn(
      async ({ context }: { context: { messages: unknown[] } }) => ({
        input: context.messages,
      }),
    );
    const adapter = {
      supports: vi.fn(() => ({ identity: "native" })),
      capture,
      compact: vi.fn(async () => ({
        summary: "native marker",
        details: {},
        usage,
      })),
    };
    const entries = [
      {
        type: "message" as const,
        id: "old",
        parentId: null,
        timestamp: new Date(1).toISOString(),
        message: { role: "user" as const, content: "old", timestamp: 1 },
      },
      {
        type: "message" as const,
        id: "kept",
        parentId: "old",
        timestamp: new Date(2).toISOString(),
        message: { role: "user" as const, content: "kept", timestamp: 2 },
      },
      {
        type: "compaction" as const,
        id: "textual",
        parentId: "kept",
        timestamp: new Date(3).toISOString(),
        summary: "prior textual summary",
        firstKeptEntryId: "kept",
        tokensBefore: 10,
        systemMessage: {
          role: "system" as const,
          content: "persisted prompt",
          toolsAdded: [
            {
              name: "persisted_tool",
              description: "persisted tool",
              parameters: { type: "object" },
            },
          ],
          timestamp: 3,
        },
      },
    ];
    const notify = vi.fn();
    const ctx = {
      model: nativeModel,
      thinkingLevel: "high",
      modelRegistry: {
        getApiKeyAndHeaders: vi.fn(async () => ({
          ok: true,
          apiKey: "token",
        })),
        isUsingOAuth: vi.fn(() => true),
      },
      ui: { notify },
      sessionManager: {
        getBranch: () => entries,
        buildSessionProjection: () => buildSessionProjection(entries),
        getLeafId: () => "textual",
        getSessionId: () => "session",
      },
      getSystemPrompt: () => "system",
    } as unknown as ExtensionContext;
    const coordinator = createCompactionCoordinator({
      low: { model: "test/low-model", thinking: "low" },
      configPath: "config.json",
      adapter: adapter as never,
    });

    await expect(
      coordinator.beforeCompact(
        event({
          branchEntries: entries,
          preparation: { ...event().preparation, firstKeptEntryId: "kept" },
        }),
        ctx,
      ),
    ).resolves.toEqual(
      expect.objectContaining({ compaction: expect.anything() }),
    );

    const current = capture.mock.calls[0]?.[0].context as {
      systemPrompt?: string;
      tools?: unknown[];
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(current.systemPrompt).toBe("system");
    expect(current.tools).toEqual([
      expect.objectContaining({ name: "persisted_tool" }),
    ]);
    expect(current.messages.some((message) => message.role === "system")).toBe(
      false,
    );

    const captured = capture.mock.calls.flatMap(
      ([input]) =>
        input.context.messages as Array<{ role: string; content: unknown }>,
    );
    expect(captured).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: [
            expect.objectContaining({
              text: expect.stringContaining("prior textual summary"),
            }),
          ],
        }),
      ]),
    );
  });

  it("replays persisted checkpoints across forks, resume, and another native compaction", async () => {
    const nativeModel = {
      ...model,
      id: "gpt-5-codex",
      provider: "openai-codex",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
    } as Model<"openai-codex-responses">;
    const apiKey = `header.${Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: "account" },
      }),
    ).toString("base64url")}.signature`;
    const auth = { ok: true as const, apiKey };
    const fetch = vi.fn(
      async (_url: URL | RequestInfo, _init?: RequestInit) =>
        new Response(
          [
            {
              type: "response.output_item.done",
              item: {
                type: "compaction",
                id: "cmp-next",
                encrypted_content: "next opaque",
              },
            },
            { type: "response.completed", response: { status: "completed" } },
          ]
            .map((item) => `data: ${JSON.stringify(item)}\n\n`)
            .join(""),
        ),
    );
    const adapter = createCodexOAuthAdapter({ fetch });
    const checkpoint = createNativeCheckpoint({
      identity: createCodexIdentity(nativeModel, auth, true)!,
      artifact: [{ type: "compaction", encrypted_content: "opaque" }],
      lineage: { firstKeptEntryId: "kept", leafId: "projected" },
      usage,
    });
    if (!checkpoint) {
      throw new Error("expected native checkpoint fixture");
    }
    const entries = [
      {
        type: "message" as const,
        id: "kept",
        parentId: null,
        timestamp: new Date(1).toISOString(),
        message: { role: "user" as const, content: "kept", timestamp: 1 },
      },
      {
        type: "message" as const,
        id: "overflow",
        parentId: "kept",
        timestamp: new Date(1).toISOString(),
        message: {
          role: "user" as const,
          content: "abandoned overflow input",
          timestamp: 1,
        },
      },
      {
        type: "context_edit" as const,
        id: "overflow-omission",
        parentId: "overflow",
        timestamp: new Date(1).toISOString(),
        targetId: "overflow",
        replacement: null,
      },
      {
        type: "context_edit" as const,
        id: "projected",
        parentId: "overflow-omission",
        timestamp: new Date(1).toISOString(),
        targetId: "kept",
        replacement: { content: "canonical kept text" },
      },
      {
        type: "compaction" as const,
        id: "native",
        parentId: "projected",
        timestamp: new Date(2).toISOString(),
        summary: checkpoint.summary,
        details: checkpoint.details,
        firstKeptEntryId: "kept",
        tokensBefore: 1,
      },
      {
        type: "message" as const,
        id: "later",
        parentId: "native",
        timestamp: new Date(3).toISOString(),
        message: { role: "user" as const, content: "later", timestamp: 3 },
      },
    ];
    const coordinator = createCompactionCoordinator({
      low: { model: "test/low-model", thinking: "low" },
      configPath: "config.json",
      adapter,
    });
    const restoredEntries = () => JSON.parse(JSON.stringify(entries)) as never;
    const resumed = SessionManager.inMemory(
      "/resumed",
      undefined,
      restoredEntries(),
    );
    const containingFork = SessionManager.inMemory(
      "/fork-containing-checkpoint",
      undefined,
      restoredEntries(),
    );
    containingFork.branch("native");
    const forkBeforeCheckpoint = SessionManager.inMemory(
      "/fork-before-checkpoint",
      undefined,
      restoredEntries(),
    );
    forkBeforeCheckpoint.branch("kept");
    const contextFor = (sessionManager: SessionManager) =>
      ({
        model: nativeModel,
        modelRegistry: {
          getApiKeyAndHeaders: vi.fn(async () => auth),
          isUsingOAuth: vi.fn(() => true),
        },
        abort: vi.fn(),
        ui: { notify: vi.fn() },
        sessionManager,
        getSystemPrompt: () => "current forced prompt ".repeat(2_000),
      }) as unknown as ExtensionContext;
    const payloadFor = (sessionManager: SessionManager) =>
      adapter.capture({
        model: nativeModel,
        auth,
        context: {
          systemPrompt: contextFor(sessionManager).getSystemPrompt(),
          messages: convertToLlm(
            sessionManager.buildSessionProjection().messages,
          ).filter((message) => message.role !== "system"),
        },
      });
    const payload = await payloadFor(resumed);
    const replayed = (await coordinator.beforeProviderRequest(
      payload,
      contextFor(resumed),
    )) as typeof payload;
    expect(replayed.input).toEqual([
      ...checkpoint.details.checkpoint.artifact,
      { role: "user", content: [{ type: "input_text", text: "later" }] },
    ]);
    expect(replayed.instructions).toBe(payload.instructions);
    const forkPayload = await payloadFor(containingFork);
    const forkReplayed = (await coordinator.beforeProviderRequest(
      forkPayload,
      contextFor(containingFork),
    )) as typeof payload;
    expect(forkReplayed.input).toEqual(checkpoint.details.checkpoint.artifact);
    await expect(
      coordinator.beforeProviderRequest(
        await payloadFor(forkBeforeCheckpoint),
        contextFor(forkBeforeCheckpoint),
      ),
    ).resolves.toBeUndefined();

    const invalidated = SessionManager.inMemory(
      "/invalidated",
      undefined,
      restoredEntries(),
    );
    invalidated.appendContextEdit("kept", {
      content: "changed after checkpoint",
    });
    const invalidatedContext = contextFor(invalidated);
    await expect(
      coordinator.beforeProviderRequest(
        await payloadFor(invalidated),
        invalidatedContext,
      ),
    ).resolves.toBeUndefined();
    expect(invalidatedContext.abort).toHaveBeenCalledOnce();

    const compacted = await coordinator.beforeCompact(
      event({
        branchEntries: resumed.getBranch(),
        preparation: { ...event().preparation, firstKeptEntryId: "later" },
      }),
      contextFor(resumed),
    );
    expect(compacted).toHaveProperty("compaction");
    if (!compacted || !("compaction" in compacted)) {
      throw new Error("expected native compaction");
    }
    const sent = JSON.parse(fetch.mock.calls[0]?.[1]?.body as string);
    expect(sent.input).toEqual([
      ...checkpoint.details.checkpoint.artifact,
      { role: "user", content: [{ type: "input_text", text: "later" }] },
      { type: "compaction_trigger" },
    ]);
    const next = compacted.compaction;
    resumed.appendCompaction(
      next.summary,
      next.firstKeptEntryId,
      next.tokensBefore,
      next.details,
    );
    const nextReplayed = (await coordinator.beforeProviderRequest(
      await payloadFor(resumed),
      contextFor(resumed),
    )) as typeof payload;
    expect(nextReplayed.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "later" }] },
      { type: "compaction", id: "cmp-next", encrypted_content: "next opaque" },
    ]);
  });

  it("refuses instructed, incompatible and corrupt opaque authority without any textual fallback", async () => {
    const nativeModel = {
      ...model,
      id: "gpt-5-codex",
      provider: "openai-codex",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
    } as Model<"openai-codex-responses">;
    const apiKey = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "original-account" } })).toString("base64url")}.signature`;
    const auth = { ok: true as const, apiKey };
    const manager = SessionManager.inMemory("/work");
    const kept = manager.appendMessage({
      role: "user",
      content: "kept",
      timestamp: 1,
    });
    const checkpoint = createNativeCheckpoint({
      identity: createCodexIdentity(nativeModel, auth, true)!,
      artifact: [{ type: "compaction", encrypted_content: "opaque fixture" }],
      lineage: { firstKeptEntryId: kept, leafId: kept },
      usage,
    });
    const checkpointId = manager.appendCompaction(
      checkpoint.summary,
      kept,
      100,
      checkpoint.details,
    );
    const fetch = vi.fn();
    const adapter = createCodexOAuthAdapter({ fetch });
    const textual = context();
    const abort = vi.fn();
    const ctx = {
      ...textual.ctx,
      model: nativeModel,
      abort,
      sessionManager: manager,
      modelRegistry: {
        ...textual.ctx.modelRegistry,
        getApiKeyAndHeaders: vi.fn(async () => auth),
        isUsingOAuth: () => true,
      },
    } as unknown as ExtensionContext;
    const reportNativeFailure = vi.fn();
    const coordinator = createCompactionCoordinator({
      low: { model: "test/low-model", thinking: "low" },
      configPath: "config.json",
      adapter,
      reportNativeFailure,
    });
    const attempt = (customInstructions?: string) =>
      coordinator.beforeCompact(
        event({
          branchEntries: manager.getBranch(),
          customInstructions,
          preparation: { ...event().preparation, firstKeptEntryId: kept },
        }),
        ctx,
      );
    expect(await attempt("summarize differently")).toEqual({ cancel: true });
    ctx.model = model;
    await coordinator.modelSelect({ model } as never, ctx);
    expect(textual.notify).toHaveBeenCalledWith(
      expect.stringContaining("original compatible Codex model/account"),
      "warning",
    );
    expect(await attempt()).toEqual({ cancel: true });
    expect(
      await coordinator.beforeProviderRequest({ input: [] }, ctx),
    ).toBeUndefined();
    expect(abort).toHaveBeenCalledOnce();
    ctx.model = nativeModel;
    manager.appendCompaction(checkpoint.summary, kept, 100, {
      ...checkpoint.details,
      kind: "corrupt-kind",
    });
    expect(await attempt()).toEqual({ cancel: true });
    manager.branch(checkpointId);
    manager.appendCompaction("unrelated textual summary", kept, 100);
    expect(await attempt()).toEqual({ cancel: true });
    expect(textual.streamSimple).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(reportNativeFailure).toHaveBeenCalledWith(
      "compatible Codex OAuth route is unavailable",
      "cancelled",
    );
  });

  it("does not replay a checkpoint whose persisted lineage differs from its entry", async () => {
    const nativeModel = {
      ...model,
      id: "gpt-5-codex",
      provider: "openai-codex",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
    } as Model<"openai-codex-responses">;
    const checkpoint = createNativeCheckpoint({
      identity: {
        provider: "openai-codex",
        api: "openai-codex-responses",
        model: nativeModel.id,
        endpoint: "https://chatgpt.com/backend-api/codex/responses",
        authMode: "oauth",
        accountFingerprint: "a".repeat(64),
        protocol: "pipkin-codex-compaction-trigger-v1",
      },
      artifact: [{ type: "compaction", encrypted_content: "opaque" }],
      lineage: { firstKeptEntryId: "tampered", leafId: "kept" },
      usage,
    });
    if (!checkpoint) {
      throw new Error("expected native checkpoint fixture");
    }
    const entries = [
      {
        type: "message" as const,
        id: "kept",
        parentId: null,
        timestamp: new Date(1).toISOString(),
        message: { role: "user" as const, content: "kept", timestamp: 1 },
      },
      {
        type: "compaction" as const,
        id: "native",
        parentId: "kept",
        timestamp: new Date(2).toISOString(),
        summary: checkpoint.summary,
        details: checkpoint.details,
        firstKeptEntryId: "kept",
        tokensBefore: 1,
      },
    ];
    const replay = vi.fn();
    const notify = vi.fn();
    const coordinator = createCompactionCoordinator({
      low: { model: "test/low-model", thinking: "low" },
      configPath: "config.json",
      adapter: {
        supports: () => checkpoint.details.identity,
        replay,
      } as never,
    });
    const abort = vi.fn();
    const ctx = {
      abort,
      model: nativeModel,
      modelRegistry: {
        getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "token" })),
        isUsingOAuth: vi.fn(() => true),
      },
      ui: { notify },
      sessionManager: { getBranch: () => entries },
    } as unknown as ExtensionContext;

    await expect(
      coordinator.beforeProviderRequest({ input: [] }, ctx),
    ).resolves.toBeUndefined();
    expect(replay).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("could not be safely replayed"),
      "warning",
    );
  });
});
