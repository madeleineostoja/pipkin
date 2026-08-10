import { describe, expect, it } from "vitest";
import {
  AssessmentCoverageError,
  assertAssessmentCoverage,
  assessmentCoverage,
} from "./assessment-coverage.js";

describe("anchored assessment coverage", () => {
  it("accepts every expected assessment exactly once in any order", () => {
    expect(() =>
      assertAssessmentCoverage(
        ["finding-1", "finding-2"],
        [{ id: "finding-2" }, { id: "finding-1" }],
      ),
    ).not.toThrow();
    expect(() => assertAssessmentCoverage([], [])).not.toThrow();
  });

  it("reports missing, foreign, and duplicate assessment IDs", () => {
    const coverage = assessmentCoverage(
      ["finding-1", "finding-2"],
      [{ id: "finding-1" }, { id: "finding-1" }, { id: "historical" }],
    );

    expect(coverage).toMatchObject({
      missingIds: ["finding-2"],
      unexpectedIds: ["historical"],
      duplicateAssessmentIds: ["finding-1"],
      duplicateExpectedIds: [],
    });
    expect(() =>
      assertAssessmentCoverage(
        ["finding-1", "finding-2"],
        [{ id: "finding-1" }, { id: "finding-1" }, { id: "historical" }],
      ),
    ).toThrow(AssessmentCoverageError);
  });

  it("identifies duplicate expected IDs as an orchestrator invariant defect", () => {
    const coverage = assessmentCoverage(
      ["finding-1", "finding-1"],
      [{ id: "finding-1" }],
    );

    expect(coverage.duplicateExpectedIds).toEqual(["finding-1"]);
    expect(() =>
      assertAssessmentCoverage(
        ["finding-1", "finding-1"],
        [{ id: "finding-1" }],
      ),
    ).toThrow(AssessmentCoverageError);
  });
});
