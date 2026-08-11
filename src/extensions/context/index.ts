import {
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { loadPipkinConfig, presetIssue } from "#lib/config";
import { registerBashOutcomeTool } from "./bash-outcome.ts";
import { renderEpochEntry } from "./epoch-renderer.ts";
import { EPOCH_TYPE } from "./policy.ts";
import { createCompactionCoordinator } from "./compaction.ts";
import { createPruningFlow } from "./pruning.ts";
import { registerRecallTool } from "./recall.ts";

export default function (pi: ExtensionAPI): void {
  const config = loadPipkinConfig(getAgentDir());
  const pruning = createPruningFlow(pi);
  const compaction = createCompactionCoordinator({
    low: config.config.models.low,
    lowIssue: presetIssue(config, "low")?.message,
    configPath: config.path,
    tools: () => {
      const active = new Set(pi.getActiveTools());
      return pi
        .getAllTools()
        .filter((tool) => active.has(tool.name))
        .map(({ name, description, parameters }) => ({
          name,
          description,
          parameters,
        }));
    },
  });

  pi.registerEntryRenderer(EPOCH_TYPE, renderEpochEntry);
  pi.on("session_start", (_event, ctx) => {
    compaction.sessionStart();
    pruning.sessionStart(ctx);
  });
  pi.on("session_before_compact", (event, ctx) =>
    compaction.beforeCompact(event, ctx),
  );
  pi.on("context", pruning.context);
  pi.on("before_provider_request", (event, ctx) =>
    compaction.beforeProviderRequest(event.payload, ctx),
  );
  pi.on("model_select", (event, ctx) => compaction.modelSelect(event, ctx));
  registerRecallTool(pi);
  registerBashOutcomeTool(pi);
}
