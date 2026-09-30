import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertNoFailedRuns, listCheckoutRuns } from "./controls.js";
import { createLifecycleFixture } from "./lifecycle-test-support.js";
import { inspectImplementRun, listImplementRuns } from "./inspection-tool.js";
import { checkoutPaths } from "./store.js";

const temporaryDirectories = new Set<string>();

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

describe("retained run listing", () => {
  it("reports malformed retained directories as manual-only historical artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "pipkin-implement-controls-"));
    temporaryDirectories.add(root);
    const path = join(checkoutPaths(root).runs, "old-run");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "run-state.json"), "historical state");

    expect(listCheckoutRuns(root)).toEqual([
      { kind: "historical", runId: "old-run" },
    ]);
    expect(() => assertNoFailedRuns(root)).not.toThrow();
  });

  it("keeps malformed v10 artifacts historical rather than blocking discovery or admission", () => {
    const root = mkdtempSync(join(tmpdir(), "pipkin-implement-controls-"));
    temporaryDirectories.add(root);
    const directory = join(checkoutPaths(root).runs, "old-run");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "run-state.json");
    for (const value of [
      { version: 10 },
      {
        version: 10,
        phase: "planning",
        run: { id: "old-run", checkout: { root } },
      },
    ]) {
      const raw = JSON.stringify(value);
      writeFileSync(path, raw);
      expect(listCheckoutRuns(root)).toEqual([
        { kind: "historical", runId: "old-run" },
      ]);
      expect(listImplementRuns(root, {})).toEqual({
        ok: true,
        runs: [],
        truncated: false,
      });
      expect(inspectImplementRun(root, { runId: "old-run" })).toMatchObject({
        ok: false,
        error: { code: "not_found" },
      });
      expect(() => assertNoFailedRuns(root)).not.toThrow();
      expect(readFileSync(path, "utf8")).toBe(raw);
    }
  });

  it("excludes unowned active-v10 records before version diagnostics, pagination and admission", async () => {
    const f = await createLifecycleFixture();
    temporaryDirectories.add(f.root);
    const state = f.store.read();
    const path = f.store.path;
    const missing = inspectImplementRun(f.root, { runId: "missing" });
    for (const run of [
      { ...state.run, id: "other-id" },
      {
        ...state.run,
        checkout: { ...state.run.checkout, root: "/foreign-checkout" },
      },
    ]) {
      const raw = JSON.stringify({ ...state, version: 10, run });
      writeFileSync(path, raw);
      expect(inspectImplementRun(f.root, { runId: "run-1" })).toEqual(missing);
      expect(listImplementRuns(f.root, { limit: 1 })).toEqual({
        ok: true,
        runs: [],
        truncated: false,
      });
      expect(() => assertNoFailedRuns(f.root)).not.toThrow();
      expect(readFileSync(path, "utf8")).toBe(raw);
    }
  });

  it("preserves active-v10 cutover diagnostics through discovery and new-run preflight without migration", async () => {
    const f = await createLifecycleFixture();
    temporaryDirectories.add(f.root);
    const old = { ...f.store.read(), version: 10, phase: "planning" };
    const raw = JSON.stringify(old);
    writeFileSync(f.store.path, raw);
    const diagnostic =
      "Active v10 continuation/recovery is unsupported. Finish or stop the run with the old runtime before upgrading.";

    expect(listCheckoutRuns(f.root)).toEqual([
      { kind: "unsupported_active", runId: "run-1", diagnostic },
    ]);
    expect(() => assertNoFailedRuns(f.root)).toThrow(diagnostic);
    for (const result of [
      listImplementRuns(f.root, {}),
      inspectImplementRun(f.root, { runId: "run-1" }),
    ]) {
      expect(result).toMatchObject({
        ok: false,
        error: { code: "unavailable", message: diagnostic },
      });
    }
    expect(readFileSync(f.store.path, "utf8")).toBe(raw);
  });
});
