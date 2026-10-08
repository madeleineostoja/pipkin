import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import {
  createLifecycleFixture,
  type LifecycleFixture,
} from "./lifecycle-test-support.js";
import { loadRunState, validateRunState } from "./store.js";
import {
  workstreamImplementerResultSchema,
  repositoryStateReviewSchema,
} from "./result-schemas.js";
import { inspectImplementRun } from "./inspection-tool.js";
import { InspectResultSchema } from "./inspection-schema.js";

const fixtures: LifecycleFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.dispose();
  }
});
async function fixture() {
  const f = await createLifecycleFixture();
  fixtures.push(f);
  await f.store.update(f.store.read().revision, (state) => {
    state.workstreams.source["first-stream"]!.baseSha = "base-sha";
    state.candidates.candidate = {
      id: "candidate",
      workstream: { kind: "source", id: "first-stream" },
      baseSha: "base-sha",
      commitSha: "candidate-sha",
      treeSha: "tree-sha",
      implementationEvidence: {
        summary: "Inspected behavior",
        verification: [
          {
            kind: "inspection",
            label: "Contract",
            evidence: "Observed the rejection path.",
          },
          {
            kind: "not_run",
            label: "Live integration",
            reason: "Credentials unavailable.",
          },
        ],
        uncertainty: "No live smoke.",
      },
    };
    return state;
  });
  return f;
}

describe("typed persisted verification", () => {
  it("roundtrips typed verification and rejects uncaptured execution and untyped evidence", async () => {
    const f = await fixture();
    expect(loadRunState(f.store.path)).toEqual(f.store.read());
    expect(f.store.read().version).toBe(12);
    const invalid = f.store.read() as any;
    invalid.candidates.candidate.implementationEvidence.verification = [
      {
        kind: "execution",
        label: "Tests",
        outputRef: "unchecked",
        claimedOutcome: "passed",
      },
    ];
    expect(() => validateRunState(invalid, f.store.path)).toThrow();
    await expect(
      f.store.update(f.store.read().revision, (state) => {
        state.candidates.candidate!.implementationEvidence!.verification = [
          "tests passed",
        ] as never;
        return state;
      }),
    ).rejects.toThrow("Run state is invalid");
    const inspection = inspectImplementRun(f.root, { runId: "run-1" });
    expect(Check(InspectResultSchema, inspection)).toBe(true);
    expect(inspection).toMatchObject({
      ok: true,
      run: {
        verification: [
          {
            kind: "inspection",
            text: expect.stringContaining("Worker-reported"),
          },
          {
            kind: "not_run",
            text: expect.stringContaining("Credentials unavailable"),
          },
        ],
      },
    });
  });

  it("rejects unsupported persisted schemas without rewriting them", async () => {
    const f = await fixture();
    const raw = JSON.stringify({ ...f.store.read(), version: 999 });
    writeFileSync(f.store.path, raw);
    expect(() => loadRunState(f.store.path)).toThrow("unsupported schema");
    expect(inspectImplementRun(f.root, { runId: "run-1" })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(readFileSync(f.store.path, "utf8")).toBe(raw);
  });

  it("accepts inspection-only workers, rejects prose and leaves reviewers verification-free", () => {
    const base = { outcome: "changed", summary: "Implemented" };
    expect(
      Check(workstreamImplementerResultSchema, {
        ...base,
        verification: [
          {
            kind: "inspection",
            label: "Contract",
            evidence: "Observed behavior",
          },
        ],
      }),
    ).toBe(true);
    for (const verification of [[], ["passed"]]) {
      expect(
        Check(workstreamImplementerResultSchema, { ...base, verification }),
      ).toBe(false);
    }
    expect(Check(repositoryStateReviewSchema, { findings: [] })).toBe(true);
  });
});
