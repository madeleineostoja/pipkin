import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { showAgentsSurface } from "./agents-surface.js";
import { isImplementOwned } from "./ownership.js";
import type { RuntimeSnapshot, SubagentRuntime } from "./runtime.js";

export async function showAgentsDashboard(
  runtimeOrRuntimes: SubagentRuntime | readonly SubagentRuntime[],
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (ctx.mode === "tui" && ctx.hasUI && typeof ctx.ui.custom === "function") {
    await showAgentsSurface(runtimeOrRuntimes, ctx);
    return;
  }
  ctx.ui.notify(staticAgentsProjection(runtimeOrRuntimes), "info");
}

export function staticAgentsProjection(
  runtimeOrRuntimes: SubagentRuntime | readonly SubagentRuntime[],
): string {
  const runtimes = [
    ...new Set(
      Array.isArray(runtimeOrRuntimes)
        ? runtimeOrRuntimes
        : [runtimeOrRuntimes],
    ),
  ];
  const snapshots: RuntimeSnapshot[] = runtimes.flatMap((runtime) =>
    runtime.snapshots({ includeNested: true }),
  );
  const activeImplementAgents = snapshots.filter(
    (snapshot) => isImplementOwned(snapshot.owner) && isLive(snapshot),
  ).length;
  const publicAgents = snapshots.filter(
    (snapshot) => !isImplementOwned(snapshot.owner),
  );
  const summary =
    activeImplementAgents > 0
      ? `Implement · ${activeImplementAgents} active ${activeImplementAgents === 1 ? "agent" : "agents"}`
      : undefined;
  const roster = publicAgents
    .sort((left, right) => Number(isLive(right)) - Number(isLive(left)))
    .slice(0, 24)
    .map(
      (snapshot) =>
        `${glyph(snapshot.status)} ${displayType(snapshot)} · ${bounded(snapshot.description, 180)}`,
    );
  if (roster.length === 0) {
    return summary
      ? `${summary}\n\nNo public agents.`
      : "No current-session agents.";
  }
  return `${summary ? `${summary}\n\n` : ""}${roster.join("\n")}`.slice(
    0,
    4096,
  );
}

function isLive(snapshot: RuntimeSnapshot): boolean {
  return snapshot.status === "queued" || snapshot.status === "running";
}

function glyph(status: RuntimeSnapshot["status"]): string {
  return {
    queued: "○",
    running: "●",
    completed: "✓",
    failed: "×",
    stopped: "■",
  }[status];
}

function displayType(snapshot: RuntimeSnapshot): string {
  return bounded(snapshot.type, 80);
}

function bounded(value: string, maximum: number): string {
  return value
    .replace(/\p{C}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}
