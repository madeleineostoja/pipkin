import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { registerProcessTools } from "./tools.js";
const snapshot = {
  id: "process-1",
  status: "completed",
  description: "Tests",
  command: "test",
  cwd: "/work",
  pid: 42,
  exitCode: 0,
  signal: null,
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: "2026-01-01T00:00:01.000Z",
  retainedBytes: 4,
  droppedBytes: 0,
  outputComplete: true,
};
function fixture(
  state = "completed",
  retention: unknown = { retention: "retained", outputRef: "capture" },
  waitOutcome = "terminal",
  error?: { code: string; message: string },
) {
  const tools = new Map<string, any>();
  const result = {
    snapshot: {
      ...snapshot,
      status: state,
      exitCode: state === "failed" ? 1 : 0,
    },
    output: "diagnostics",
    selector: { outputTruncated: false, requestedLines: 80, sourceLines: 1 },
    retention,
    waitOutcome,
    ...(error ? { error } : {}),
  };
  registerProcessTools(
    { registerTool: (tool: any) => tools.set(tool.name, tool) } as never,
    () =>
      ({
        assertOwned: () => {},
        result: async () => result,
        stop: async () => result,
        start: async () => result.snapshot,
        authorizedSnapshots: () => [result.snapshot],
      }) as never,
  );
  return {
    tools,
    run: (name: string, input: unknown) =>
      tools
        .get(name)
        .execute("call", input, undefined, undefined, { cwd: "/work" }),
  };
}
describe("process operation contracts", () => {
  it("distinguishes acceptance, successful status suppression, and failure diagnostics in both payloads", async () => {
    const f = fixture();
    const accepted = await f.run("process_start", {
      command: "test",
      description: "Tests",
    });
    expect(accepted.structuredContent).toMatchObject({
      ok: true,
      process: { id: "process-1" },
    });
    expect(accepted.structuredContent).not.toHaveProperty("outputRef");
    const success = await f.run("process_wait", {
      id: "process-1",
      presentation: "status",
    });
    expect(success.structuredContent.output).toBe("");
    expect(success.content[0].text).not.toContain("diagnostics");
    const failed = await fixture("failed").run("process_inspect", {
      id: "process-1",
      presentation: "status",
    });
    expect(failed.structuredContent).toMatchObject({
      ok: false,
      error: { code: "execution_failed" },
      output: "diagnostics",
    });
    expect(failed.isError).toBe(true);
    for (const [name, value] of [
      ["process_start", accepted],
      ["process_wait", success],
      ["process_inspect", failed],
    ] as const) {
      expect(
        Value.Check(f.tools.get(name).outputSchema, value.structuredContent),
      ).toBe(true);
    }
  });
  it("keeps timeout/cancellation distinct from stopping and persistence failures from execution", async () => {
    const timed = await fixture("running", undefined, "timed_out").run(
      "process_wait",
      { id: "process-1" },
    );
    expect(timed.structuredContent).toMatchObject({
      ok: true,
      waitOutcome: "timed_out",
      process: { state: "running" },
    });
    const cancelled = await fixture("running", undefined, "cancelled").run(
      "process_wait",
      { id: "process-1" },
    );
    expect(cancelled.structuredContent).toMatchObject({
      ok: false,
      error: { code: "cancelled" },
      process: { state: "running" },
    });
    const stopped = await fixture("stopped").run("process_stop", {
      id: "process-1",
    });
    expect(stopped.structuredContent.ok).toBe(false);
    const f = fixture("completed", {
      retention: "failed",
      error: { code: "persistence_failed", message: "disk unavailable" },
    });
    const result = await f.run("process_wait", {
      id: "process-1",
      presentation: "status",
    });
    expect(result.structuredContent).toMatchObject({
      ok: false,
      process: { state: "completed", exitCode: 0 },
      output: "diagnostics",
      retention: "failed",
    });
    expect(result.structuredContent).not.toHaveProperty("outputRef");
    expect(
      Value.Check(
        f.tools.get("process_wait").outputSchema,
        result.structuredContent,
      ),
    ).toBe(true);
  });
  it("returns nonterminal cleanup failure diagnostics under status presentation", async () => {
    const f = fixture("running", undefined, "snapshot", {
      code: "unavailable",
      message: "Process group did not terminate",
    });
    for (const name of ["process_inspect", "process_wait", "process_stop"]) {
      const result = await f.run(name, {
        id: "process-1",
        presentation: "status",
      });
      expect(result.structuredContent).toMatchObject({
        ok: false,
        error: { code: "unavailable" },
        process: { state: "running" },
        waitOutcome: "snapshot",
        output: "diagnostics",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("diagnostics");
      expect(
        Value.Check(f.tools.get(name).outputSchema, result.structuredContent),
      ).toBe(true);
    }
  });
  it("lists bounded public metadata and schema-bearing not-found results, with no legacy aliases", async () => {
    const f = fixture();
    expect([...f.tools.keys()]).toEqual([
      "process_start",
      "process_list",
      "process_inspect",
      "process_wait",
      "process_stop",
    ]);
    const result = await f.run("process_list", {});
    expect(result.structuredContent.processes[0]).not.toHaveProperty("command");
    expect(
      Value.Check(
        f.tools.get("process_list").outputSchema,
        result.structuredContent,
      ),
    ).toBe(true);
  });
});
