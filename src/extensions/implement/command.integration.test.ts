import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerImplementCommand } from "./command.js";
import { createLifecycleFixture } from "./lifecycle-test-support.js";
import { checkoutPaths } from "./store.js";
import { createEventBus } from "@earendil-works/pi-coding-agent";

const config = {
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
} as const;

const temporaryDirectories = new Set<string>();

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

describe("/implement command Git boundary", () => {
  it("blocks new runs and human inspection/cleanup of active v10 with the old-runtime instruction", async () => {
    const f = await createLifecycleFixture();
    temporaryDirectories.add(f.root);
    writeFileSync(join(f.root, ".gitignore"), ".pi/\n");
    execFileSync("git", ["init"], { cwd: f.root });
    execFileSync("git", ["add", "plan.md", ".gitignore"], { cwd: f.root });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-m",
        "test: plan",
      ],
      { cwd: f.root },
    );
    const state = f.store.read();
    const raw = JSON.stringify({
      ...state,
      version: 10,
      phase: "planning",
      run: {
        ...state.run,
        checkout: { ...state.run.checkout, root: realpathSync(f.root) },
      },
    });
    writeFileSync(f.store.path, raw);
    let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
    const pi = {
      events: createEventBus(),
      on() {},
      registerCommand(_name: string, command: { handler: typeof handler }) {
        handler = command.handler;
      },
    };
    registerImplementCommand(pi as never, config);
    const notifications: string[] = [];
    const selections = ["run-1 · unsupported active v10", "Close"];
    const ctx = {
      cwd: f.root,
      mode: "print",
      hasUI: true,
      ui: {
        notify: (message: string) => notifications.push(message),
        select: async () => selections.shift(),
      },
    };
    for (const input of [
      "status",
      "inspect run-1",
      "cleanup run-1",
      "",
      "plan.md",
    ]) {
      const before = notifications.length;
      await handler!(input, { ...ctx, mode: input === "" ? "tui" : "print" });
      expect(notifications.slice(before).join("\n")).toContain(
        "Finish or stop the run with the old runtime before upgrading.",
      );
      expect(notifications.slice(before).join("\n")).not.toContain("manual");
      expect(readFileSync(f.store.path, "utf8")).toBe(raw);
    }
    expect(readdirSync(checkoutPaths(f.root).runs)).toEqual(["run-1"]);
  });

  it("opens one run-oriented menu for an empty command", async () => {
    let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
    const pi = {
      on() {},
      registerCommand(_name: string, command: { handler: typeof handler }) {
        handler = command.handler;
      },
    };
    registerImplementCommand(pi as never, config);
    const root = mkdtempSync(join(tmpdir(), "pipkin-implement-menu-"));
    temporaryDirectories.add(root);
    const plan = join(root, "plan.md");
    writeFileSync(plan, "# Plan\n\n- [x] Finished\n");
    execFileSync("git", ["init"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: root,
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["add", "plan.md"], { cwd: root });
    execFileSync("git", ["commit", "-m", "test"], { cwd: root });
    const selections = ["New run"];
    const menus: string[][] = [];
    const notifications: string[] = [];

    await handler!("", {
      cwd: root,
      hasUI: true,
      mode: "tui",
      ui: {
        input: async () => "plan.md",
        notify: (message: string) => notifications.push(message),
        select: async (_title: string, options: string[]) => {
          menus.push(options);
          return selections.shift();
        },
        setWidget() {},
      },
    });

    expect(menus).toEqual([["New run", "Close"]]);
    expect(menus.flat().every((item) => !item.includes("..."))).toBe(true);
    expect(notifications).toEqual([
      "All plan tasks are already checked; no run was created.",
    ]);
  });
});
