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
  "agent_start",
  "agent_list",
  "agent_inspect",
  "agent_wait",
  "agent_steer",
  "agent_stop",
]);
const activeGatedTools = new Set([
  "bash",
  "process_start",
  "process_list",
  "process_inspect",
  "process_wait",
  "process_stop",
  "output_list",
  "read_output",
  "lsp_definition",
  "lsp_type_definition",
  "lsp_implementation",
  "lsp_references",
  "lsp_hover",
  "lsp_document_symbols",
  "lsp_workspace_symbols",
  "lsp_diagnostics",
  "lsp_status",
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
    excluded.add("papercut_record");
  }
  if (input.completion) {
    excluded.delete("pi_managed_complete");
  }

  const active = (name: string) =>
    candidates.includes(name) &&
    !excluded.has(name) &&
    // Documentation is separately admitted from validated native metadata.
    !name.startsWith("mcp__") &&
    ![
      "list_mcp_resources",
      "list_mcp_resource_templates",
      "read_mcp_resource",
    ].includes(name) &&
    // These companion tools and LSP depend on parent registration. Other
    // explicit tool overrides intentionally retain their established behavior.
    (!activeGatedTools.has(name) ||
      parentActiveTools?.includes(name) !== false);
  const bashActive = active("bash");
  const selected = candidates.filter(
    (name) => active(name) && (name !== "process_start" || bashActive),
  );
  if (input.allowExplore && !excluded.has("explore")) {
    selected.push("explore");
  }
  if (input.completion) {
    selected.push("pi_managed_complete");
  }
  return unique(selected);
}
