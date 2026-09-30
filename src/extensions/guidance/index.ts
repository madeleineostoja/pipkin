import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { reportSetupWarning } from "./setup.ts";
import { DISCOVERY_SETUP, EXTERNAL_AUTHORITY, STRATEGY } from "./strategy.ts";

export default function (pi: ExtensionAPI): void {
  let checkedDiscovery = false;
  pi.on("session_start", () => {
    checkedDiscovery = false;
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
