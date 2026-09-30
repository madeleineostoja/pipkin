import type {
  ExtensionAPI,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  createManagedSessionHarness,
  MANAGED_TEST_CWD,
} from "#test/managed-session";
import context from "./index.ts";
import { PRUNING_TYPE } from "./policy.ts";
import { createCompactionCoordinator } from "./compaction.ts";
import {
  CodexAdapterError,
  createCodexOAuthAdapter,
} from "./codex-oauth-adapter.ts";

function observeOrdering(events: string[]) {
  return (pi: ExtensionAPI) => {
    pi.on("session_compact", () => {
      events.push("session_compact");
    });
    pi.on("context", (event) => {
      const source = event.messages.find(
        (message) =>
          message.role === "toolResult" && message.toolCallId === "source",
      );
      const text =
        source?.role === "toolResult" && source.content[0]?.type === "text"
          ? source.content[0].text
          : "";
      events.push(
        text.includes('read_output({reference:"transcript:v1:')
          ? "context:pruned"
          : "context:full",
      );
    });
  };
}

function user(content: string, timestamp: number) {
  return { role: "user" as const, content, timestamp };
}

describe("manual compaction cancellation", () => {
  it.each(["instructed", "native-failure", "already-aborted"] as const)(
    "does not enter Pi fallback or model routing after cancellation on %s",
    async (route) => {
      const adapter = {
        ...createCodexOAuthAdapter(),
        supports: vi.fn(() => ({
          provider: "openai-codex" as const,
          api: "openai-codex-responses" as const,
          model: "native",
          endpoint: "https://chatgpt.com/backend-api/codex/responses",
          authMode: "oauth" as const,
          accountFingerprint: "a".repeat(64),
          protocol: "pipkin-codex-compaction-trigger-v1" as const,
        })),
        capture: vi.fn(async () => ({ input: [] })),
        compact: vi.fn(async () => {
          throw new CodexAdapterError("transport", "fixture native failure");
        }),
      };
      const reportNativeFailure = vi.fn();
      const coordinator = createCompactionCoordinator({
        low: { model: "compaction-low-test/low", thinking: "off" },
        configPath: "fixture.json",
        adapter,
        reportNativeFailure,
      });
      const hook = (pi: ExtensionAPI) => {
        pi.on("session_before_compact", (event, ctx) => {
          if (route === "already-aborted") {
            session.abortCompaction();
          }
          return coordinator.beforeCompact(event, ctx);
        });
      };
      const harness = await createManagedSessionHarness([], {
        extensionFactories: [hook],
      });
      const { session } = await harness.createSession();
      const lowStream = vi.fn(() => {
        session.abortCompaction();
        const stream = createAssistantMessageEventStream();
        stream.end(fauxAssistantMessage("", { stopReason: "aborted" }));
        return stream;
      });
      harness.modelRuntime.registerProvider("compaction-low-test", {
        api: "openai-completions",
        apiKey: "fixture-key",
        streamSimple: lowStream,
        models: [{ ...harness.model, id: "low" }],
      });
      // The native adapter is local; neither native capture nor trigger uses HTTP.
      harness.modelRuntime.registerProvider("openai-codex", {
        api: "openai-codex-responses",
        apiKey: "fixture-key",
        streamSimple: harness.faux.streamSimple,
        models: [
          { ...harness.model, id: "native", api: "openai-codex-responses" },
        ],
      });
      const resolveModel = vi.spyOn(harness.modelRuntime, "resolveModel");
      try {
        await session.bindExtensions({ mode: "json", uiContext: {} as never });
        if (route !== "instructed") {
          await session.setModel(
            harness.modelRuntime.getModel("openai-codex", "native")!,
          );
        }
        seedCompaction(session.sessionManager);
        const original = session.sessionManager.getBranch();
        await expect(
          session.compact(
            route === "instructed" ? "Keep decisions" : undefined,
          ),
        ).rejects.toThrow("Compaction cancelled");
        expect(lowStream).toHaveBeenCalledTimes(
          route === "already-aborted" ? 0 : 1,
        );
        expect(adapter.compact).toHaveBeenCalledTimes(
          route === "native-failure" ? 1 : 0,
        );
        expect(adapter.capture).toHaveBeenCalledTimes(
          route === "native-failure" ? 1 : 0,
        );
        expect(resolveModel).not.toHaveBeenCalled();
        expect(harness.faux.state.callCount).toBe(0);
        expect(session.sessionManager.getBranch()).toEqual(original);
        if (route === "native-failure") {
          expect(reportNativeFailure).toHaveBeenCalledWith(
            "transport failed",
            "cancelled",
          );
        } else {
          expect(reportNativeFailure).not.toHaveBeenCalled();
        }
      } finally {
        resolveModel.mockRestore();
        await session.extensionRunner.emit({
          type: "session_shutdown",
          reason: "quit",
        });
        session.dispose();
      }
    },
  );

  it("still runs Pi's active-model fallback after a non-cancelled low-model failure", async () => {
    const coordinator = createCompactionCoordinator({
      low: { model: "compaction-low-test/low", thinking: "off" },
      configPath: "fixture.json",
    });
    const harness = await createManagedSessionHarness(
      [fauxAssistantMessage("active-model summary")],
      {
        extensionFactories: [
          (pi) => {
            pi.on("session_before_compact", (event, ctx) =>
              coordinator.beforeCompact(event, ctx),
            );
          },
        ],
      },
    );
    const lowStream = vi.fn(() => {
      const stream = createAssistantMessageEventStream();
      stream.end(
        fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "fixture failure",
        }),
      );
      return stream;
    });
    harness.modelRuntime.registerProvider("compaction-low-test", {
      api: "openai-completions",
      apiKey: "fixture-key",
      streamSimple: lowStream,
      models: [{ ...harness.model, id: "low" }],
    });
    const { session } = await harness.createSession();
    try {
      await session.bindExtensions({ mode: "json", uiContext: {} as never });
      seedCompaction(session.sessionManager);
      await expect(session.compact("Keep decisions")).resolves.toMatchObject({
        summary: expect.stringContaining("active-model summary"),
      });
      expect(lowStream).toHaveBeenCalledOnce();
      expect(harness.faux.state.callCount).toBe(1);
    } finally {
      await session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
      session.dispose();
    }
  });
});

function seedCompaction(manager: SessionManager) {
  manager.appendMessage(user("old request ".repeat(10_000), 1));
  manager.appendMessage(fauxAssistantMessage("old response ".repeat(10_000)));
  for (let index = 0; index < 4; index++) {
    manager.appendMessage(user(`later ${index}`, 3 + index));
  }
}

describe("native boundary pruning", () => {
  it("exposes fresh output to the next provider before committing canonical pruning for future requests", async () => {
    const text = "passed test\n".repeat(200);
    const seen: string[] = [];
    const probe = (pi: ExtensionAPI) =>
      pi.registerTool({
        name: "bash",
        label: "bash",
        description: "Fixture execution",
        parameters: Type.Object({}),
        execute: async () => ({
          content: [{ type: "text" as const, text }],
          details: undefined,
        }),
      });
    const harness = await createManagedSessionHarness(
      [
        fauxAssistantMessage(fauxToolCall("bash", {}, { id: "proof" }), {
          stopReason: "toolUse",
        }),
        (request) => {
          seen.push(JSON.stringify(request.messages));
          return fauxAssistantMessage("consumed output");
        },
        (request) => {
          seen.push(JSON.stringify(request.messages));
          return fauxAssistantMessage("done");
        },
      ],
      { extensionFactories: [context, probe] },
    );
    const { session } = await harness.createSession({ cwd: MANAGED_TEST_CWD });
    try {
      await session.bindExtensions({ mode: "json", uiContext: {} as never });
      await session.prompt("run the fixture");
      const raw = session.sessionManager
        .getBranch()
        .find(
          (entry) =>
            entry.type === "message" && entry.message.role === "toolResult",
        );
      expect(raw).toMatchObject({
        message: { content: [{ type: "text", text }] },
      });
      expect(seen[0]).toContain(JSON.stringify(text).slice(1, -1));
      expect(seen[0]).not.toContain("result elided");
      expect(
        session.sessionManager
          .getBranch()
          .filter((entry) => entry.type === "context_edit"),
      ).toHaveLength(1);
      await session.prompt("continue");
      expect(seen[1]).toContain("result elided");
      expect(seen[1]).not.toContain(JSON.stringify(text).slice(1, -1));
      expect(harness.faux.state.callCount).toBe(3);
    } finally {
      await session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
      session.dispose();
    }
  });
  it("keeps canonical output intact when Pi rejects the entire boundary batch", async () => {
    const reject = (pi: ExtensionAPI) => {
      const invalid = {
        type: "context_edit" as const,
        targetId: "missing-target",
        replacement: null,
      };
      pi.on("turn_end", (event) => ({ entries: [...event.entries, invalid] }));
      pi.on("agent_before_settle", (event) => ({
        entries: [...event.entries, invalid],
      }));
    };
    const errors: string[] = [];
    const harness = await createManagedSessionHarness(
      [fauxAssistantMessage("consumed")],
      { extensionFactories: [context, reject] },
    );
    const { session } = await harness.createSession({ cwd: MANAGED_TEST_CWD });
    try {
      await session.bindExtensions({
        mode: "json",
        uiContext: {} as never,
        onError: (error) => errors.push(error.error),
      });
      const text = "successful output\n".repeat(100);
      const manager = session.sessionManager;
      manager.appendMessage({
        role: "toolResult",
        toolCallId: "source",
        toolName: "bash",
        content: [{ type: "text", text }],
        isError: false,
        timestamp: 1,
      });
      await session.prompt("consume the result");
      expect(errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Invalid boundary entries"),
        ]),
      );
      expect(
        manager.getBranch().some((entry) => entry.type === "context_edit"),
      ).toBe(false);
      expect(
        manager
          .getBranch()
          .some(
            (entry) =>
              entry.type === "custom" && entry.customType === PRUNING_TYPE,
          ),
      ).toBe(false);
      expect(manager.buildSessionProjection().messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "toolResult",
            content: [{ type: "text", text }],
          }),
        ]),
      );
      expect(harness.faux.state.callCount).toBe(1);
    } finally {
      await session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
      session.dispose();
    }
  });

  it("records terminal compaction failures outside model context", async () => {
    const harness = await createManagedSessionHarness([], {
      extensionFactories: [context],
    });
    const { session } = await harness.createSession({ cwd: MANAGED_TEST_CWD });

    try {
      await session.bindExtensions({ mode: "json", uiContext: {} as never });
      const manager = session.sessionManager;
      manager.appendMessage(user("old request ".repeat(10_000), 1));
      manager.appendMessage(
        fauxAssistantMessage("old response ".repeat(10_000)),
      );
      for (let index = 0; index < 4; index++) {
        manager.appendMessage(user(`later ${index}`, 3 + index));
      }
      session.agent.state.messages = manager.buildSessionContext().messages;

      await expect(session.compact()).rejects.toThrow();

      expect(
        manager
          .getBranch()
          .filter(
            (entry) =>
              entry.type === "custom" &&
              entry.customType === "pipkin.context.compaction-failure.v1",
          ),
      ).toEqual([
        expect.objectContaining({
          data: {
            terminal: true,
            trigger: "manual",
            aborted: false,
            willRetry: false,
            fromExtension: false,
          },
        }),
      ]);
      expect(manager.buildSessionContext().messages).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ terminal: true })]),
      );
    } finally {
      await (
        session as unknown as {
          _extensionRunner: { emit: (event: unknown) => Promise<unknown> };
        }
      )._extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
  });

  it("skips the missed cold opportunity instead of changing first exposure or forcing another request", async () => {
    const events: string[] = [];
    const harness = await createManagedSessionHarness(
      [
        fauxAssistantMessage("compaction summary"),
        () => {
          events.push("provider_request");
          return fauxAssistantMessage("done");
        },
      ],
      { extensionFactories: [context, observeOrdering(events)] },
    );
    const { session } = await harness.createSession({ cwd: MANAGED_TEST_CWD });

    try {
      await session.bindExtensions({ mode: "json", uiContext: {} as never });
      const manager = session.sessionManager;
      manager.appendMessage(user("old request ".repeat(10_000), 1));
      manager.appendMessage(
        fauxAssistantMessage("old response ".repeat(10_000)),
      );
      manager.appendMessage({
        role: "toolResult",
        toolCallId: "source",
        toolName: "bash",
        content: [{ type: "text", text: "successful output\n".repeat(2_500) }],
        isError: false,
        timestamp: 2,
      });
      for (let index = 0; index < 4; index++) {
        manager.appendMessage(user(`later ${index}`, 3 + index));
      }
      session.agent.state.messages = manager.buildSessionContext().messages;

      await session.compact();
      await session.prompt("continue");

      expect(events.slice(-3)).toEqual([
        "session_compact",
        "context:full",
        "provider_request",
      ]);
      expect(
        manager
          .getBranch()
          .filter(
            (entry) =>
              entry.type === "custom" && entry.customType === PRUNING_TYPE,
          ),
      ).toEqual([]);
      expect(
        events.filter((event) => event === "provider_request"),
      ).toHaveLength(1);
    } finally {
      await (
        session as unknown as {
          _extensionRunner: { emit: (event: unknown) => Promise<unknown> };
        }
      )._extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
  });
});
