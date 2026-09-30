import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import {
  createLifecycleFixture,
  type LifecycleFixture,
} from "./lifecycle-test-support.js";
import { loadRunState, validateRunState } from "./store.js";
import { verificationText } from "./verification.js";
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
  it("roundtrips v11 distinctions, denies malformed evidence and legacy new writes", async () => {
    const f = await fixture();
    expect(loadRunState(f.store.path)).toEqual(f.store.read());
    expect(f.store.read().version).toBe(11);
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
        state.candidates.legacy = {
          ...state.candidates.candidate!,
          id: "legacy",
          implementationEvidence: {
            summary: "Reported",
            verification: [{ kind: "legacy", text: "tests passed" }],
          },
        };
        return state;
      }),
    ).rejects.toThrow("reader-only");
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

  it("normalizes terminal v10 in memory without rewriting or fabricating receipts, and denies continuation", async () => {
    const f = await fixture();
    const old = f.store.read() as any;
    old.version = 10;
    old.phase = "failed";
    old.failure = {
      category: "runtime",
      reason: "Stopped",
      originPhase: "running",
      at: old.updatedAt,
    };
    old.candidates.candidate.implementationEvidence.verification = [
      "npm test passed",
    ];
    const raw = JSON.stringify(old);
    writeFileSync(f.store.path, raw);
    const state = loadRunState(f.store.path);
    const evidence =
      state.candidates.candidate!.implementationEvidence!.verification;
    expect(evidence).toEqual([{ kind: "legacy", text: "npm test passed" }]);
    expect(verificationText(evidence[0]!)).toContain("no capture");
    const inspection = inspectImplementRun(f.root, { runId: "run-1" });
    expect(inspection).toMatchObject({
      ok: true,
      run: { verification: [{ kind: "legacy" }] },
    });
    expect(JSON.stringify(inspection)).not.toContain("outputRef");
    expect(readFileSync(f.store.path, "utf8")).toBe(raw);
    expect(() => loadRunState(f.store.path, true)).toThrow("Finish or stop");
    old.phase = "running";
    delete old.failure;
    writeFileSync(f.store.path, JSON.stringify(old));
    expect(() => loadRunState(f.store.path)).toThrow(
      "Active v10 continuation/recovery is unsupported",
    );
  });

  it("accepts inspection-only workers, rejects prose/legacy and leaves reviewers verification-free", () => {
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
    for (const verification of [
      [],
      ["passed"],
      [{ kind: "legacy", text: "passed" }],
    ]) {
      expect(
        Check(workstreamImplementerResultSchema, { ...base, verification }),
      ).toBe(false);
    }
    expect(Check(repositoryStateReviewSchema, { findings: [] })).toBe(true);
  });
});
