import { createEventBus } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
it("resolves managed leases across module realms with generation-safe replacement and revocation", async () => {
  vi.resetModules();
  const { startSandboxManagedExecution } = await import("./bash-capability.js");
  vi.resetModules();
  const { bindSandboxManagedExecutor } = await import("./bash-binding.js");
  const host = createEventBus();
  const terminal = {
    exitCode: 0,
    signal: null,
    termination: "natural" as const,
    outputComplete: true,
  };
  const lease = (pid: number) => ({
    pid,
    completion: Promise.resolve(terminal),
    stop: async () => terminal,
  });
  const first = bindSandboxManagedExecutor(host, async () => lease(1));
  const next = bindSandboxManagedExecutor(host, async () => lease(2));
  first.dispose();
  const request = {
    command: "true",
    cwd: "/tmp",
    ctx: {} as never,
    signal: undefined,
    toolCallId: "call",
    onOutput: () => {},
  };
  expect((await startSandboxManagedExecution(host, request)).pid).toBe(2);
  await expect(
    startSandboxManagedExecution(createEventBus(), request),
  ).rejects.toThrow("unavailable");
  next.dispose();
  await expect(startSandboxManagedExecution(host, request)).rejects.toThrow(
    "unavailable",
  );
});
