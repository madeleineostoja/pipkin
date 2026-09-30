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
import { afterEach, describe, expect, it } from "vitest";
import {
  PapercutListSchema,
  PapercutGetSchema,
  registerInspectTools,
} from "./inspect-tool.js";
import { createPapercutStoreForCwd } from "./store.js";

const roots: string[] = [];
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "pipkin-inspect-papercuts-"));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);

function tools() {
  const definitions: any[] = [];
  registerInspectTools({
    registerTool: (value: unknown) => definitions.push(value),
  } as never);
  return definitions;
}
async function inspect(
  cwd: string,
  name: "papercut_list" | "papercut_get",
  params: unknown,
) {
  const definition = tools().find((tool) => tool.name === name);
  const result = await definition.execute("id", params, undefined, undefined, {
    cwd,
  });
  expect(Check(definition.outputSchema, result.structuredContent)).toBe(true);
  expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  expect(result.isError).toBe(!result.structuredContent.ok);
  return result;
}
const observation = {
  key: "finding",
  title: "An incidental detour",
  task: "An unrelated task",
  incident: "A detour was necessary",
  evidence: "Observed failing output",
  workarounds: ["Inspected local scripts"],
  taskOutcome: "Continued safely",
  guardrailCandidate: "Document the command",
  suggestedDestination: "docs" as const,
};

describe("papercut inspection", () => {
  it("lists an absent registry and reports a missing key without initializing data, a lease or Git exclusion", async () => {
    const root = repo();
    const store = await createPapercutStoreForCwd(root);
    const exclude = join(root, ".git", "info", "exclude");
    const before = readFileSync(exclude, "utf8");
    expect(
      (await inspect(root, "papercut_list", {})).structuredContent,
    ).toEqual({ ok: true, findings: [], offset: 0, truncated: false });
    expect(
      (await inspect(root, "papercut_get", { key: "missing" }))
        .structuredContent,
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(existsSync(store.registryPath)).toBe(false);
    expect(existsSync(join(root, ".pi", "pipkin"))).toBe(false);
    expect(readFileSync(exclude, "utf8")).toBe(before);
  });

  it("paginates newest-first open and closed summaries and retrieves full details from the primary worktree without mutation", async () => {
    const root = repo();
    const store = await createPapercutStoreForCwd(root);
    await store.record(observation);
    await store.record({
      ...observation,
      key: "another",
      title: "Another detour",
    });
    await store.close("finding");
    const file = await store.load();
    file.records[0].lastSeenAt = "2025-01-01T00:00:00.000Z";
    file.records[1].lastSeenAt = "2026-01-01T00:00:00.000Z";
    // Closed records participate in the default deduplication enumeration.
    file.records.find((record) => record.key === "another")!.status = "closed";
    file.records.find((record) => record.key === "finding")!.status = "open";
    writeFileSync(store.registryPath, JSON.stringify(file));
    const before = readFileSync(store.registryPath, "utf8");
    const worktree = join(root, "linked");
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
    execFileSync("git", ["worktree", "add", "-q", "-b", "other", worktree], {
      cwd: root,
    });

    const page = (await inspect(worktree, "papercut_list", { limit: 1 }))
      .structuredContent;
    expect(page).toMatchObject({
      findings: [{ key: "finding", status: "open" }],
      nextOffset: 1,
      truncated: false,
    });
    expect(page.findings[0]).not.toHaveProperty("incident");
    const next = (
      await inspect(worktree, "papercut_list", {
        offset: page.nextOffset,
        limit: 1,
      })
    ).structuredContent;
    expect(next.findings).toMatchObject([{ key: "another", status: "closed" }]);
    expect(next).not.toHaveProperty("nextOffset");
    expect(
      (await inspect(worktree, "papercut_list", { status: "closed" }))
        .structuredContent.findings,
    ).toMatchObject([{ key: "another" }]);
    expect(
      (await inspect(worktree, "papercut_list", { status: "open" }))
        .structuredContent.findings,
    ).toMatchObject([{ key: "finding" }]);
    const detail = await inspect(worktree, "papercut_get", { key: "finding" });
    expect(detail.structuredContent.finding).toEqual(
      file.records.find((record) => record.key === "finding"),
    );
    expect(detail.details.summary).toBe("Papercut · finding · open");
    expect(readFileSync(store.registryPath, "utf8")).toBe(before);
    expect(existsSync(join(worktree, ".pi", "pipkin"))).toBe(false);
    expect(
      (await inspect(worktree, "papercut_list", { offset: 255, limit: 25 }))
        .structuredContent.findings,
    ).toEqual([]);
  });

  it("returns meaningful structured errors for malformed arguments and corrupt data", async () => {
    const root = repo();
    for (const params of [
      { limit: 26 },
      { offset: -1 },
      { offset: 256 },
      { status: "pending" },
      { key: "finding" },
      { request: { action: "list" } },
    ]) {
      expect(Check(PapercutListSchema, params)).toBe(false);
      expect(
        (await inspect(root, "papercut_list", params)).structuredContent.error
          .code,
      ).toBe("invalid_arguments");
    }
    expect(
      Check(PapercutListSchema, { status: "all", offset: 255, limit: 25 }),
    ).toBe(true);
    for (const params of [{ key: "Upper" }, { key: "finding", limit: 1 }, {}]) {
      expect(Check(PapercutGetSchema, params)).toBe(false);
      expect(
        (await inspect(root, "papercut_get", params)).structuredContent.error
          .code,
      ).toBe("invalid_arguments");
    }
    const store = await createPapercutStoreForCwd(root);
    await store.initialize();
    writeFileSync(store.registryPath, "not json");
    for (const name of ["papercut_list", "papercut_get"] as const) {
      expect(
        (
          await inspect(
            root,
            name,
            name === "papercut_list" ? {} : { key: "finding" },
          )
        ).structuredContent,
      ).toMatchObject({
        ok: false,
        error: {
          code: "unavailable",
          message: "Papercut registry contains invalid JSON.",
        },
      });
    }
  });

  it("preserves tied-key ordering, control-safe projections and concise renderers", async () => {
    const root = repo();
    const store = await createPapercutStoreForCwd(root);
    await store.record(observation);
    await store.record({
      ...observation,
      key: "another",
      title: "first\u001b[31m second\u0000",
    });
    const file = await store.load();
    file.records.forEach((record) => {
      record.lastSeenAt = "2026-01-01T00:00:00.000Z";
    });
    writeFileSync(store.registryPath, JSON.stringify(file));
    const result = await inspect(root, "papercut_list", {});
    expect(
      result.structuredContent.findings.map((record: any) => record.key),
    ).toEqual(["another", "finding"]);
    expect(result.content[0].text).not.toContain("\\u001b");
    const definition = tools()[0];
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };
    const collapsed = definition
      .renderResult(result, { expanded: false, isPartial: false }, theme)
      .render(100)
      .join("\n");
    const expanded = definition
      .renderResult(result, { expanded: true, isPartial: false }, theme)
      .render(100)
      .join("\n");
    expect(collapsed).toContain("Papercuts · 2 findings (all)");
    expect(collapsed).not.toContain("lastSeenAt");
    expect(expanded).toContain("lastSeenAt");
    expect(
      definition
        .renderResult(
          {
            content: [{ type: "text", text: "Host validation failed" }],
            details: undefined,
            isError: true,
          },
          { expanded: false, isPartial: false },
          theme,
        )
        .render(100)
        .join("\n"),
    ).toContain("Papercut inspection failed.");
    for (const tool of tools()) {
      expect(tool.exposure).toBe("deferred");
      expect(tool.namespace.name).toBe("papercuts");
      expect(tool.description).toContain("Do not proactively inspect");
    }
  });
});
