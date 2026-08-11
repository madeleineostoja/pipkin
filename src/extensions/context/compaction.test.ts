import type {
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createCompactionCoordinator } from "./compaction.ts";
import { createNativeCheckpoint } from "./codex-oauth-adapter.ts";

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

function context(complete = vi.fn(async () => assistant("summary"))) {
  const notify = vi.fn();
  return {
    complete,
    notify,
    ctx: {
      model,
      thinkingLevel: "high",
      modelRegistry: {
        find: vi.fn(() => model),
        complete,
      },
      ui: { notify },
      sessionManager: { getBranch: () => [], getSessionId: () => "session" },
      getSystemPrompt: () => "system",
    } as unknown as ExtensionContext,
  };
}

function assistant(text: string) {
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
    expect(fixture.complete).toHaveBeenCalledWith(
      model,
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: [
              expect.objectContaining({
                text: expect.stringContaining("Keep the deployment decision."),
              }),
            ],
          }),
        ],
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

    expect(fixture.complete).toHaveBeenCalledTimes(2);
    expect(fixture.complete.mock.calls).toEqual(
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

  it("converts prior Pi compaction summaries before native serializer capture", async () => {
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
      replacedItems: [{ type: "message", role: "user", content: "old" }],
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
    const ctx = {
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
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("could not be safely replayed"),
      "warning",
    );
  });
});
