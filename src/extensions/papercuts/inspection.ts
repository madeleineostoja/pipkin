import type { PapercutFile, PapercutRecord, PapercutStatus } from "./store.js";

export function sortedPapercuts(
  file: PapercutFile,
  status?: PapercutStatus,
): PapercutRecord[] {
  return file.records
    .filter((record) => status === undefined || record.status === status)
    .sort(
      (a, b) =>
        (a.status === b.status ? 0 : a.status === "open" ? -1 : 1) ||
        a.key.localeCompare(b.key),
    );
}

export function findPapercut(
  file: PapercutFile,
  key: string,
): PapercutRecord | undefined {
  return file.records.find((record) => record.key === key);
}

export function formatPapercutDetail(record: PapercutRecord): string {
  return [
    `Title: ${record.title}`,
    `Key: ${record.key}`,
    `Status: ${record.status}`,
    "",
    `Assigned task: ${record.task}`,
    "",
    `Incident: ${record.incident}`,
    "",
    `Evidence: ${record.evidence}`,
    "",
    "Exercised workarounds:",
    ...record.workarounds.map(
      (workaround, index) => `${index + 1}. ${workaround}`,
    ),
    "",
    `Task outcome: ${record.taskOutcome}`,
    ...(record.guardrailCandidate
      ? ["", `Guardrail candidate: ${record.guardrailCandidate}`]
      : []),
    ...(record.suggestedDestination
      ? [`Suggested destination: ${record.suggestedDestination}`]
      : []),
    "",
    `Occurrences: ${record.occurrences}`,
    `First seen: ${record.firstSeenAt}`,
    `Last seen: ${record.lastSeenAt}`,
  ].join("\n");
}
