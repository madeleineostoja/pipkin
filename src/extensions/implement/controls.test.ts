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
