import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerUnconfiguredMcpCommand(input: {
  pi: ExtensionAPI;
  globalPath: string;
  projectPath?: string;
  projectResolutionFailed: boolean;
}): void {
  const location = input.projectPath
    ? ` Project: ${input.projectPath}.`
    : input.projectResolutionFailed
      ? " Trusted project location could not be resolved."
      : "";
  const message = `No valid MCP servers are configured. Global: ${input.globalPath}.${location} Save an mcp server map and run /reload.`;

  input.pi.registerCommand("mcp", {
    description: "Show MCP configuration recovery guidance.",
    handler: async (_args, ctx) => {
      ctx.ui.notify(message);
    },
  });
}
