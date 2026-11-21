import { openAICodexResponsesApi } from "@earendil-works/pi-ai/compat";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createManagedSessionHarness } from "#test/managed-session";
import { createCompactionCoordinator } from "./compaction.ts";
import {
  createCodexOAuthAdapter,
  NATIVE_COMPACTION_MARKER,
} from "./codex-oauth-adapter.ts";

describe("native checkpoint request replay", () => {
  it("preserves canonical system transitions during creation and later provider requests", async () => {
    const apiKey = `header.${Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: "fixture" },
      }),
    ).toString("base64url")}.signature`;
    type Request = {
      input: { role?: string; content?: unknown; type?: string }[];
    };
    const nativeRequests: Request[] = [];
    const adapter = createCodexOAuthAdapter({
      fetch: async (_url, init) => {
        nativeRequests.push(JSON.parse(init?.body as string));
        return new Response(
          [
            {
              type: "response.output_item.done",
              item: { type: "compaction", encrypted_content: "opaque fixture" },
            },
            { type: "response.completed", response: { status: "completed" } },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
        );
      },
    });
    const coordinator = createCompactionCoordinator({
      low: undefined,
      configPath: "fixture.json",
      adapter,
    });
    let mode: string | undefined;
    const harness = await createManagedSessionHarness([], {
      extensionFactories: [
        (pi) => {
          pi.registerTool({
            name: "fixture_tool",
            label: "Fixture",
            description: "Exercise in-band tool declarations.",
            parameters: Type.Object({}),
            execute: async () => ({ content: [], details: undefined }),
          });
          pi.on("before_agent_start", (event) => {
            if (mode) {
              event.systemPromptOptions.sections.fixture = mode;
            }
          });
          pi.on("session_before_compact", (event, ctx) =>
            coordinator.beforeCompact(event, ctx),
          );
          pi.on("before_provider_request", (event, ctx) =>
            coordinator.beforeProviderRequest(event.payload, ctx),
          );
        },
      ],
    });
    const requests: Request[] = [];
    harness.modelRuntime.registerProvider("openai-codex", {
      api: "openai-codex-responses",
      apiKey,
      models: [
        {
          ...harness.model,
          id: "fixture-codex",
          api: "openai-codex-responses",
          reasoning: true,
          baseUrl: "https://chatgpt.com/backend-api",
          compat: {
            supportsAdditionalTools: true,
            supportsMidConvoSystemMessages: true,
            supportsMidConvoEffort: true,
          },
        },
      ],
      streamSimple: (model, context, options) => {
        const stream = createAssistantMessageEventStream();
        void (async () => {
          // Exercise Pi's serializer and request hook, stopping before transport.
          await openAICodexResponsesApi()
            .streamSimple(model, context, {
              ...options,
              onPayload: async (payload) => {
                const replayed = await options?.onPayload?.(payload, model);
                requests.push((replayed ?? payload) as Request);
                throw new Error("fixture capture stop");
              },
            })
            .result();
          stream.end({
            ...fauxAssistantMessage(
              requests.length === 1
                ? "old response ".repeat(10_000)
                : "fixture response",
              { stopReason: options?.signal?.aborted ? "aborted" : "stop" },
            ),
            api: model.api,
            provider: model.provider,
            model: model.id,
          });
        })();
        return stream;
      },
    });
    const oauth = vi
      .spyOn(harness.modelRuntime, "isUsingOAuth")
      .mockReturnValue(true);
    const { session } = await harness.createSession();
    try {
      await session.bindExtensions({ mode: "json", uiContext: {} as never });
      await session.setModel(
        harness.modelRuntime.getModel("openai-codex", "fixture-codex")!,
      );
      session.setThinkingLevel("low");
      await session.prompt("old request ".repeat(10_000));
      mode = "kept mode";
      await session.prompt("keep this request");
      mode = undefined;
      await session.prompt("restore the ordinary prompt");
      await session.compact();
      expect(nativeRequests).toHaveLength(1);
      expect(
        nativeRequests[0].input
          .filter((item) => item.role === "developer")
          .map((item) => item.content),
      ).toContainEqual(expect.stringContaining("kept mode"));
      session.setThinkingLevel("high");
      for (const next of ["next mode", "later mode"]) {
        mode = next;
        await session.prompt(`continue in ${next}`);
        expect(session.messages.at(-1)).toMatchObject({ stopReason: "stop" });
        const request = requests.at(-1)!;
        expect(request.input.slice(0, 2)).toMatchObject([
          { type: "additional_tools", tools: [{ name: "fixture_tool" }] },
          { role: "developer", content: expect.stringContaining("You are") },
        ]);
        expect(
          request.input.filter(({ type }) => type === "compaction"),
        ).toEqual([
          { type: "compaction", encrypted_content: "opaque fixture" },
        ]);
        expect(request.input.at(-1)).toEqual({
          type: "configuration_update",
          reasoning: { effort: "high" },
        });
        expect(JSON.stringify(request)).toContain(next);
        expect(JSON.stringify(request)).not.toContain(NATIVE_COMPACTION_MARKER);
      }
    } finally {
      await session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
      session.dispose();
      oauth.mockRestore();
    }
  });
});
