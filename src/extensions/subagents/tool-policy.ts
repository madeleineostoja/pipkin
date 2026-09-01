export type ToolAccessIntent = "inherit" | "repository-read-only";

export type ResolveChildToolNamesInput = {
  parentActiveTools?: readonly string[];
  tools?: readonly string[];
  callerExcludedTools?: readonly string[];
  access: ToolAccessIntent;
  allowExplore: boolean;
  allowPapercut: boolean;
  completion?: boolean;
};

const publicAgentTools = new Set([
  "Agent",
  "get_subagent_result",
  "steer_subagent",
]);
const activeGatedTools = new Set([
  "bash",
  "start_process",
  "get_process_result",
  "stop_process",
  "bash_outcome",
  "context_recall",
  "lsp",
]);

function unique(names: readonly string[]): string[] {
  return [...new Set(names)];
}

export function resolveChildToolNames(
  input: ResolveChildToolNamesInput,
): string[] {
  const parentActiveTools = input.parentActiveTools;
  const candidates = unique(input.tools ?? parentActiveTools ?? []);
  const excluded = new Set(input.callerExcludedTools);

  for (const name of publicAgentTools) {
    excluded.add(name);
  }
  if (input.access === "repository-read-only") {
    excluded.add("edit");
    excluded.add("write");
  }
  if (!input.allowExplore) {
    excluded.add("explore");
  }
  if (!input.allowPapercut) {
    excluded.add("record_papercut");
  }
  if (input.completion) {
    excluded.delete("pi_managed_complete");
  }

  const active = (name: string) =>
    candidates.includes(name) &&
    !excluded.has(name) &&
    // These companion tools and LSP depend on parent registration. Other
    // explicit tool overrides intentionally retain their established behavior.
    (!activeGatedTools.has(name) ||
      parentActiveTools?.includes(name) !== false);
  const bashActive = active("bash");
  const recallActive = bashActive && active("context_recall");

  const selected = candidates.filter(
    (name) =>
      active(name) &&
      (name !== "start_process" || bashActive) &&
      (name !== "context_recall" || recallActive) &&
      (name !== "bash_outcome" || recallActive),
  );
  if (input.allowExplore && !excluded.has("explore")) {
    selected.push("explore");
  }
  if (input.completion) {
    selected.push("pi_managed_complete");
  }
  return unique(selected);
}
