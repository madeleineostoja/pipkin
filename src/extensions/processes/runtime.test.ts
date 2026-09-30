import { afterEach, describe, expect, it } from "vitest";
import {
  createEventBus,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { bindOutputScope, createOutputScope } from "#context/retained-output";
import { selectOutput } from "../context/output-selection.ts";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
const ctx = { sessionManager: SessionManager.inMemory("/tmp") } as never;
import { bindSandboxManagedExecutor } from "../sandbox/bash-binding.js";
import {
  SandboxCleanupError,
  type SandboxExecutionTerminal,
} from "../sandbox/bash-capability.js";
import { ProcessRuntime } from "./runtime.js";

type LeaseControl = {
  complete: (terminal: SandboxExecutionTerminal) => void;
  rejectCompletion: (error: Error) => void;
  stopAttempts: number;
  write: (stream: "stdout" | "stderr", data: Buffer) => void;
};

function runtime(
  options: {
    terminal?: SandboxExecutionTerminal;
    output?: Array<{ stream: "stdout" | "stderr"; data: Buffer }>;
    persistenceRoot?: string;
    failStop?: boolean;
    persistentStopFailure?: boolean;
  } = {},
) {
  const host = createEventBus();
  const scope = createOutputScope(
    options.persistenceRoot ?? join(getAgentDir(), "outputs"),
    ctx,
  );
  const unbind = bindOutputScope(host, scope);
  const controls: LeaseControl[] = [];
  const binding = bindSandboxManagedExecutor(host, async (request) => {
    let resolve: (terminal: SandboxExecutionTerminal) => void = () => undefined;
    let reject: (error: Error) => void = () => undefined;
    const completion = options.terminal
      ? Promise.resolve(options.terminal)
      : new Promise<SandboxExecutionTerminal>((settle, fail) => {
          resolve = settle;
          reject = fail;
        });
    const control = {
      complete: resolve,
      rejectCompletion: reject,
      stopAttempts: 0,
      write: (stream: "stdout" | "stderr", data: Buffer) =>
        request.onOutput({ stream, data }),
    };
    controls.push(control);
    for (const event of options.output ?? [
      { stream: "stdout" as const, data: Buffer.from("hello\n") },
    ]) {
      request.onOutput(event);
    }
    let stopFailed = false;
    return {
      pid: controls.length,
      completion,
      stop: async () => {
        control.stopAttempts += 1;
        if (
          options.persistentStopFailure ||
          (options.failStop && !stopFailed)
        ) {
          stopFailed = true;
          throw new Error("Process cleanup unavailable");
        }
        control.complete({
          exitCode: 0,
          signal: null,
          termination: "stopped",
          outputComplete: true,
        });
        return completion;
      },
    };
  });
  const owner = new ProcessRuntime(host, () => true);
  return {
    runtime: owner,
    controls,
    scope,
    binding: {
      async dispose() {
        try {
          await owner.dispose();
        } finally {
          binding.dispose();
          unbind();
          scope.release();
        }
      },
    },
  };
}

async function start(runtime: ProcessRuntime, signal?: AbortSignal) {
  return runtime.start({
    command: "echo hello",
    description: "hello",
    cwd: "/tmp",
    ctx,
    signal,
    toolCallId: "process-call",
  });
}

describe("ProcessRuntime", () => {
  it("retains immutable running snapshots and reuses full terminal evidence across observers and eviction", async () => {
    const fixture = runtime();
    bindings.push(fixture.binding);
    const accepted = await start(fixture.runtime);
    const running = await fixture.runtime.result(
      accepted.id,
      false,
      undefined,
      undefined,
    );
    if (running.retention.retention !== "retained") {
      throw new Error("snapshot persistence failed");
    }
    const original = running.retention.outputRef;
    fixture.controls[0]!.write(
      "stdout",
      Buffer.from("searchable-before-tail\n" + "later\n".repeat(100)),
    );
    fixture.controls[0]!.complete({
      exitCode: 1,
      signal: null,
      termination: "natural",
      outputComplete: true,
    });
    const terminal = await fixture.runtime.result(
      accepted.id,
      true,
      undefined,
      undefined,
    );
    const again = await fixture.runtime.result(
      accepted.id,
      true,
      undefined,
      undefined,
    );
    expect(again.retention).toEqual(terminal.retention);
    expect(fixture.scope.read(original, ctx)?.text).toBe("hello\n");
    if (terminal.retention.retention !== "retained") {
      throw new Error("terminal persistence failed");
    }
    expect(
      fixture.scope.read(terminal.retention.outputRef, ctx)?.text,
    ).toContain("searchable-before-tail");
    expect(terminal.output).not.toContain("searchable-before-tail");
    for (let i = 0; i < 32; i++) {
      const job = await start(fixture.runtime);
      fixture.controls.at(-1)!.complete({
        exitCode: 0,
        signal: null,
        termination: "natural",
        outputComplete: true,
      });
      await fixture.runtime.result(job.id, true, undefined, undefined);
    }
    expect(() => fixture.runtime.snapshot(accepted.id)).toThrow("evicted");
    expect(
      fixture.scope.read(terminal.retention.outputRef, ctx)?.execution.state,
    ).toBe("failed");
  });

  it("reports a failed stop with the latest snapshot rather than claiming terminal cleanup", async () => {
    const fixture = runtime({ failStop: true });
    bindings.push(fixture.binding);
    const job = await start(fixture.runtime);
    const stopped = await fixture.runtime.stop(job.id);
    expect(stopped).toMatchObject({
      snapshot: { status: "running" },
      waitOutcome: "snapshot",
      error: { code: "unavailable" },
      output: expect.stringContaining("hello"),
    });
    fixture.controls[0]!.complete({
      exitCode: 0,
      signal: null,
      termination: "natural",
      outputComplete: true,
    });
    expect(
      (await fixture.runtime.result(job.id, true, undefined, undefined))
        .snapshot.status,
    ).toBe("completed");
  });

  it("fails shutdown boundedly when stop rejects and completion never settles, retaining output and draining captures", async () => {
    const fixture = runtime({ persistentStopFailure: true });
    bindings.push(fixture.binding);
    const job = await start(fixture.runtime);
    fixture.scope.close();
    await expect(fixture.runtime.dispose()).rejects.toThrow(
      "cleanup unavailable during shutdown",
    );
    await fixture.scope.drain();
    const outputs = fixture.scope.list(ctx).outputs;
    expect(outputs).toHaveLength(1);
    expect(fixture.scope.read(outputs[0]!.reference, ctx)).toMatchObject({
      source: { jobId: job.id },
      execution: { state: "running", exitCode: null },
      outputComplete: false,
      text: expect.stringContaining("hello\n"),
    });
    expect(fixture.scope.read(outputs[0]!.reference, ctx)?.text).toContain(
      "cleanup unavailable",
    );
    expect(fixture.controls[0]!.stopAttempts).toBe(1);
    await expect(fixture.runtime.dispose()).resolves.toBeUndefined();
  }, 1000);

  it("keeps rejected cleanup completion nonterminal with known diagnostics and retries stop honestly", async () => {
    const fixture = runtime({ persistentStopFailure: true });
    bindings.push(fixture.binding);
    const job = await start(fixture.runtime);
    const waiting = fixture.runtime.result(job.id, true, undefined, undefined);
    fixture.controls[0]!.rejectCompletion(
      new SandboxCleanupError("Process group did not terminate", {
        exitCode: 7,
        signal: "SIGTERM",
        termination: "stopped",
        outputComplete: false,
      }),
    );
    const observed = await waiting;
    expect(observed).toMatchObject({
      snapshot: {
        status: "running",
        exitCode: 7,
        signal: "SIGTERM",
        outputComplete: false,
      },
      waitOutcome: "snapshot",
      error: { code: "unavailable" },
      output: expect.stringContaining("Process group did not terminate"),
    });
    expect(observed.snapshot).not.toHaveProperty("endedAt");
    if (observed.retention.retention !== "retained") {
      throw new Error("snapshot persistence failed");
    }
    expect(
      fixture.scope.read(observed.retention.outputRef, ctx)?.execution,
    ).toMatchObject({
      state: "running",
      exitCode: 7,
      signal: "SIGTERM",
    });
    const stopped = await fixture.runtime.stop(job.id);
    expect(stopped).toMatchObject({
      snapshot: { status: "running", exitCode: 7, signal: "SIGTERM" },
      waitOutcome: "snapshot",
      error: { code: "unavailable" },
    });
    expect(fixture.controls[0]!.stopAttempts).toBe(1);
    await expect(fixture.runtime.dispose()).rejects.toThrow(
      "cleanup unavailable during shutdown",
    );
    expect(fixture.controls[0]!.stopAttempts).toBe(2);
    await fixture.scope.drain();
  }, 1000);

  it("preserves the true terminal state and diagnostics when persistence fails", async () => {
    const root = join(getAgentDir(), "blocked-process-outputs");
    writeFileSync(root, "not a directory");
    const fixture = runtime({ persistenceRoot: root });
    bindings.push(fixture.binding);
    const job = await start(fixture.runtime);
    fixture.controls[0]!.complete({
      exitCode: 0,
      signal: null,
      termination: "natural",
      outputComplete: true,
    });
    const result = await fixture.runtime.result(
      job.id,
      true,
      undefined,
      undefined,
    );
    expect(result).toMatchObject({
      snapshot: { status: "completed", exitCode: 0 },
      output: expect.stringContaining("hello"),
      retention: { retention: "failed", error: { code: "persistence_failed" } },
    });
    expect(result.retention).not.toHaveProperty("outputRef");
  });

  it("flushes terminal output through issued reservations after Context closes admission", async () => {
    const fixture = runtime();
    bindings.push(fixture.binding);
    const job = await start(fixture.runtime);
    fixture.scope.close();
    await fixture.runtime.dispose();
    const outputs = fixture.scope.list(ctx).outputs;
    expect(outputs).toHaveLength(1);
    expect(fixture.scope.read(outputs[0]!.reference, ctx)).toMatchObject({
      source: { jobId: job.id },
      execution: { state: "stopped" },
      text: "hello\n",
    });
  });
  const bindings: { dispose: () => Promise<void> }[] = [];
  afterEach(async () => {
    for (const binding of bindings.splice(0)) {
      await binding.dispose();
    }
  });

  it("starts a stable record and maps natural completion", async () => {
    const fixture = runtime();
    bindings.push(fixture.binding);
    const snapshot = await fixture.runtime.start({
      command: "echo hello",
      description: "hello",
      cwd: "/tmp",
      ctx,
      signal: undefined,
    });
    expect(snapshot).toMatchObject({
      id: "process-1",
      status: "running",
      pid: 1,
    });

    fixture.controls[0].complete({
      exitCode: 0,
      signal: null,
      termination: "natural",
      outputComplete: true,
    });
    const result = await fixture.runtime.result(
      snapshot.id,
      true,
      undefined,
      undefined,
    );
    expect(result.snapshot.status).toBe("completed");
    expect(result.waitOutcome).toBe("terminal");
    expect(result.output).toContain("[stdout] hello");
  });

  it("stops through the lease without a direct process owner", async () => {
    const fixture = runtime();
    bindings.push(fixture.binding);
    const snapshot = await fixture.runtime.start({
      command: "sleep 1",
      description: "sleep",
      cwd: "/tmp",
      ctx,
      signal: undefined,
    });
    const result = await fixture.runtime.stop(snapshot.id);
    expect(result.snapshot.status).toBe("stopped");
  });

  it("settles a waiting caller while disposing its session", async () => {
    const fixture = runtime();
    bindings.push(fixture.binding);
    const snapshot = await fixture.runtime.start({
      command: "sleep 1",
      description: "sleep",
      cwd: "/tmp",
      ctx,
      signal: undefined,
    });
    const waiting = fixture.runtime.result(
      snapshot.id,
      true,
      undefined,
      undefined,
    );
    await fixture.runtime.dispose();
    await expect(waiting).resolves.toMatchObject({
      waitOutcome: expect.stringMatching(/terminal|cancelled/),
    });
  });

  it("times out a waiter without stopping the running process", async () => {
    const fixture = runtime();
    bindings.push(fixture.binding);
    const snapshot = await fixture.runtime.start({
      command: "sleep 1",
      description: "sleep",
      cwd: "/tmp",
      ctx,
      signal: undefined,
    });
    const result = await fixture.runtime.result(
      snapshot.id,
      true,
      0.001,
      undefined,
    );
    expect(result.waitOutcome).toBe("timed_out");
    expect(result.snapshot.status).toBe("running");
  });

  it("publishes an already-settled launch truthfully", async () => {
    const fixture = runtime({
      terminal: {
        exitCode: 1,
        signal: null,
        termination: "natural",
        outputComplete: true,
      },
    });
    bindings.push(fixture.binding);
    await expect(start(fixture.runtime)).resolves.toMatchObject({
      status: "failed",
      exitCode: 1,
    });
  });

  it("validates wait arguments before allocating a waiter", async () => {
    const fixture = runtime();
    bindings.push(fixture.binding);
    const snapshot = await start(fixture.runtime);
    await expect(
      fixture.runtime.result(snapshot.id, false, 1, undefined),
    ).rejects.toThrow("requires process_wait");
    await expect(
      fixture.runtime.result(snapshot.id, true, 0, undefined),
    ).rejects.toThrow("invalid timeoutSeconds");
    const controller = new AbortController();
    controller.abort();
    await expect(
      fixture.runtime.result(snapshot.id, true, 1, controller.signal),
    ).resolves.toMatchObject({ waitOutcome: "cancelled" });
    expect(fixture.runtime.snapshot(snapshot.id).status).toBe("running");
  });

  it("enforces waiter capacity without affecting other terminal waits", async () => {
    const fixture = runtime();
    bindings.push(fixture.binding);
    const snapshot = await start(fixture.runtime);
    const waits = Array.from({ length: 16 }, () =>
      fixture.runtime.result(snapshot.id, true, undefined, undefined),
    );
    await expect(
      fixture.runtime.result(snapshot.id, true, undefined, undefined),
    ).rejects.toThrow("maximum of 16 waiters");
    fixture.controls[0].complete({
      exitCode: 0,
      signal: null,
      termination: "natural",
      outputComplete: true,
    });
    await expect(Promise.all(waits)).resolves.toHaveLength(16);
  });

  it("keeps the full retained output available to the live inspector", async () => {
    const fixture = runtime({ output: [] });
    bindings.push(fixture.binding);
    const snapshot = await start(fixture.runtime);
    for (let line = 1; line <= 81; line += 1) {
      fixture.controls[0].write("stdout", Buffer.from(`line ${line}\n`));
    }

    const inspection = await fixture.runtime.inspectionOutput(snapshot.id);
    expect(inspection.output).toContain("[stdout] line 1");
    expect(inspection.output).toContain("[stdout] line 81");
    expect(inspection.output).not.toContain("omitted by tail selection");
  });

  it("keeps the newest contiguous display tail and preserves the full bounded source for retrieval", async () => {
    const fixture = runtime({ output: [] });
    bindings.push(fixture.binding);
    const snapshot = await start(fixture.runtime);
    for (let line = 0; line < 20; line += 1) {
      fixture.controls[0].write(
        "stdout",
        Buffer.from(`${line}:${"x".repeat(4_000)}\n`),
      );
    }
    const tail = await fixture.runtime.result(
      snapshot.id,
      false,
      undefined,
      undefined,
    );
    expect(tail.output).toContain("[stdout] 19:");
    expect(tail.output).toContain("Output projection truncated;");
    expect(tail.output).not.toContain("[stdout] 0:");

    fixture.controls[0].write("stdout", Buffer.from("x\n".repeat(600_000)));
    fixture.controls[0].write("stderr", Buffer.from("Needle\n"));
    const found = await fixture.runtime.result(
      snapshot.id,
      false,
      undefined,
      undefined,
    );
    expect(found.output).toContain("Older retained output dropped:");
    if (found.retention.retention !== "retained") {
      throw new Error("capture failed");
    }
    const retained = fixture.scope.read(found.retention.outputRef, ctx)!;
    expect(Buffer.byteLength(retained.text)).toBeLessThanOrEqual(1024 * 1024);
    expect(
      selectOutput([{ type: "text", text: retained.text }], { find: "needle" })
        .selection.totalMatches,
    ).toBe(1);
  });

  it("keeps logical lines, stream identity, and mandatory notices bounded", async () => {
    const fixture = runtime({
      output: [
        { stream: "stdout", data: Buffer.from("first") },
        { stream: "stdout", data: Buffer.from(" line\n") },
        { stream: "stderr", data: Buffer.from("second\n") },
      ],
    });
    bindings.push(fixture.binding);
    const snapshot = await start(fixture.runtime);
    fixture.controls[0].complete({
      exitCode: 0,
      signal: null,
      termination: "natural",
      outputComplete: false,
    });
    const result = await fixture.runtime.result(
      snapshot.id,
      true,
      undefined,
      undefined,
    );
    expect(result.output).toContain("[stdout] first line");
    expect(result.output).toContain("[stderr] second");
    expect(result.output).toContain("Final output may be incomplete.");
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(24 * 1024);
  });

  it("keeps same-stream continuations together across interleaved callbacks", async () => {
    const fixture = runtime({ output: [] });
    bindings.push(fixture.binding);
    const snapshot = await start(fixture.runtime);
    fixture.controls[0].write("stdout", Buffer.from("stdout "));
    fixture.controls[0].write("stderr", Buffer.from("stderr\n"));
    fixture.controls[0].write("stdout", Buffer.from("continuation\n"));
    const result = await fixture.runtime.result(
      snapshot.id,
      false,
      undefined,
      undefined,
    );
    expect(result.output).toContain("[stdout] stdout continuation");
    expect(result.output).toContain("[stderr] stderr");
    expect(result.output).not.toContain("[stdout] stdout \n");
  });

  it("isolates observation subscribers and removes them idempotently", async () => {
    const fixture = runtime();
    bindings.push(fixture.binding);
    const updates: number[] = [];
    fixture.runtime.subscribe(() => {
      throw new Error("observer failure");
    });
    const unsubscribe = fixture.runtime.subscribe((snapshots) =>
      updates.push(snapshots.length),
    );
    const snapshot = await start(fixture.runtime);
    const recordUpdates: Array<string | undefined> = [];
    const unsubscribeRecord = fixture.runtime.subscribeRecord(
      snapshot.id,
      (next) => recordUpdates.push(next?.status),
    );
    fixture.controls[0].complete({
      exitCode: 0,
      signal: null,
      termination: "natural",
      outputComplete: true,
    });
    await fixture.runtime.result(snapshot.id, true, undefined, undefined);
    expect(updates.length).toBeGreaterThan(0);
    expect(recordUpdates).toContain("completed");
    unsubscribe();
    unsubscribe();
    unsubscribeRecord();
    unsubscribeRecord();
  });
});
