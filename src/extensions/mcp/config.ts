import type { McpAdapterOptions, ServerEntry } from "pi-mcp-adapter";
import type { McpConfig } from "#lib/config";

export function translateMcpConfig(
  config: McpConfig | undefined,
): McpAdapterOptions | undefined {
  if (!config || Object.keys(config.servers).length === 0) {
    return undefined;
  }

  const mcpServers: Record<string, ServerEntry> = {};
  for (const [name, server] of Object.entries(config.servers)) {
    mcpServers[name] = {
      url: server.url,
      lifecycle: "lazy",
      protocolVersion: "auto",
      directTools: false,
    };
  }

  return {
    config: {
      mcpServers,
      settings: {
        directTools: false,
        scriptMode: true,
        outputGuard: true,
        mcpFooterStatus: "off",
        sampling: false,
        elicitation: false,
      },
    },
  };
}
