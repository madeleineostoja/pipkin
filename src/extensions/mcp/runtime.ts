import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type McpAdapterOptions, createMcpAdapter } from "pi-mcp-adapter";
import type { McpConfig } from "#lib/config";
import { translateMcpConfig } from "./config.js";
import { registerContainedMcpAdapter } from "./registration.js";

type McpAdapterFactory = (
  options: McpAdapterOptions,
) => (pi: ExtensionAPI) => void;

function seedMetadataCache(agentDir: string): void {
  const cachePath = join(agentDir, "mcp-cache.json");
  if (existsSync(cachePath)) {
    return;
  }

  mkdirSync(agentDir, { recursive: true });
  try {
    // pi-mcp-adapter@2.31.0 otherwise bootstraps every server on its first run,
    // including servers explicitly configured as lazy.
    writeFileSync(cachePath, '{"version":1,"servers":{}}', { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
}

export function registerConfiguredMcpAdapter(input: {
  pi: ExtensionAPI;
  agentDir: string;
  config: McpConfig | undefined;
  createAdapter?: McpAdapterFactory;
}): void {
  const options = translateMcpConfig(input.config);
  if (!options) {
    return;
  }

  seedMetadataCache(input.agentDir);
  process.env.MCP_DIRECT_TOOLS = "__none__";
  const registration = registerContainedMcpAdapter({
    pi: input.pi,
    options,
    createAdapter: input.createAdapter ?? createMcpAdapter,
  });
  input.pi.on("session_shutdown", () => registration.dispose());
}
