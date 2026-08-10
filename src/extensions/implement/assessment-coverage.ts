type Assessment = { id: string };

export type AssessmentCoverage = {
  expectedIds: string[];
  receivedIds: string[];
  missingIds: string[];
  unexpectedIds: string[];
  duplicateAssessmentIds: string[];
  duplicateExpectedIds: string[];
};

export class AssessmentCoverageError extends Error {
  constructor(readonly coverage: AssessmentCoverage) {
    super("Anchored review must assess each outstanding finding exactly once.");
  }
}

export function assessmentCoverage(
  expectedIds: readonly string[],
  assessments: readonly Assessment[],
): AssessmentCoverage {
  const expected = [...expectedIds];
  const received = assessments.map((assessment) => assessment.id);
  const expectedCounts = counts(expected);
  const receivedCounts = counts(received);
  const expectedSet = new Set(expected);
  const receivedSet = new Set(received);

  return {
    expectedIds: expected,
    receivedIds: received,
    missingIds: unique(expected).filter((id) => !receivedSet.has(id)),
    unexpectedIds: unique(received).filter((id) => !expectedSet.has(id)),
    duplicateAssessmentIds: duplicateIds(received, receivedCounts),
    duplicateExpectedIds: duplicateIds(expected, expectedCounts),
  };
}

export function assertAssessmentCoverage(
  expectedIds: readonly string[],
  assessments: readonly Assessment[],
): void {
  const coverage = assessmentCoverage(expectedIds, assessments);
  if (
    coverage.missingIds.length > 0 ||
    coverage.unexpectedIds.length > 0 ||
    coverage.duplicateAssessmentIds.length > 0 ||
    coverage.duplicateExpectedIds.length > 0
  ) {
    throw new AssessmentCoverageError(coverage);
  }
}

export function formatAssessmentCoverage(coverage: AssessmentCoverage): string {
  return [
    `Expected IDs: ${formatIds(coverage.expectedIds)}`,
    `Received IDs: ${formatIds(coverage.receivedIds)}`,
    `Missing IDs: ${formatIds(coverage.missingIds)}`,
    `Unexpected IDs: ${formatIds(coverage.unexpectedIds)}`,
    `Duplicate assessment IDs: ${formatIds(coverage.duplicateAssessmentIds)}`,
    `Duplicate expected IDs: ${formatIds(coverage.duplicateExpectedIds)}`,
  ].join("\n");
}

function counts(ids: readonly string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const id of ids) {
    result.set(id, (result.get(id) ?? 0) + 1);
  }
  return result;
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function duplicateIds(
  ids: readonly string[],
  idCounts: ReadonlyMap<string, number>,
): string[] {
  return unique(ids).filter((id) => (idCounts.get(id) ?? 0) > 1);
}

function formatIds(ids: readonly string[]): string {
  return ids.length > 0 ? ids.join(", ") : "none";
}
