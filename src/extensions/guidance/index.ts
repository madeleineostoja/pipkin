import {
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { loadPipkinConfig, loadProjectPipkinConfig } from "#lib/config";
import { reportRetiredConfiguration, reportSetupWarning } from "./setup.ts";
import { DISCOVERY_SETUP, EXTERNAL_AUTHORITY, STRATEGY } from "./strategy.ts";

export default function (pi: ExtensionAPI): void {
  let checkedDiscovery = false;
  pi.on("session_start", (_event, ctx) => {
    checkedDiscovery = false;
    reportRetiredConfiguration(ctx, [
      loadPipkinConfig(getAgentDir()),
      ...(ctx.isProjectTrusted() ? [loadProjectPipkinConfig(ctx.cwd)] : []),
    ]);
  });
  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections.pipkin_strategy = STRATEGY;
    event.systemPromptOptions.sections.external_content_authority =
      EXTERNAL_AUTHORITY;
  });
  pi.on("turn_start", (_event, ctx) => {
    if (checkedDiscovery) {
      return;
    }
    checkedDiscovery = true;
    const active = pi.getActiveTools();
    if (!active.includes("codemode") && !active.includes("tool_search")) {
      reportSetupWarning(ctx, DISCOVERY_SETUP);
    }
  });
}
