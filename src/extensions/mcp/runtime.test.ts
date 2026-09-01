import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerConfiguredMcpAdapter } from "./runtime.ts";

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

function fakePi() {
  const events = createEventBus();
  const shutdownHandlers: (() => void)[] = [];
  return {
    pi: {
      events,
      on: (event: string, handler: () => void) => {
        if (event === "session_shutdown") {
          shutdownHandlers.push(handler);
        }
      },
      registerTool: (_definition: unknown) => {},
      registerCommand: (_name: string, _definition: unknown) => {},
      registerFlag: (_name: string, _definition: unknown) => {},
    },
    shutdownHandlers,
  };
}

function registerRequiredAdapterSurface(
  pi: ReturnType<typeof fakePi>["pi"],
): void {
  pi.registerFlag("mcp-config", {});
  pi.registerCommand("mcp", {});
  pi.registerCommand("mcp-auth", {});
  pi.registerTool({ name: "mcp", parameters: {} });
  pi.registerTool({ name: "mcpScript", parameters: {} });
}

describe("registerConfiguredMcpAdapter", () => {
  it("leaves an unconfigured entrypoint inert", () => {
    const { pi } = fakePi();
    const factory = vi.fn();
    const previous = process.env.MCP_DIRECT_TOOLS;
    process.env.MCP_DIRECT_TOOLS = "ambient";

    try {
      registerConfiguredMcpAdapter({
        pi: pi as never,
        agentDir: makeAgentDir(),
        config: undefined,
        createAdapter: factory,
      });

      expect(factory).not.toHaveBeenCalled();
      expect(process.env.MCP_DIRECT_TOOLS).toBe("ambient");
    } finally {
      if (previous === undefined) {
        delete process.env.MCP_DIRECT_TOOLS;
      } else {
        process.env.MCP_DIRECT_TOOLS = previous;
      }
    }
  });

  it("sets the sentinel before constructing the adapter and prevents first-run bootstrap", () => {
    const { pi } = fakePi();
    const agentDir = makeAgentDir();
    const factory = vi.fn(() => (adapterPi: typeof pi) => {
      expect(process.env.MCP_DIRECT_TOOLS).toBe("__none__");
      registerRequiredAdapterSurface(adapterPi);
    });
    const previous = process.env.MCP_DIRECT_TOOLS;

    try {
      registerConfiguredMcpAdapter({
        pi: pi as never,
        agentDir,
        config: { inert: { url: "http://127.0.0.1:9/mcp" } },
        createAdapter: factory as never,
      });

      expect(factory).toHaveBeenCalledWith({
        config: {
          mcpServers: {
            inert: {
              url: "http://127.0.0.1:9/mcp",
              lifecycle: "lazy",
              protocolVersion: "auto",
              directTools: false,
            },
          },
          settings: {
            directTools: false,
            scriptMode: true,
            outputGuard: true,
            mcpFooterStatus: "off",
            sampling: false,
            elicitation: false,
          },
        },
      });
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
});
