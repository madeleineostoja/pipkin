import type {
  AgentSession,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { registerPublicAgentTools } from "./public-tools.js";
import { SubagentRuntime } from "./runtime.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
function setup() {
  const prompt = deferred(),
    cleanup = deferred();
  const child = {
    agent: {},
    bindExtensions: vi.fn(async () => {}),
    prompt: vi.fn(() => prompt.promise),
    steer: vi.fn(async () => "handled"),
    clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
    getLastAssistantText: () => "final answer",
    setActiveToolsByName: vi.fn(),
    state: {},
    messages: [],
    sessionId: "child",
    subscribe: () => () => {},
    getAllTools: () => [],
    extensionRunner: { hasHandlers: () => true, emit: vi.fn(async () => {}) },
  } as unknown as AgentSession;
  const tools = new Map<string, ToolDefinition>();
  const createSession = vi.fn(async () => ({ session: child }));
  const pi = {
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    getActiveTools: () => ["read"],
  };
  const runtime = new SubagentRuntime(pi as never, { createSession });
  registerPublicAgentTools({
    pi: pi as never,
    runtime,
    configPath: "/config",
    modelPresets: {
      low: { model: "test/model", thinking: "low" },
      high: { model: "test/model", thinking: "high" },
    },
  });
  const ctx = {
    cwd: "/workspace",
    model: { provider: "test", id: "model" },
    modelRegistry: { find: () => ({ provider: "test", id: "model" }) },
  };
  async function call(name: string, params: object, signal?: AbortSignal) {
    const tool = tools.get(name)!;
    const value = await tool.execute(
      "call",
      params,
      signal,
      undefined,
      ctx as never,
    );
    expect(Value.Check(tool.outputSchema!, value.structuredContent)).toBe(true);
    expect(value.content).toEqual([
      { type: "text", text: JSON.stringify(value.structuredContent) },
    ]);
    expect(value.isError ?? false).toBe(!(value.structuredContent as any).ok);
    return value.structuredContent as any;
  }
  return { call, tools, runtime, prompt, cleanup, child, createSession };
}

describe("public agent lifecycle", () => {
  it("bounds final text and discloses truncation instead of returning an unbounded child answer", async () => {
    const f = setup();
    f.child.getLastAssistantText = () => "😀\n".repeat(20_000);
    const {
      agent: { id },
    } = await f.call("agent_start", { type: "Explore", prompt: "map" });
    f.prompt.resolve();
    const value = await f.call("agent_wait", { id });
    expect(value.result.truncated).toBe(true);
    expect(Buffer.byteLength(value.result.text)).toBeLessThanOrEqual(
      DEFAULT_MAX_BYTES,
    );
  });
  it("recovers a lost script ID without prompts or private workers, and retrieves final output only after cleanup", async () => {
    const f = setup();
    expect([...f.tools.keys()].sort()).toEqual([
      "agent_inspect",
      "agent_list",
      "agent_start",
      "agent_steer",
      "agent_stop",
      "agent_wait",
    ]);
    await f.call("agent_start", { type: "Explore", prompt: "PRIVATE PROMPT" });
    const privateJob = f.runtime.queue({
      owner: { kind: "pipkin:implement", runId: "r", role: "implementer" },
      type: "Review",
      description: "private",
      cwd: "/workspace",
    });
    const list = await f.call("agent_list", { limit: 1 });
    expect(list.agents).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain("PRIVATE PROMPT");
    expect(JSON.stringify(list)).not.toContain(privateJob.id);
    expect(list.nextOffset).toBeUndefined();
    const id = list.agents[0].id;
    await vi.waitFor(() => expect(f.child.prompt).toHaveBeenCalled());
    f.child.extensionRunner.emit = vi.fn(() => f.cleanup.promise) as never;
    f.prompt.resolve();
    const wait = f.call("agent_wait", { id });
    await vi.waitFor(() =>
      expect(f.runtime.snapshot(id)?.status).toBe("completed"),
    );
    const immediate = await f.call("agent_inspect", { id });
    expect(immediate.agent.cleanup).toBe("pending");
    expect(immediate.result).toBeUndefined();
    f.cleanup.resolve();
    expect(await wait).toMatchObject({
      ok: true,
      waitOutcome: "terminal",
      result: { text: "final answer", truncated: false },
      agent: { cleanup: "complete" },
    });
    expect(await f.call("agent_wait", { id })).toMatchObject({
      result: { text: "final answer" },
    });
    expect(f.createSession).toHaveBeenCalledTimes(1);
    for (const name of [
      "agent_inspect",
      "agent_wait",
      "agent_stop",
      "agent_steer",
    ]) {
      expect(
        await f.call(name, { id: privateJob.id, message: "guess" }),
      ).toMatchObject({ ok: false, error: { code: "not_found" } });
    }
    f.runtime.stop(privateJob.id);
    await f.runtime.dispose();
  });

  it("timeout and cancellation only cancel waiters; actual steering delivery is preserved", async () => {
    const f = setup();
    const started = await f.call("agent_start", {
      type: "Review",
      prompt: "review",
    });
    const id = started.agent.id;
    await vi.waitFor(() => expect(f.child.prompt).toHaveBeenCalled());
    expect(await f.call("agent_steer", { id, message: "focus" })).toMatchObject(
      { delivery: "handled" },
    );
    expect(
      await f.call("agent_wait", { id, timeoutSeconds: 0.001 }),
    ).toMatchObject({
      ok: true,
      waitOutcome: "timed_out",
      agent: { state: "running" },
    });
    const controller = new AbortController();
    const waiting = f.call("agent_wait", { id }, controller.signal);
    controller.abort();
    expect(await waiting).toMatchObject({
      ok: false,
      waitOutcome: "cancelled",
      agent: { state: "running" },
    });
    expect(f.child.abort).not.toHaveBeenCalled();
    f.prompt.resolve();
    expect(await f.call("agent_wait", { id })).toMatchObject({
      ok: true,
      result: { text: "final answer" },
    });
  });

  it("reports still-stopping when a stop caller aborts, then joins real cleanup", async () => {
    const f = setup();
    const {
      agent: { id },
    } = await f.call("agent_start", { type: "Explore", prompt: "inspect" });
    await vi.waitFor(() => expect(f.child.prompt).toHaveBeenCalled());
    f.child.extensionRunner.emit = vi.fn(() => f.cleanup.promise) as never;
    const controller = new AbortController();
    const stop = f.call("agent_stop", { id }, controller.signal);
    controller.abort();
    expect(await stop).toMatchObject({
      ok: false,
      waitOutcome: "cancelled",
      agent: { state: "stopping", cleanup: "pending" },
    });
    f.prompt.resolve();
    f.cleanup.resolve();
    expect(await f.call("agent_wait", { id })).toMatchObject({
      ok: false,
      waitOutcome: "terminal",
      error: { code: "stopped" },
      agent: { state: "stopped", cleanup: "complete" },
    });
    expect(f.child.dispose).toHaveBeenCalledTimes(1);
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
    "discloses $label truncation in immediate and failed terminal progress",
    async ({ count, text, truncated }) => {
      const f = setup();
      const {
        agent: { id },
      } = await f.call("agent_start", {
        type: "Explore",
        prompt: "PRIVATE PROMPT",
      });
      await vi.waitFor(() => expect(f.child.prompt).toHaveBeenCalled());
      f.child.messages.push(
        ...Array.from(
          { length: count },
          () =>
            ({
              role: "assistant",
              content: [{ type: "text", text }],
            }) as AgentSession["messages"][number],
        ),
      );
      const live = await f.call("agent_inspect", { id, includeProgress: true });
      expect(live.progress).toMatchObject({ partial: true, truncated });
      expect(Buffer.byteLength(live.progress.text)).toBeLessThanOrEqual(
        8 * 1024,
      );
      expect(live.progress.text).not.toContain("PRIVATE PROMPT");
      f.runtime.fail(id, "provider failed");
      f.prompt.resolve();
      const failed = await f.call("agent_wait", { id, includeProgress: true });
      expect(failed).toMatchObject({
        ok: false,
        error: { code: "agent_failed" },
        progress: live.progress,
      });
      expect(failed.result).toBeUndefined();
      await f.runtime.dispose();
    },
  );

  it("rejects invalid wait deadlines and list pagination", async () => {
    const f = setup();
    const { id } = f.runtime.queue({
      owner: "public-tool",
      type: "Explore",
      description: "queued research",
      cwd: "/workspace",
    });
    expect(
      await f.call("agent_wait", { id, timeoutSeconds: -1 }),
    ).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
    expect(await f.call("agent_list", { offset: -1 })).toMatchObject({
      ok: false,
      error: { code: "invalid_arguments" },
    });
    f.runtime.stop(id);
    await f.runtime.dispose();
  });
});
