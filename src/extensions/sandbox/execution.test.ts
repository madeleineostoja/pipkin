import {
  createEventBus,
  SessionManager,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { writeFileSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { createOutputScope, bindOutputScope } from "#context/retained-output";
import { createRetainedBashDefinition } from "./execution.ts";
import { createSandboxBashRuntime } from "./bash.ts";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});
function fixture(broken = false) {
  const host = createEventBus();
  const sessionManager = SessionManager.inMemory(process.cwd());
  sessionManager.appendMessage({
    role: "user",
    content: "run",
    timestamp: Date.now(),
  });
  const ctx = { cwd: process.cwd(), sessionManager } as never;
  const root = join(getAgentDir(), broken ? "blocked" : "outputs");
  if (broken) {
    writeFileSync(root, "not a directory");
  }
  const scope = createOutputScope(root, ctx);
  const off = bindOutputScope(host, scope);
  const runtime = createSandboxBashRuntime({ enabled: () => false });
  const tool = createRetainedBashDefinition(host, process.cwd(), runtime);
  cleanups.push(async () => {
    await runtime.dispose();
    off();
    scope.release();
  });
  return {
    tool,
    scope,
    ctx,
    run: (
      command: string,
      presentation?: "status",
      timeout?: number,
      signal?: AbortSignal,
    ) =>
      tool.execute(
        "call",
        { command, presentation, timeout },
        signal,
        undefined,
        ctx,
      ),
  };
}
describe("retained Bash", () => {
  it("executes once, retains independently, and suppresses successful status logs in both payloads", async () => {
    const f = fixture();
    const counter = join(getAgentDir(), "bash-once");
    const updates: unknown[] = [];
    const result = await f.tool.execute(
      "call",
      {
        command: `printf x >> ${JSON.stringify(counter)}; printf evidence`,
        presentation: "status",
      },
      undefined,
      (update) => updates.push(update),
      f.ctx,
    );
    expect(updates).toEqual([]);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      execution: { state: "completed", exitCode: 0 },
      output: "",
      retention: "retained",
    });
    expect(result.content[0].text).not.toContain("evidence");
    expect(Value.Check(f.tool.outputSchema, result.structuredContent)).toBe(
      true,
    );
    if (result.structuredContent.retention !== "retained") {
      throw new Error("capture failed");
    }
    const ref = result.structuredContent.outputRef;
    expect(f.scope.read(ref, f.ctx)?.text).toBe("evidence");
    expect(readFileSync(counter, "utf8")).toBe("x");
    expect(f.scope.list(f.ctx).count).toBe(1);
    const visible = await f.tool.execute(
      "output",
      { command: "printf streamed" },
      undefined,
      (update) => updates.push(update),
      f.ctx,
    );
    expect(visible.structuredContent).toMatchObject({
      ok: true,
      output: "streamed",
    });
    expect(updates).not.toHaveLength(0);
    const failure = await f.run("printf diagnostic; exit 7", "status");
    expect(failure.structuredContent).toMatchObject({
      ok: false,
      execution: { state: "failed", exitCode: 7 },
      output: "diagnostic",
    });
    expect(failure.isError).toBe(true);
    const signalled = await f.run("printf signal; kill -TERM $$", "status");
    expect(signalled.structuredContent).toMatchObject({
      ok: false,
      execution: { state: "failed", exitCode: null, signal: "SIGTERM" },
      output: "signal",
    });
    expect(Value.Check(f.tool.outputSchema, failure.structuredContent)).toBe(
      true,
    );
  });
  it("retains timeout/cancellation diagnostics and rejects invalid commands before dispatch", async () => {
    const f = fixture();
    const timed = await f.run("printf before; sleep 10", "status", 0.02);
    expect(timed.structuredContent).toMatchObject({
      ok: false,
      execution: { state: "timed_out" },
      output: "before",
      retention: "retained",
    });
    const controller = new AbortController();
    const cancelled = f.run(
      "printf cancel; sleep 10",
      "status",
      undefined,
      controller.signal,
    );
    setTimeout(() => controller.abort(), 30);
    expect((await cancelled).structuredContent).toMatchObject({
      ok: false,
      execution: { state: "cancelled" },
      output: "cancel",
      retention: "retained",
    });
    await expect(f.run("printf never", undefined, 0)).rejects.toThrow(
      "Invalid",
    );
    expect(f.scope.list(f.ctx).count).toBe(2);
  });
  it("reports persistence failure without losing true command status or diagnostics", async () => {
    const f = fixture(true);
    const result = await f.run("printf available", "status");
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "persistence_failed" },
      execution: { state: "completed", exitCode: 0 },
      output: "available",
      retention: "failed",
    });
    expect(result.structuredContent).not.toHaveProperty("outputRef");
    expect(Value.Check(f.tool.outputSchema, result.structuredContent)).toBe(
      true,
    );
  });
});
