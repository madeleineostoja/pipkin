import {
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { loadPipkinConfig, presetIssue } from "#lib/config";
import { join } from "node:path";
import {
  createOutputScope,
  inheritedOutputScope,
  bindOutputScope,
  type OutputScope,
} from "./retained-output.ts";
import {
  COMPACTION_FAILURE_ENTRY_TYPE,
  renderCompactionFailureEntry,
} from "./compaction-failure-renderer.ts";
import { renderPruningMilestone } from "./pruning-renderer.ts";
import { PRUNING_TYPE } from "./policy.ts";
import { createCompactionCoordinator } from "./compaction.ts";
import { createPruningFlow } from "./pruning.ts";
import { registerOutputTools } from "./recall.ts";

export default function (pi: ExtensionAPI): void {
  const config = loadPipkinConfig(getAgentDir());
  const pruning = createPruningFlow();
  let scope: OutputScope | undefined;
  let unbind: (() => void) | undefined;
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
    reportNativeFailure: (reason, outcome) => {
      pi.appendEntry(COMPACTION_FAILURE_ENTRY_TYPE, { reason, outcome });
    },
  });

  pi.registerEntryRenderer(PRUNING_TYPE, renderPruningMilestone);
  pi.registerEntryRenderer(
    COMPACTION_FAILURE_ENTRY_TYPE,
    renderCompactionFailureEntry,
  );
  pi.on("session_start", (_event, ctx) => {
    unbind?.();
    scope?.close();
    scope?.release();
    scope =
      inheritedOutputScope(pi.events, ctx) ??
      createOutputScope(join(getAgentDir(), "pipkin", "outputs"), ctx);
    unbind = bindOutputScope(pi.events, scope);
    compaction.sessionStart();
    pruning.sessionStart(ctx);
  });
  pi.on("session_before_compact", (event, ctx) =>
    compaction.beforeCompact(event, ctx),
  );
  pi.on("session_compact_failed", (event) => {
    pi.appendEntry(COMPACTION_FAILURE_ENTRY_TYPE, {
      terminal: true,
      trigger: event.reason,
      aborted: event.aborted,
      willRetry: event.willRetry,
      fromExtension: event.fromExtension,
    });
  });
  pi.on("turn_end", pruning.boundary);
  pi.on("agent_before_settle", pruning.boundary);
  pi.on("before_provider_request", (event, ctx) => {
    pruning.requestStart(ctx);
    return compaction.beforeProviderRequest(event.payload, ctx);
  });
  pi.on("model_select", (event, ctx) => compaction.modelSelect(event, ctx));
  pi.on("session_shutdown", () => {
    unbind?.();
    unbind = undefined;
    // Later producer shutdown handlers still own issued capture handles.
    scope?.close();
    scope?.release();
    scope = undefined;
  });
  registerOutputTools(pi);
}
