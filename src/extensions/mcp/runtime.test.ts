import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigSnapshot, ProjectConfigSnapshot } from "#lib/config";
import { projectAdapterName } from "./servers.ts";
import { registerMcpSession } from "./runtime.ts";

const agentDirs: string[] = [];

afterEach(() => {
  for (const agentDir of agentDirs.splice(0)) {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

function makeAgentDir(): string {
  const agentDir = mkdtempSync(join(tmpdir(), "pipkin-mcp-"));
  agentDirs.push(agentDir);
  return agentDir;
}

function global(mcp?: ConfigSnapshot["config"]["mcp"]): ConfigSnapshot {
  return {
    path: "/agent/pipkin/config.json",
    config: {
      models: {},
      implement: { workerConcurrency: 3 },
      ...(mcp ? { mcp } : {}),
    },
    issues: [],
  };
}

function project(
  mcp?: ProjectConfigSnapshot["config"]["mcp"],
): ProjectConfigSnapshot {
  return {
    path: "/repo/.pi/pipkin/config.json",
    config: { sandbox: { writable: [] }, ...(mcp ? { mcp } : {}) },
    issues: [],
  };
}

function fakePi() {
  const events = createEventBus();
  const handlers = new Map<
    string,
    ((event: unknown, ctx: unknown) => unknown)[]
  >();
  const commands = new Map<
    string,
    { handler: (args: string, ctx: unknown) => Promise<void> }
  >();
  const tools: string[] = [];
  return {
    pi: {
      events,
      on: (
        event: string,
        handler: (event: unknown, ctx: unknown) => unknown,
      ) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      registerTool: (definition: { name: string }) =>
        tools.push(definition.name),
      registerCommand: (
        name: string,
        definition: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) => commands.set(name, definition),
      registerFlag: (_name: string, _definition: unknown) => {},
    },
    handlers,
    commands,
    tools,
  };
}

async function emitStart(
  fixture: ReturnType<typeof fakePi>,
  trusted = true,
): Promise<void> {
  return emitStartAt(fixture, "/repo/nested", trusted);
}

async function emitStartAt(
  fixture: ReturnType<typeof fakePi>,
  cwd: string,
  trusted = true,
  reason: "startup" | "reload" = "startup",
): Promise<void> {
  for (const handler of fixture.handlers.get("session_start") ?? []) {
    await handler(
      { type: "session_start", reason },
      { cwd, isProjectTrusted: () => trusted },
    );
  }
}

function registerRequiredAdapterSurface(
  pi: ReturnType<typeof fakePi>["pi"],
): void {
  pi.registerFlag("mcp-config", {});
  pi.registerCommand("mcp", {} as never);
  pi.registerCommand("mcp-auth", {} as never);
  pi.registerTool({ name: "mcp" });
  pi.registerTool({ name: "mcpScript" });
}

describe("registerMcpSession", () => {
  it("keeps unconfigured sessions adapter-free and provides recovery guidance", async () => {
    const fixture = fakePi();
    const factory = vi.fn();
    const previous = process.env.MCP_DIRECT_TOOLS;
    process.env.MCP_DIRECT_TOOLS = "ambient";
    try {
      registerMcpSession({
        pi: fixture.pi as never,
        agentDir: makeAgentDir(),
        loadGlobal: () => global(),
        createAdapter: factory,
      });
      expect(factory).not.toHaveBeenCalled();
      await emitStart(fixture, false);

      expect(factory).not.toHaveBeenCalled();
      expect(fixture.tools).toEqual([]);
      expect([...fixture.commands.keys()]).toEqual(["mcp"]);
      expect(process.env.MCP_DIRECT_TOOLS).toBe("ambient");
      const notifications: string[] = [];
      await fixture.commands.get("mcp")!.handler("", {
        ui: { notify: (message: string) => notifications.push(message) },
      });
      expect(notifications[0]).toContain("No valid MCP servers are configured");
      expect(notifications[0]).toContain("/agent/pipkin/config.json");
      expect(notifications[0]).not.toContain("Project:");
      expect(notifications[0]).not.toContain(
        "project location could not be resolved",
      );
      expect(notifications[0]).toContain("/reload");
    } finally {
      if (previous === undefined) {
        delete process.env.MCP_DIRECT_TOOLS;
      } else {
        process.env.MCP_DIRECT_TOOLS = previous;
      }
    }
  });

  it("merges trusted project servers at startup and explicitly starts the adapter", async () => {
    const fixture = fakePi();
    const root = "/repo";
    const factory = vi.fn(
      () => (adapterPi: ReturnType<typeof fakePi>["pi"]) => {
        adapterPi.on("session_start", () => started());
        registerRequiredAdapterSurface(adapterPi);
      },
    );
    const started = vi.fn();
    const loadProject = vi.fn(() =>
      project({
        docs: {
          url: "https://project.test",
          oauth: { clientName: "Project Client" },
        },
      }),
    );
    const agentDir = makeAgentDir();
    const previous = process.env.MCP_DIRECT_TOOLS;
    try {
      registerMcpSession({
        pi: fixture.pi as never,
        agentDir,
        loadGlobal: () =>
          global({
            docs: { url: "https://global.test" },
            shared: { url: "https://shared.test" },
          }),
        loadProject,
        resolveProjectRoot: () => root,
        createAdapter: factory as never,
      });
      expect(factory).not.toHaveBeenCalled();
      await emitStart(fixture);

      expect(loadProject).toHaveBeenCalledWith(root);
      expect(factory).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            mcpServers: expect.objectContaining({
              [projectAdapterName(root, "docs")]: expect.objectContaining({
                url: "https://project.test",
                oauth: { clientName: "Project Client" },
              }),
              shared: expect.objectContaining({ url: "https://shared.test" }),
            }),
          }),
        }),
      );
      expect(started).toHaveBeenCalledOnce();
      expect(process.env.MCP_DIRECT_TOOLS).toBe("__none__");
      expect(existsSync(join(agentDir, "mcp-cache.json"))).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.MCP_DIRECT_TOOLS;
      } else {
        process.env.MCP_DIRECT_TOOLS = previous;
      }
    }
  });

  it("keeps global servers when project loading or resolution fails", async () => {
    for (const resolveProjectRoot of [
      () => "/repo",
      () => undefined,
    ] as const) {
      const fixture = fakePi();
      const factory = vi.fn(
        () => (adapterPi: ReturnType<typeof fakePi>["pi"]) =>
          registerRequiredAdapterSurface(adapterPi),
      );
      const loadProject = vi.fn(() => {
        throw new Error("unreadable project config");
      });
      registerMcpSession({
        pi: fixture.pi as never,
        agentDir: makeAgentDir(),
        loadGlobal: () => global({ docs: { url: "https://global.test" } }),
        loadProject,
        resolveProjectRoot,
        createAdapter: factory as never,
      });

      await emitStart(fixture);
      expect(factory).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            mcpServers: expect.objectContaining({
              docs: expect.objectContaining({ url: "https://global.test" }),
            }),
          }),
        }),
      );
      if (resolveProjectRoot()) {
        expect(loadProject).toHaveBeenCalledOnce();
      } else {
        expect(loadProject).not.toHaveBeenCalled();
      }
    }
  });

  it("keeps the fallback available when project loading fails without globals", async () => {
    const fixture = fakePi();
    const factory = vi.fn();
    registerMcpSession({
      pi: fixture.pi as never,
      agentDir: makeAgentDir(),
      loadGlobal: () => global(),
      loadProject: () => {
        throw new Error("unreadable project config");
      },
      resolveProjectRoot: () => "/repo",
      createAdapter: factory,
    });

    await emitStart(fixture);
    expect(factory).not.toHaveBeenCalled();
    const notifications: string[] = [];
    await fixture.commands.get("mcp")!.handler("", {
      ui: { notify: (message: string) => notifications.push(message) },
    });
    expect(notifications[0]).toContain("/repo/.pi/pipkin/config.json");
  });

  it("reports trusted project paths only when resolution succeeds", async () => {
    for (const [root, expected] of [
      ["/repo", "/repo/.pi/pipkin/config.json"],
      [undefined, "Trusted project location could not be resolved"],
    ] as const) {
      const fixture = fakePi();
      registerMcpSession({
        pi: fixture.pi as never,
        agentDir: makeAgentDir(),
        loadGlobal: () => global(),
        loadProject: () => project(),
        resolveProjectRoot: () => root,
      });
      await emitStart(fixture);
      const notifications: string[] = [];
      await fixture.commands.get("mcp")!.handler("", {
        ui: { notify: (message: string) => notifications.push(message) },
      });
      expect(notifications[0]).toContain(expected);
    }
  });

  it("does not resolve, load, or advertise project configuration for untrusted sessions", async () => {
    const fixture = fakePi();
    const loadProject = vi.fn(() => project());
    const resolveProjectRoot = vi.fn(() => "/repo");
    registerMcpSession({
      pi: fixture.pi as never,
      agentDir: makeAgentDir(),
      loadGlobal: () => global(),
      loadProject,
      resolveProjectRoot,
    });
    await emitStart(fixture, false);

    expect(resolveProjectRoot).not.toHaveBeenCalled();
    expect(loadProject).not.toHaveBeenCalled();
    const notifications: string[] = [];
    await fixture.commands.get("mcp")!.handler("", {
      ui: { notify: (message: string) => notifications.push(message) },
    });
    expect(notifications[0]).not.toContain("Project:");
    expect(notifications[0]).not.toContain(
      "project location could not be resolved",
    );
  });

  it("reconstructs the adapter snapshot on reload", async () => {
    const fixture = fakePi();
    let url = "https://first.test";
    const started = vi.fn();
    const factory = vi.fn(
      () => (adapterPi: ReturnType<typeof fakePi>["pi"]) => {
        adapterPi.on("session_start", started);
        registerRequiredAdapterSurface(adapterPi);
      },
    );
    registerMcpSession({
      pi: fixture.pi as never,
      agentDir: makeAgentDir(),
      loadGlobal: () => global({ docs: { url } }),
      createAdapter: factory as never,
    });

    await emitStartAt(fixture, "/first", false);
    url = "https://replacement.test";
    await emitStartAt(fixture, "/replacement", false, "reload");

    expect(factory).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        config: expect.objectContaining({
          mcpServers: expect.objectContaining({
            docs: expect.objectContaining({ url: "https://first.test" }),
          }),
        }),
      }),
    );
    expect(factory).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        config: expect.objectContaining({
          mcpServers: expect.objectContaining({
            docs: expect.objectContaining({ url: "https://replacement.test" }),
          }),
        }),
      }),
    );
    expect(started).toHaveBeenCalledTimes(2);
  });
});
