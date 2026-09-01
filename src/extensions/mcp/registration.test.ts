import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerContainedMcpAdapter } from "./registration.ts";

function fakePi() {
  const events = createEventBus();
  const tools: Record<string, Record<string, unknown>> = {};
  const commands: string[] = [];
  const flags: string[] = [];
  return {
    pi: {
      events,
      on: (_event: string, _handler: unknown) => {},
      registerTool: (tool: Record<string, unknown>) => {
        tools[tool.name as string] = tool;
      },
      registerCommand: (name: string, _definition: unknown) =>
        commands.push(name),
      registerFlag: (name: string, _definition: unknown) => flags.push(name),
    },
    tools,
    commands,
    flags,
  };
}

describe("registerContainedMcpAdapter", () => {
  it("forwards only the contained surface and removes adapter prompt metadata", () => {
    const { pi, tools, commands, flags } = fakePi();
    const directListener = vi.fn();
    const factory = vi.fn(() => (adapterPi: typeof pi) => {
      adapterPi.events.on("adapter-runtime", directListener);
      adapterPi.on("session_shutdown", () => {});
      adapterPi.registerFlag("mcp-config", {});
      adapterPi.registerCommand("mcp", {});
      adapterPi.registerCommand("mcp-auth", {});
      adapterPi.registerCommand("pi-mcp", {});
      adapterPi.registerTool({
        name: "mcp",
        parameters: { type: "object" },
        execute: vi.fn(),
        renderResult: vi.fn(),
        promptSnippet: "adapter",
        promptGuidelines: ["adapter"],
      });
      adapterPi.registerTool({
        name: "mcpScript",
        description: "Load the mcp-scripting skill",
        parameters: { type: "object" },
        execute: vi.fn(),
        renderResult: vi.fn(),
        promptSnippet: "adapter",
        promptGuidelines: ["adapter"],
      });
      adapterPi.registerTool({ name: "mcp_direct", parameters: {} });
    });

    const registration = registerContainedMcpAdapter({
      pi: pi as never,
      options: {
        config: { mcpServers: { docs: { url: "https://mcp.test" } } },
      },
      createAdapter: factory as never,
    });

    expect(factory).toHaveBeenCalledWith({
      config: { mcpServers: { docs: { url: "https://mcp.test" } } },
    });
    expect(Object.keys(tools)).toEqual(["mcp", "mcpScript"]);
    expect(commands).toEqual(["mcp", "mcp-auth"]);
    expect(flags).toEqual([]);
    expect(tools.mcp).not.toHaveProperty("promptSnippet");
    expect(tools.mcp).not.toHaveProperty("promptGuidelines");
    expect(tools.mcpScript?.description).not.toContain("skill");
    expect(tools.mcpScript?.renderResult).toBeTypeOf("function");

    pi.events.emit("adapter-runtime", {});
    expect(directListener).toHaveBeenCalledOnce();
    registration.dispose();
    registration.dispose();
    pi.events.emit("adapter-runtime", {});
    expect(directListener).toHaveBeenCalledOnce();
  });

  it("fails when the adapter drifts from required registrations", () => {
    const { pi } = fakePi();
    expect(() =>
      registerContainedMcpAdapter({
        pi: pi as never,
        options: {
          config: { mcpServers: { docs: { url: "https://mcp.test" } } },
        },
        createAdapter: (() => (adapterPi: typeof pi) => {
          adapterPi.registerCommand("mcp", {});
          adapterPi.registerCommand("mcp-auth", {});
          adapterPi.registerTool({ name: "mcp", parameters: {} });
        }) as never,
      }),
    ).toThrow("mcpScript");
  });
});
