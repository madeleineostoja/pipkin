import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSandboxBashRuntime } from "./bash.js";
import { waitForProcessTree } from "./process-group.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof childProcess>()),
  execFile: vi.fn(),
}));

function processTable(table: string, error: Error | null = null): void {
  vi.mocked(childProcess.execFile).mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1) as (
      error: Error | null,
      stdout: string,
      stderr: string,
    ) => void;
    callback(error, table, "");
    return {} as never;
  });
}

afterEach(() => vi.restoreAllMocks());

describe("process group cleanup", () => {
  it("settles managed stop when only unreaped zombies remain", async () => {
    const child = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, { pid: 123, stdout, stderr });
    vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === "SIGTERM") {
        child.emit("exit", null, "SIGTERM");
        stdout.destroy();
        stderr.destroy();
      }
      return true;
    });
    processTable(" 123 Z\n 456 S\n 123 Z+\n");
    const runtime = createSandboxBashRuntime({
      enabled: () => false,
      supportedMac: false,
      spawn: () => child as never,
    });
    const lease = await runtime.startManaged({
      toolCallId: "zombie-stop",
      command: "ignored",
      cwd: "/tmp",
      ctx: {
        sessionManager: {
          getSessionId: () => "session",
          getSessionFile: () => undefined,
        },
      } as never,
      signal: undefined,
      onOutput: () => undefined,
    });

    await expect(lease.stop()).resolves.toMatchObject({
      termination: "stopped",
      signal: "SIGTERM",
      outputComplete: true,
    });
    await expect(lease.completion).resolves.toMatchObject({
      termination: "stopped",
    });
    await runtime.dispose();
  });

  it("keeps waiting when a live descendant remains alongside zombies", async () => {
    vi.spyOn(process, "kill").mockReturnValue(true);
    processTable(" 123 Z\n 123 S+\n");

    await expect(waitForProcessTree(123, Date.now() + 20)).resolves.toBe(false);
  });

  it("does not claim cleanup when process inspection fails", async () => {
    vi.spyOn(process, "kill").mockReturnValue(true);
    processTable("", new Error("ps unavailable"));

    await expect(waitForProcessTree(123, Date.now() + 20)).resolves.toBe(false);
  });

  it("settles when the group disappears during inspection", async () => {
    vi.spyOn(process, "kill").mockReturnValue(true);
    processTable(" 456 S\n");

    await expect(waitForProcessTree(123, Date.now() + 100)).resolves.toBe(true);
  });
});
