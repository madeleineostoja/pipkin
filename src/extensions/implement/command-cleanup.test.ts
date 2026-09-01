import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const controls = vi.hoisted(() => ({
  cleanupRun: vi.fn(),
  listCheckoutRuns: vi.fn(),
  startRun: vi.fn(),
}));

vi.mock("./controls.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./controls.js")>()),
  cleanupRun: controls.cleanupRun,
  listCheckoutRuns: controls.listCheckoutRuns,
}));

vi.mock("./run.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./run.js")>()),
  startRun: controls.startRun,
}));

import { registerImplementCommand } from "./command.js";
import type { RunListing } from "./controls.js";
import { CheckoutLeaseBusyError, type RunState } from "./store.js";

const temporaryDirectories = new Set<string>();

afterEach(() => {
  vi.clearAllMocks();
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

describe("Implement cleanup command", () => {
  it("rejects retained-run cleanup immediately while a run owns the checkout", async () => {
    const root = gitCheckout();
    controls.listCheckoutRuns.mockReturnValue([
      {
        kind: "run",
        runId: "completed-run",
        state: { phase: "completed" } as RunState,
      },
    ] satisfies RunListing[]);
    controls.startRun.mockResolvedValue({
      kind: "active",
      active: {
        runId: "active-run",
        store: {
          read: () => ({ phase: "running", run: { id: "active-run" } }),
        },
      },
    });
    const { handler, notifications } = fixture(true);
    const confirm = vi.fn();
    const ctx = {
      cwd: root,
      mode: "tui",
      hasUI: true,
      isIdle: () => false,
      ui: {
        confirm,
        select: vi.fn().mockResolvedValue("Clean completed runs (1)"),
        notify: (message: string, level: string) =>
          notifications.push({ message, level }),
        setStatus: vi.fn(),
        theme: { fg: (_tone: string, text: string) => text },
      },
    };

    await handler("plan.md", ctx);
    await handler("", ctx);

    expect(confirm).not.toHaveBeenCalled();
    expect(controls.cleanupRun).not.toHaveBeenCalled();
    expect(notifications.at(-1)).toEqual({
      message:
        "Implement blocked: Run active-run currently owns the checkout. Wait for it to settle or stop it before cleaning completed run history.",
      level: "warning",
    });
  });

  it("shows a short warning status and stops a batch after shared lease contention", async () => {
    const root = gitCheckout();
    const runIds = ["run-1", "run-2", "run-3", "run-4"];
    controls.listCheckoutRuns.mockReturnValue(
      runIds.map(
        (runId): RunListing => ({
          kind: "run",
          runId,
          state: { phase: "completed" } as RunState,
        }),
      ),
    );
    controls.cleanupRun.mockRejectedValueOnce(
      new CheckoutLeaseBusyError(
        join(root, ".pi/pipkin/implement/checkout.lock"),
        10_000,
        {
          runId: "other-run",
          runPath: join(root, ".pi/pipkin/implement/runs/other-run"),
          checkoutRoot: root,
          gitDir: join(root, ".git"),
          pid: 1234,
          hostname: "test-host",
          startedAt: "2026-01-01T00:00:00.000Z",
        },
      ),
    );
    const { handler, notifications, statuses } = fixture();

    await handler("", {
      cwd: root,
      mode: "tui",
      hasUI: true,
      ui: {
        confirm: vi.fn().mockResolvedValue(true),
        select: vi.fn().mockResolvedValue("Clean completed runs (4)"),
        notify: (message: string, level: string) =>
          notifications.push({ message, level }),
        setStatus: (key: string, text: string | undefined) =>
          statuses.push({ key, text }),
        theme: {
          fg: (tone: string, text: string) => `<${tone}>${text}</${tone}>`,
        },
      },
    });

    expect(controls.cleanupRun).toHaveBeenCalledTimes(1);
    expect(statuses).toHaveLength(2);
    expect(statuses[0]).toMatchObject({
      key: "pipkin:status:0400:implement-cleanup",
    });
    expect(statuses[0]?.text).toContain("<warning>cleaning</warning>");
    expect(statuses[1]).toEqual({
      key: "pipkin:status:0400:implement-cleanup",
      text: undefined,
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ level: "warning" });
    expect(notifications[0]?.message).toContain(
      "Last recorded owner: Implement run other-run, PID 1234",
    );
    expect(notifications[0]?.message).toContain("Skipped 3 remaining runs.");
  });
});

function gitCheckout(): string {
  const root = mkdtempSync(join(tmpdir(), "pipkin-implement-cleanup-command-"));
  temporaryDirectories.add(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

function fixture(withConfig = false): {
  handler: (input: string, ctx: any) => Promise<void>;
  notifications: Array<{ message: string; level: string }>;
  statuses: Array<{ key: string; text: string | undefined }>;
} {
  let handler: ((input: string, ctx: any) => Promise<void>) | undefined;
  const notifications: Array<{ message: string; level: string }> = [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  registerImplementCommand(
    {
      on() {},
      appendEntry() {},
      registerCommand(_name: string, command: { handler: typeof handler }) {
        handler = command.handler;
      },
    } as never,
    withConfig
      ? {
          path: "/agent/pipkin/config.json",
          issues: [],
          config: {
            models: {
              utility: { model: "test/utility", thinking: "minimal" },
              low: { model: "test/low", thinking: "low" },
              medium: { model: "test/medium", thinking: "medium" },
              high: { model: "test/high", thinking: "high" },
            },
            implement: { workerConcurrency: 3 },
          },
        }
      : undefined,
  );
  return { handler: handler!, notifications, statuses };
}
