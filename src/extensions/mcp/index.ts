import {
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { registerMcpSession } from "./runtime.js";

export default function (pi: ExtensionAPI): void {
  const agentDir = getAgentDir();
  registerMcpSession({ pi, agentDir });
}
