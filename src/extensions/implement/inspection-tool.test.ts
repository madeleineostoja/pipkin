import {
  cpSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import { checkoutPaths } from "./store.js";
import {
  createLifecycleFixture,
  type LifecycleFixture,
} from "./lifecycle-test-support.js";
import {
  inspectImplementRun,
  listImplementRuns,
  registerImplementInspectionTool,
} from "./inspection-tool.js";
import {
  InspectResultSchema,
  ListRunsResultSchema,
} from "./inspection-schema.js";

const fixtures: LifecycleFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.dispose();
  }
});
async function fixture() {
  const value = await createLifecycleFixture();
  fixtures.push(value);
  return value;
}
function copyRun(
  root: string,
  runId: string,
  createdAt: string,
  foreign = false,
) {
  const runs = checkoutPaths(root).runs;
  cpSync(join(runs, "run-1"), join(runs, runId), { recursive: true });
  const path = join(runs, runId, "run-state.json");
  const state = JSON.parse(readFileSync(path, "utf8"));
  state.run.id = runId;
  state.executionPlan.path = join(runs, runId, "execution-plan.json");
  state.createdAt = createdAt;
  if (foreign) {
    state.run.checkout.root = "/unrelated/checkout";
  }
  writeFileSync(path, JSON.stringify(state));
}

describe("Implement read-only operations", () => {
  it("authorizes before pagination, sorts newest with stable ties, and omits unknown next offsets", async () => {
    const run = await fixture();
    copyRun(run.root, "new-b", "2099-01-01T00:00:00.000Z");
    copyRun(run.root, "new-a", "2099-01-01T00:00:00.000Z");
    copyRun(run.root, "private", "2100-01-01T00:00:00.000Z", true);
    const first = listImplementRuns(run.root, { limit: 1 });
    expect(Check(ListRunsResultSchema, first)).toBe(true);
    expect(first).toMatchObject({
      ok: true,
      runs: [{ runId: "new-a" }],
      nextOffset: 1,
      truncated: false,
    });
    expect(listImplementRuns(run.root, { offset: 1, limit: 1 })).toMatchObject({
      runs: [{ runId: "new-b" }],
      nextOffset: 2,
    });
    expect(listImplementRuns(run.root, { offset: 2 })).not.toHaveProperty(
      "nextOffset",
    );
    expect(JSON.stringify(listImplementRuns(run.root, {}))).not.toContain(
      "private",
    );
  });

  it("returns bounded projection and descriptors without state, prompts, or writes", async () => {
    const run = await fixture();
    const before = readFileSync(run.store.path, "utf8");
    const result = inspectImplementRun(run.root, { runId: "run-1" });
    expect(Check(InspectResultSchema, result)).toBe(true);
    expect(result).toMatchObject({
      ok: true,
      run: {
        runId: "run-1",
        phase: "running",
        artifacts: expect.arrayContaining([
          { kind: "state", path: run.store.path, retained: true },
        ]),
      },
    });
    expect(result).not.toHaveProperty("run.processLeases");
    expect(readFileSync(run.store.path, "utf8")).toBe(before);
  });

  it("denies missing, foreign, unsafe and symlinked targets without unrelated disclosure", async () => {
    const run = await fixture();
    copyRun(run.root, "foreign", "2099-01-01T00:00:00.000Z", true);
    symlinkSync(
      join(checkoutPaths(run.root).runs, "run-1"),
      join(checkoutPaths(run.root).runs, "linked"),
    );
    for (const runId of ["missing", "foreign", "linked"]) {
      const result = inspectImplementRun(run.root, { runId });
      expect(Check(InspectResultSchema, result)).toBe(true);
      expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
      expect(JSON.stringify(result)).not.toContain("unrelated");
    }
    expect(
      inspectImplementRun(run.root, { runId: "../foreign" }),
    ).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
  });

  it("discloses owner enumeration truncation without inventing totals", async () => {
    const run = await fixture();
    const runs = checkoutPaths(run.root).runs;
    for (let index = 0; index < 1001; index++) {
      mkdirSync(join(runs, `historical-${index}`));
    }
    const result = listImplementRuns(run.root, {});
    expect(result).toMatchObject({ ok: true, truncated: true });
    expect(result).not.toHaveProperty("nextOffset");
    expect(result).not.toHaveProperty("total");
  });

  it("registers only deferred closed typed operations and validates real results", async () => {
    const run = await fixture();
    execFileSync("git", ["init", run.root]);
    const tools: any[] = [];
    registerImplementInspectionTool({
      registerTool: (tool: unknown) => tools.push(tool),
    } as never);
    expect(tools.map((tool) => tool.name)).toEqual([
      "implement_list_runs",
      "implement_inspect",
    ]);
    for (const tool of tools) {
      expect(tool.exposure).toBe("deferred");
      expect(tool.namespace.name).toBe("implement");
      expect(tool.parameters.additionalProperties).toBe(false);
      for (const input of [
        tool.name === "implement_inspect" ? { runId: "run-1" } : {},
        tool.name === "implement_inspect"
          ? { runId: "missing" }
          : { limit: 99 },
      ]) {
        const result = await tool.execute("call", input, undefined, undefined, {
          cwd: run.root,
        });
        expect(Check(tool.outputSchema, result.structuredContent)).toBe(true);
        expect(JSON.parse(result.content[0].text)).toEqual(
          result.structuredContent,
        );
        expect(result.isError).toBe(!result.structuredContent.ok);
        const theme = {
          bold: (text: string) => text,
          fg: (_color: string, text: string) => text,
        };
        expect(
          tool
            .renderResult(
              result,
              { expanded: false, isPartial: false },
              theme,
              { isError: result.isError },
            )
            .render(200)
            .join("\n"),
        ).toContain("Implement");
      }
    }
  });
});
