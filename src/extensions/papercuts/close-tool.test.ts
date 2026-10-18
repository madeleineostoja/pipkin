import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Check } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCloseTool } from "./close-tool.js";
import { createPapercutStatusController } from "./status.js";
import { createPapercutStoreForCwd } from "./store.js";

const roots: string[] = [];
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "pipkin-close-papercut-"));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);

function tool() {
  let definition: any;
  registerCloseTool(
    { registerTool: (value: unknown) => (definition = value) } as never,
    createPapercutStatusController(),
  );
  return definition;
}
async function close(definition: any, cwd: string, params: unknown, ui = {}) {
  const result = await definition.execute("id", params, undefined, undefined, {
    cwd,
    mode: "json",
    ui,
  });
  expect(Check(definition.outputSchema, result.structuredContent)).toBe(true);
  expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  expect(result.isError).toBe(!result.structuredContent.ok);
  return result;
}
const observation = {
  key: "finding",
  title: "Incidental friction",
  task: "An unrelated task",
  incident: "Needed a detour",
  evidence: "Observed the output",
  workarounds: ["Inspected scripts"],
  taskOutcome: "Continued safely",
};

describe("papercut_close", () => {
  it("rejects invalid arguments before accessing storage and returns not_found without creating a finding", async () => {
    const root = repo();
    const definition = tool();
    for (const params of [
      {},
      { key: "Upper" },
      { key: "finding", status: "closed" },
    ]) {
      expect(
        (await close(definition, root, params)).structuredContent,
      ).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
    }
    expect(existsSync(join(root, ".pi", "pipkin"))).toBe(false);
    expect(
      (await close(definition, root, { key: "missing" })).structuredContent,
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    const store = await createPapercutStoreForCwd(root);
    expect(existsSync(store.registryPath)).toBe(false);
    expect((await store.load()).records).toEqual([]);
  });

  it("closes through a linked worktree, preserving history and other findings, refreshing status and allowing recurrence", async () => {
    const root = repo();
    const store = await createPapercutStoreForCwd(root);
    await store.record(observation);
    await store.record({ ...observation, key: "still-open" });
    const before = await store.load();
    execFileSync(
      "git",
      [
        "-c",
        "user.email=test@example.com",
        "-c",
        "user.name=Test",
        "commit",
        "--allow-empty",
        "-qm",
        "init",
      ],
      { cwd: root },
    );
    const linked = join(root, "linked");
    execFileSync("git", ["worktree", "add", "-q", "-b", "other", linked], {
      cwd: root,
    });
    const definition = tool();
    const setStatus = vi.fn();
    const result = await definition.execute(
      "id",
      { key: "finding" },
      undefined,
      undefined,
      {
        cwd: linked,
        mode: "tui",
        ui: { setStatus, theme: { fg: (_tone: string, text: string) => text } },
      },
    );
    expect(Check(definition.outputSchema, result.structuredContent)).toBe(true);
    expect(result.structuredContent).toEqual({
      ok: true,
      key: "finding",
      title: observation.title,
      status: "closed",
      occurrences: 1,
    });
    expect(setStatus).toHaveBeenLastCalledWith(
      "pipkin:status:0300:papercuts",
      "󰶯 1 papercuts",
    );
    expect((await store.load()).records).toEqual(
      before.records.map((record) =>
        record.key === "finding" ? { ...record, status: "closed" } : record,
      ),
    );
    const closed = readFileSync(store.registryPath, "utf8");
    expect(
      (await close(definition, linked, { key: "finding" })).structuredContent,
    ).toEqual(result.structuredContent);
    expect(readFileSync(store.registryPath, "utf8")).toBe(closed);
    expect(existsSync(join(linked, ".pi", "pipkin"))).toBe(false);
    expect(await store.record(observation)).toMatchObject({
      kind: "reopened",
      record: { occurrences: 2, status: "open" },
    });
  });

  it("reports persistence failures without overwriting corrupt data or claiming closure", async () => {
    const root = repo();
    const store = await createPapercutStoreForCwd(root);
    await store.initialize();
    writeFileSync(store.registryPath, "not json");
    expect(
      (await close(tool(), root, { key: "finding" })).structuredContent,
    ).toMatchObject({
      ok: false,
      error: {
        code: "persistence_failed",
        message: "Papercut registry contains invalid JSON.",
      },
    });
    expect(readFileSync(store.registryPath, "utf8")).toBe("not json");
  });
});
