import {
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { loadPipkinConfig } from "#lib/config";
import { registerConfiguredMcpAdapter } from "./runtime.js";

export default function (pi: ExtensionAPI): void {
  const agentDir = getAgentDir();
  registerConfiguredMcpAdapter({
    pi,
    agentDir,
    config: loadPipkinConfig(agentDir).config.mcp,
  });
}
