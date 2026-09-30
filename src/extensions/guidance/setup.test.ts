import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { loadPipkinConfig, loadProjectPipkinConfig } from "#lib/config";
import { reportConfiguration } from "./setup.ts";

it("reports trusted worktree-root retirement settings from subdirectories without changing configuration", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pipkin-guidance-")));
  try {
    const worktree = join(root, "worktree");
    const cwd = join(worktree, "src");
    const agentDir = join(root, "agent");
    mkdirSync(cwd, { recursive: true });
    execFileSync("git", ["init", "-q", worktree]);
    const paths = [
      join(agentDir, "pipkin/config.json"),
      join(worktree, ".pi/pipkin/config.json"),
    ];
    const config = JSON.stringify({ mcp: {}, sandbox: { writable: [] } });
    for (const path of paths) {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, config);
    }
    const notify = vi.fn();
    const ctx = {
      cwd,
      hasUI: true,
      isProjectTrusted: () => true,
      ui: { notify },
    } as unknown as ExtensionContext;
    await reportConfiguration(ctx, agentDir);
    expect(notify.mock.calls.map(([message]) => message)).toEqual([
      expect.stringContaining("global mcp is retired"),
      expect.stringContaining("project mcp is retired"),
    ]);
    for (const [message] of notify.mock.calls) {
      expect(message).toContain("mcp.json");
      expect(message).toContain("/mcp");
      expect(message.length).toBeLessThan(1000);
    }
    notify.mockClear();
    await reportConfiguration(
      { ...ctx, isProjectTrusted: () => false },
      agentDir,
    );
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toContain("global");
    expect(loadPipkinConfig(agentDir).config.sandbox).toEqual({ writable: [] });
    expect(loadProjectPipkinConfig(worktree).config.sandbox).toEqual({
      writable: [],
    });
    expect(paths.map((path) => readFileSync(path, "utf8"))).toEqual([
      config,
      config,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
