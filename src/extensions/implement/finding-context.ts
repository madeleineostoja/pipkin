import type { RunState } from "./store.js";

export const MAX_CARRIED_FINDING_CHARS = 48_000;

/** Obligations are never truncated: an incomplete packet cannot authorize review. */
export function openFindingObligations(
  state: RunState,
  sourceId?: string,
): RunState["findings"][string][] {
  const findings = Object.values(state.findings).filter(
    (finding) =>
      finding.status === "open" &&
      (sourceId === undefined ||
        (finding.scope.kind === "source" && finding.scope.id === sourceId)),
  );
  for (const finding of findings) {
    if (
      !state.candidates[finding.candidateId] ||
      !finding.evidence.trim() ||
      !finding.requiredChange.trim() ||
      finding.acceptanceCriteria.length === 0
    ) {
      throw new Error(`Cannot establish carried finding ${finding.id}.`);
    }
  }
  if (JSON.stringify(findings).length > MAX_CARRIED_FINDING_CHARS) {
    throw new Error(
      "Carried finding obligations exceed the complete packet bound; none may be dropped.",
    );
  }
  return findings;
}
