import {
  createCodemodeExtension,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createManagedSessionHarness } from "#test/managed-session";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";

const lowPreset = { low: { model: "ctx/default", thinking: "low" as const } };
import { SubagentRuntime } from "./runtime.js";

function makePi(activeTools = ["read", "bash", "agent_start", "edit"]) {
  return {
    getActiveTools: () => activeTools,
    sendMessage: vi.fn(),
  };
}

function makeCtx(overrides: Partial<any> = {}) {
  return {
    cwd: "/workspace",
    model: { provider: "ctx", id: "default" },
    modelRegistry: {
      find: vi.fn((provider: string, modelId: string) => ({
        provider,
        id: modelId,
      })),
    },
    ...overrides,
  };
}

function asAgentSession<T>(session: T): T & AgentSession {
  return session as T & AgentSession;
}

function makeSession(result = "done") {
  const extensionRunner = {
    hasHandlers: vi.fn(() => false),
    emit: vi.fn(async () => undefined),
  };
  return asAgentSession({
    agent: { finishTurn: undefined },
    bindExtensions: vi.fn(async () => undefined),
    prompt: vi.fn(async () => undefined),
    steer: vi.fn(async () => "queued" as const),
    clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
    abort: vi.fn(async () => undefined),
    dispose: vi.fn(),
    getLastAssistantText: vi.fn(() => result),
    setActiveToolsByName: vi.fn(),
    state: {},
    messages: [] as any[],
    sessionId: "session-id",
    sessionFile: undefined,
    subscribe: vi.fn(() => vi.fn()),
    getAllTools: vi.fn(() => []),
    extensionRunner: extensionRunner as any,
  });
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function flushPromises() {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

describe("runtime-injected explore tool", () => {
  it("uses a provider-portable schema and repository-preserving description", () => {
    const runtime = new SubagentRuntime(makePi() as never);
    const parent = runtime.queue({
      owner: "public-tool",
      type: "General",
      description: "general",
      cwd: "/workspace",
    });

    const tool = runtime.createExploreTool(parent);
    const parameters = JSON.parse(JSON.stringify(tool.parameters));
    expect(parameters.properties.breadth).toMatchObject({
      type: "string",
      enum: ["quick", "medium", "very thorough"],
      description: expect.stringContaining("exploration depth"),
    });
    expect(tool.description).toContain("repository-preserving");
    expect(tool.description).toContain("cannot spawn agents");
    expect(tool.description).not.toContain("cannot modify state");
  });

  it("injects explore only into eligible non-Explore agents", async () => {
    const pi = makePi(["read", "bash", "agent_start", "edit"]);
    const sessions = [
      makeSession("general"),
      makeSession("internal"),
      makeSession("reviewer"),
      makeSession("pipkin-implement implementer"),
      makeSession("pipkin-implement reviewer"),
      makeSession("explore"),
    ];
    const createSession = vi.fn(async () => ({ session: sessions.shift()! }));
    const runtime = new SubagentRuntime(pi as never, {
      modelPresets: lowPreset,
      createSession,
    });

    await runtime.runPublicAgent({
      type: "Review",
      prompt: "work",
      cwd: "/workspace",
      ctx: makeCtx() as never,
    });
    await runtime.runManagedAgent({
      owner: { kind: "internal", name: "pipkin:implement:implementer" },
      type: "general-purpose",
      prompt: "implement",
      cwd: "/workspace",
      ctx: makeCtx() as never,
    });
    await runtime.runManagedAgent({
      owner: { kind: "internal", name: "pipkin:implement:reviewer" },
      type: "reviewer",
      prompt: "review",
      cwd: "/workspace",
      ctx: makeCtx() as never,
    });
    await runtime.runManagedAgent({
      owner: {
        kind: "pipkin:implement",
        runId: "r1",
        role: "implementer",
        taskId: "t1",
      },
      type: "pipkin:implement:implementer",
      prompt: "implement",
      cwd: "/task-worktree",
      ctx: makeCtx() as never,
    });
    await runtime.runManagedAgent({
      owner: {
        kind: "pipkin:implement",
        runId: "r1",
        role: "reviewer",
        taskId: "t1",
      },
      type: "pipkin:implement:reviewer",
      prompt: "review",
      cwd: "/task-worktree",
      ctx: makeCtx() as never,
    });
    await runtime.runPublicAgent({
      type: "Explore",
      prompt: "inspect",
      cwd: "/workspace",
      ctx: makeCtx() as never,
    });

    expect(sessions).toHaveLength(0);
    const calls = createSession.mock.calls as any[][];
    expect(calls[0]?.[0].customTools?.map((tool: any) => tool.name)).toEqual([
      "explore",
    ]);
    expect(calls[1]?.[0].customTools?.map((tool: any) => tool.name)).toEqual([
      "explore",
    ]);
    expect(calls[2]?.[0].customTools?.map((tool: any) => tool.name)).toEqual([
      "explore",
    ]);
    expect(calls[3]?.[0].customTools?.map((tool: any) => tool.name)).toEqual([
      "explore",
    ]);
    expect(calls[4]?.[0].customTools?.map((tool: any) => tool.name)).toEqual([
      "explore",
    ]);
    expect(calls[5]?.[0].customTools).toBeUndefined();
  });

  it("normalizes explicit explore activation to eligible non-Explore agents", async () => {
    const reviewer = makeSession("reviewer");
    const explore = makeSession("explore");
    const sessions = [reviewer, explore];
    const createSession = vi.fn(async () => ({ session: sessions.shift()! }));
    const runtime = new SubagentRuntime(makePi() as never, {
      modelPresets: lowPreset,
      createSession,
    });
    const readOnlyTools = [
      "read",
      "bash",
      "grep",
      "find",
      "ls",
      "explore",
      "agent_start",
      "agent_steer",
    ];

    await runtime.runManagedAgent({
      owner: {
        kind: "pipkin:implement",
        runId: "r1",
        role: "reviewer",
        taskId: "t1",
      },
      type: "pipkin:implement:reviewer",
      prompt: "review",
      cwd: "/task-worktree",
      tools: readOnlyTools,
      ctx: makeCtx() as never,
    });
    await runtime.runPublicAgent({
      type: "Explore",
      prompt: "inspect",
      cwd: "/task-worktree",
      tools: readOnlyTools,
      ctx: makeCtx() as never,
    });

    const calls = createSession.mock.calls as any[][];
    const reviewerOptions = calls[0]?.[0];
    const exploreOptions = calls[1]?.[0];
    expect(reviewerOptions.customTools).toEqual([
      expect.objectContaining({
        name: "explore",
        exposure: "deferred",
        namespace: { name: "agents", description: expect.any(String) },
      }),
    ]);
    expect(reviewerOptions.tools).toEqual(
      expect.arrayContaining([
        "read",
        "bash",
        "explore",
        "codemode",
        "tool_search",
      ]),
    );
    expect(reviewerOptions.tools).not.toEqual(
      expect.arrayContaining(["agent_start"]),
    );
    expect(reviewer.setActiveToolsByName).toHaveBeenCalledWith(
      reviewerOptions.tools,
    );
    expect(exploreOptions.customTools).toBeUndefined();
    expect(exploreOptions.tools).toEqual(
      expect.arrayContaining(["read", "bash", "codemode", "tool_search"]),
    );
    expect(exploreOptions.tools).not.toContain("explore");
    expect(explore.setActiveToolsByName).toHaveBeenCalledWith(
      exploreOptions.tools,
    );
  });

  it("creates nested Explore metadata with inherited cwd, owner, model, thinking, and read-only tools", async () => {
    const pi = makePi([
      "read",
      "bash",
      "lsp_definition",
      "agent_start",
      "agent_wait",
      "agent_steer",
      "edit",
      "write",
      "explore",
    ]);
    const child = makeSession("nested result");
    const createSession = vi.fn(async () => ({ session: child }));
    const runtime = new SubagentRuntime(pi as never, {
      createSession,
      modelPresets: {
        low: { model: "configured/explore", thinking: "low" },
      },
    });
    const parentOwner = {
      kind: "pipkin:implement" as const,
      runId: "r1",
      role: "implementer" as const,
      taskId: "t1",
    };
    const parent = runtime.queue({
      owner: parentOwner,
      type: "pipkin:implement:implementer",
      description: "implement",
      cwd: "/task-worktree",
    });
    const result = await runtime.runExploreTool(
      parent,
      { question: "Where is runtime defined?", breadth: "quick" },
      makeCtx() as never,
    );

    expect(result.content).toEqual([{ type: "text", text: "nested result" }]);
    expect(
      Value.Check(
        runtime.createExploreTool(parent).outputSchema!,
        result.structuredContent,
      ),
    ).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      status: "completed",
      text: "nested result",
      truncated: false,
    });
    expect(result.structuredContent).not.toHaveProperty("progress");
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/task-worktree",
        model: { provider: "configured", id: "explore" },
        thinkingLevel: "low",
        tools: expect.arrayContaining([
          "read",
          "bash",
          "lsp_definition",
          "codemode",
          "tool_search",
        ]),
      }),
    );
    expect(child.setActiveToolsByName).toHaveBeenCalledWith(
      expect.arrayContaining(["read", "bash", "lsp_definition"]),
    );
    expect(child.prompt).toHaveBeenCalledWith(
      expect.stringMatching(
        /LSP operations when available[\s\S]*broad, literal, or non-semantic[\s\S]*fall back to search and reads/,
      ),
      { source: "extension", expandPromptTemplates: false },
    );
    expect(child.prompt).toHaveBeenCalledWith(
      expect.not.stringContaining("Use only read, bash, grep, find, ls"),
      { source: "extension", expandPromptTemplates: false },
    );
    expect(runtime.snapshots()).toEqual([parent]);
    expect(runtime.snapshots({ includeNested: true })).toContainEqual(
      expect.objectContaining({
        status: "completed",
        type: "Explore",
        cwd: "/task-worktree",
        model: "configured/explore",
        thinking: "low",
        owner: {
          kind: "nested",
          parentId: parent.id,
          tool: "explore",
          parentOwner,
        },
      }),
    );
  });

  it("propagates an Implement worker's caller exclusions into nested Explore", async () => {
    const parentPrompt = deferred();
    const parentSession = makeSession();
    parentSession.prompt = vi.fn(() =>
      parentPrompt.promise.then(() => undefined),
    );
    const childSession = makeSession("nested result");
    const sessions = [parentSession, childSession];
    const createSession = vi.fn(async (_options?: unknown) => ({
      session: sessions.shift()!,
    }));
    const runtime = new SubagentRuntime(
      {
        getActiveTools: () => [
          "read",
          "docs",
          "inspect_implement_run",
          "agent_start",
          "agent_wait",
          "agent_steer",
          "edit",
          "write",
        ],
      } as never,
      {
        createSession,
        modelPresets: {
          low: { model: "configured/explore", thinking: "low" },
        },
      },
    );
    const parent = await runtime.runManagedAgent({
      owner: {
        kind: "pipkin:implement",
        runId: "r1",
        role: "implementer",
      },
      type: "pipkin:implement:implementer",
      prompt: "implement",
      cwd: "/task-worktree",
      ctx: makeCtx() as never,
      mode: "background",
      excludeTools: ["inspect_implement_run"],
    });
    await vi.waitFor(() => expect(parentSession.prompt).toHaveBeenCalled());

    await runtime.runExploreTool(
      parent,
      { question: "inspect", breadth: "quick" },
      makeCtx() as never,
    );

    expect(createSession.mock.calls[1]?.[0] as unknown).toEqual(
      expect.objectContaining({
        tools: expect.arrayContaining([
          "read",
          "docs",
          "codemode",
          "tool_search",
        ]),
      }),
    );
    runtime.stop(parent.id);
    parentPrompt.resolve();
  });

  it("truncates large nested Explore output clearly", async () => {
    const pi = makePi();
    const runtime = new SubagentRuntime(pi as never, {
      modelPresets: lowPreset,
      createSession: vi.fn(async () => ({
        session: makeSession("😀\n".repeat(20_000)),
      })),
    });
    const parent = runtime.queue({
      owner: "public-tool",
      type: "General",
      description: "general",
      cwd: "/workspace",
    });

    const result = await runtime.runExploreTool(
      parent,
      { question: "map files" },
      makeCtx() as never,
    );

    const text =
      result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    expect(text).toContain("[Agent output truncated.");
    expect(result.details).toMatchObject({ truncated: true });
  });

  it.each([
    {
      label: "complete short excerpt",
      count: 1,
      text: "Found the owner.",
      truncated: false,
    },
    {
      label: "clipped assistant excerpt",
      count: 1,
      text: "é".repeat(2_000),
      truncated: true,
    },
    {
      label: "omitted eligible records",
      count: 13,
      text: "Found the owner.",
      truncated: true,
    },
    {
      label: "clipped total section",
      count: 12,
      text: "x".repeat(1_000),
      truncated: true,
    },
  ])(
    "preserves $label and truncation for direct callers and nested result data",
    async ({ count, text, truncated }) => {
      const child = makeSession();
      child.state = { errorMessage: "provider failed" } as never;
      child.messages.push(
        ...Array.from({ length: count }, () => ({
          role: "assistant",
          content: [{ type: "text", text }],
        })),
      );
      const runtime = new SubagentRuntime(makePi() as never, {
        modelPresets: lowPreset,
        createSession: vi.fn(async () => ({ session: child })),
      });
      const parent = runtime.queue({
        owner: "public-tool",
        type: "General",
        description: "general",
        cwd: "/workspace",
      });
      const tool = runtime.createExploreTool(parent);
      const result = await tool.execute(
        "call",
        { question: "map files" },
        undefined,
        undefined,
        makeCtx() as never,
      );
      expect(Value.Check(tool.outputSchema!, result.structuredContent)).toBe(
        true,
      );
      const data = result.structuredContent as {
        status: string;
        text: string;
        progress: { text: string; truncated: boolean; partial: boolean };
      };
      expect(data).toMatchObject({
        status: "failed",
        progress: { truncated, partial: true },
      });
      expect(data.text).toContain("provider failed");
      expect(data.progress.text).toContain("untrusted child-generated content");
      expect(Buffer.byteLength(data.progress.text)).toBeLessThanOrEqual(
        8 * 1024,
      );
      expect(result.content).toEqual([
        { type: "text", text: data.text },
        { type: "text", text: data.progress.text },
      ]);
      runtime.stop(parent.id);
      await runtime.dispose();
    },
  );

  it("returns failed Explore progress as schema-valid data through native codemode", async () => {
    const child = makeSession();
    child.state = { errorMessage: "provider failed" } as never;
    child.messages.push({
      role: "assistant",
      content: [{ type: "text", text: "Partial research. ".repeat(300) }],
    });
    const runtime = new SubagentRuntime(makePi() as never, {
      modelPresets: lowPreset,
      createSession: vi.fn(async () => ({ session: child })),
    });
    const parent = runtime.queue({
      owner: "public-tool",
      type: "General",
      description: "general",
      cwd: "/workspace",
    });
    const tool = runtime.createExploreTool(parent);
    const harness = await createManagedSessionHarness(
      [
        fauxAssistantMessage([
          fauxToolCall("codemode", {
            code: 'text(await tools.explore({question:"map files"}));',
          }),
        ]),
        fauxAssistantMessage("done"),
      ],
      {
        extensionFactories: [
          {
            name: "codemode",
            factory: createCodemodeExtension({ mode: "on" }),
          },
        ],
      },
    );
    runtime.setModelPresets({
      low: {
        model: `${harness.model.provider}/${harness.model.id}`,
        thinking: "low",
      },
    });
    const { session } = await harness.createSession({
      tools: ["codemode", "explore"],
      customTools: [tool],
    });
    try {
      await session.bindExtensions({ mode: "print" });
      await session.prompt("exercise nested research");
      const output = session.messages.find(
        (message) =>
          message.role === "toolResult" && message.toolName === "codemode",
      );
      expect(output).toMatchObject({ isError: false });
      if (output?.role !== "toolResult" || output.content[1]?.type !== "text") {
        throw new Error("Missing codemode text output");
      }
      const data = JSON.parse(output.content[1].text);
      expect(Value.Check(tool.outputSchema!, data)).toBe(true);
      expect(data).toMatchObject({
        ok: false,
        status: "failed",
        progress: {
          partial: true,
          truncated: true,
          text: expect.stringContaining("Partial research."),
        },
      });
      expect(data.progress.text).toContain("untrusted child-generated content");
      expect(Buffer.byteLength(data.progress.text)).toBeLessThanOrEqual(
        8 * 1024,
      );
    } finally {
      session.dispose();
      runtime.stop(parent.id);
      await runtime.dispose();
    }
  });

  it.each(["😀", "😀\n"])(
    "bounds failed nested Explore output with partial progress (%j)",
    async (errorLine) => {
      const child = makeSession();
      child.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "Partial map. ".repeat(200) }],
      });
      Object.defineProperty(child, "state", {
        value: { errorMessage: errorLine.repeat(20_000) },
      });
      const runtime = new SubagentRuntime(makePi() as never, {
        modelPresets: lowPreset,
        createSession: vi.fn(async () => ({ session: child })),
      });
      const parent = runtime.queue({
        owner: "public-tool",
        type: "General",
        description: "general",
        cwd: "/workspace",
      });

      const result = await runtime.runExploreTool(
        parent,
        { question: "map files" },
        makeCtx() as never,
      );

      const text =
        result.content[0]?.type === "text" ? result.content[0].text : "";
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
      const directText = result.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n");
      expect(Buffer.byteLength(directText)).toBeLessThanOrEqual(
        DEFAULT_MAX_BYTES,
      );
      expect(directText.split("\n").length).toBeLessThanOrEqual(
        DEFAULT_MAX_LINES,
      );
      expect(
        Value.Check(
          runtime.createExploreTool(parent).outputSchema!,
          result.structuredContent,
        ),
      ).toBe(true);
      expect(text).toContain("explore failed:");
      expect(text).toContain("[Agent output truncated.");
      expect(result.details).toMatchObject({
        status: "failed",
        truncated: true,
      });
      expect(
        Buffer.byteLength(
          (result.details as { error?: { message: string } }).error?.message ??
            "",
        ),
      ).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    },
  );

  it("propagates parent cancellation to the nested Explore child", async () => {
    const pi = makePi();
    const child = makeSession("never");
    child.messages.push({
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Located the runtime owner before cancellation.",
        },
      ],
    });
    child.prompt = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        child.abort.mockImplementation(async () => {
          resolve();
          return undefined;
        });
      });
    });
    const runtime = new SubagentRuntime(pi as never, {
      modelPresets: lowPreset,
      createSession: vi.fn(async () => ({ session: child })),
    });
    const parent = runtime.queue({
      owner: "public-tool",
      type: "General",
      description: "general",
      cwd: "/workspace",
    });
    const controller = new AbortController();

    const resultPromise = runtime.runExploreTool(
      parent,
      { question: "inspect" },
      makeCtx() as never,
      controller.signal,
    );
    await vi.waitFor(() => expect(child.prompt).toHaveBeenCalled());
    controller.abort();

    const result = await resultPromise;
    expect(child.abort).toHaveBeenCalled();
    expect(
      Value.Check(
        runtime.createExploreTool(parent).outputSchema!,
        result.structuredContent,
      ),
    ).toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: "stopped",
      progress: {
        text: expect.stringContaining(
          "Located the runtime owner before cancellation.",
        ),
        partial: true,
        truncated: false,
      },
    });
    expect(result.content).toEqual([
      {
        type: "text",
        text: expect.stringContaining("explore stopped or timed out"),
      },
      { type: "text", text: (result.structuredContent as any).progress.text },
    ]);
  });

  it("aborts nested Explore after sustained inactivity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const promptStarted = deferred();
      const child = makeSession("never");
      child.prompt = vi.fn(async () => {
        child.messages.push({
          role: "assistant",
          timestamp: Date.now(),
          content: [{ type: "text", text: "starting" }],
        });
        promptStarted.resolve();
        await new Promise<void>((resolve) => {
          child.abort.mockImplementation(async () => {
            resolve();
            return undefined;
          });
        });
      });
      const runtime = new SubagentRuntime(makePi() as never, {
        modelPresets: lowPreset,
        createSession: vi.fn(async () => ({ session: child })),
      });
      const parent = runtime.queue({
        owner: "public-tool",
        type: "General",
        description: "general",
        cwd: "/workspace",
      });

      const resultPromise = runtime.runExploreTool(
        parent,
        { question: "inspect" },
        makeCtx() as never,
      );
      await promptStarted.promise;

      await vi.advanceTimersByTimeAsync(130_000);

      await expect(resultPromise).resolves.toMatchObject({
        content: [
          expect.objectContaining({
            text: expect.stringContaining("explore stopped or timed out"),
          }),
          expect.objectContaining({
            text: expect.stringContaining("assistant: starting"),
          }),
        ],
      });
      expect(child.abort).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts nested Explore with no first activity after the baseline window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const promptStarted = deferred();
      const child = makeSession("never");
      child.prompt = vi.fn(async () => {
        promptStarted.resolve();
        await new Promise<void>((resolve) => {
          child.abort.mockImplementation(async () => {
            resolve();
            return undefined;
          });
        });
      });
      const runtime = new SubagentRuntime(makePi() as never, {
        modelPresets: lowPreset,
        createSession: vi.fn(async () => ({ session: child })),
      });
      const parent = runtime.queue({
        owner: "public-tool",
        type: "General",
        description: "general",
        cwd: "/workspace",
      });

      const resultPromise = runtime.runExploreTool(
        parent,
        { question: "inspect" },
        makeCtx() as never,
      );
      await promptStarted.promise;

      await vi.advanceTimersByTimeAsync(130_000);

      await expect(resultPromise).resolves.toMatchObject({
        content: [
          expect.objectContaining({
            text: expect.stringContaining("explore stopped or timed out"),
          }),
          expect.objectContaining({
            text: expect.stringContaining("No inspectable progress yet."),
          }),
        ],
      });
      expect(child.abort).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps active nested Explore running beyond the inactivity threshold", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const promptDone = deferred();
      const promptStarted = deferred();
      const child = makeSession("active result");
      child.prompt = vi.fn(async () => {
        promptStarted.resolve();
        await promptDone.promise;
      });
      const runtime = new SubagentRuntime(makePi() as never, {
        modelPresets: lowPreset,
        createSession: vi.fn(async () => ({ session: child })),
      });
      const parent = runtime.queue({
        owner: "public-tool",
        type: "General",
        description: "general",
        cwd: "/workspace",
      });
      let settled = false;

      const resultPromise = runtime
        .runExploreTool(parent, { question: "inspect" }, makeCtx() as never)
        .finally(() => {
          settled = true;
        });
      await promptStarted.promise;

      await vi.advanceTimersByTimeAsync(90_000);
      child.messages.push({
        role: "assistant",
        timestamp: Date.now(),
        content: [{ type: "text", text: "progress 1" }],
      });
      await vi.advanceTimersByTimeAsync(90_000);
      child.messages.push({
        role: "assistant",
        timestamp: Date.now(),
        content: [{ type: "text", text: "progress 2" }],
      });
      await vi.advanceTimersByTimeAsync(90_000);
      await flushPromises();

      expect(child.abort).not.toHaveBeenCalled();
      expect(settled).toBe(false);

      promptDone.resolve();
      await expect(resultPromise).resolves.toMatchObject({
        content: [expect.objectContaining({ text: "active result" })],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps subscription activity newer than stale message timestamps", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const promptDone = deferred();
      const promptStarted = deferred();
      const child = makeSession("active result");
      child.prompt = vi.fn(async () => {
        child.messages.push({
          role: "assistant",
          timestamp: Date.now(),
          content: [{ type: "text", text: "starting" }],
        });
        promptStarted.resolve();
        await promptDone.promise;
      });
      const runtime = new SubagentRuntime(makePi() as never, {
        modelPresets: lowPreset,
        createSession: vi.fn(async () => ({ session: child })),
      });
      const parent = runtime.queue({
        owner: "public-tool",
        type: "General",
        description: "general",
        cwd: "/workspace",
      });
      let settled = false;

      const resultPromise = runtime
        .runExploreTool(parent, { question: "inspect" }, makeCtx() as never)
        .finally(() => {
          settled = true;
        });
      await promptStarted.promise;
      const publishSessionEvent = (
        child.subscribe as unknown as {
          mock: { calls: Array<[(event: unknown) => void]> };
        }
      ).mock.calls[0]?.[0];
      if (publishSessionEvent === undefined) {
        throw new Error("session subscription was not registered");
      }

      await vi.advanceTimersByTimeAsync(90_000);
      publishSessionEvent({ toolName: "read" });
      await vi.advanceTimersByTimeAsync(50_000);
      await flushPromises();

      expect(child.abort).not.toHaveBeenCalled();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(40_000);
      publishSessionEvent({ toolName: "bash" });
      await vi.advanceTimersByTimeAsync(90_000);
      await flushPromises();

      expect(child.abort).not.toHaveBeenCalled();
      expect(settled).toBe(false);

      promptDone.resolve();
      await expect(resultPromise).resolves.toMatchObject({
        content: [expect.objectContaining({ text: "active result" })],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("prevents recursion from Explore and nested parents", async () => {
    const pi = makePi();
    const createSession = vi.fn(async () => ({ session: makeSession() }));
    const runtime = new SubagentRuntime(pi as never, {
      modelPresets: lowPreset,
      createSession,
    });
    const exploreParent = runtime.queue({
      owner: "public-tool",
      type: "Explore",
      description: "explore",
      cwd: "/workspace",
    });
    const nestedParent = runtime.queue({
      owner: { kind: "nested", parentId: exploreParent.id, tool: "explore" },
      type: "General",
      description: "nested",
      cwd: "/workspace",
    });

    await expect(
      runtime.runExploreTool(
        exploreParent,
        { question: "again" },
        makeCtx() as never,
      ),
    ).resolves.toMatchObject({
      details: {
        status: "failed",
        error: { code: "unavailable", message: "recursion prevented" },
      },
    });
    await expect(
      runtime.runExploreTool(
        nestedParent,
        { question: "again" },
        makeCtx() as never,
      ),
    ).resolves.toMatchObject({
      details: {
        status: "failed",
        error: { code: "unavailable", message: "recursion prevented" },
      },
    });
    expect(createSession).not.toHaveBeenCalled();
  });
});
