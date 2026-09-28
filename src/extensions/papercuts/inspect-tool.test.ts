import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Check } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { InspectPapercutsSchema, registerInspectTool } from "./inspect-tool.js";
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

function tool() {
  let definition: any;
  registerInspectTool({
    registerTool: (value: unknown) => (definition = value),
  } as never);
  return definition;
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

async function inspect(cwd: string, request: unknown) {
  return tool().execute("id", { request }, undefined, undefined, { cwd });
}

describe("inspect_papercuts", () => {
  it("lists an absent registry without initializing or writing anything", async () => {
    const root = repo();
    const store = await createPapercutStoreForCwd(root);
    const result = await inspect(root, { action: "list" });
    expect(result.content[0].text).toContain(
      "Papercuts: 0 all findings; showing 0",
    );
    expect(existsSync(store.registryPath)).toBe(false);
    expect(existsSync(join(root, ".pi", "pipkin", "papercuts.lock"))).toBe(
      false,
    );
  });

  it("lists open and closed findings in bounded pages and retrieves full detail from a linked worktree", async () => {
    const root = repo();
    const store = await createPapercutStoreForCwd(root);
    await store.record(observation);
    await store.record({
      ...observation,
      key: "another",
      title: "Another detour",
    });
    await store.close("finding");
    const worktree = mkdtempSync(join(tmpdir(), "pipkin-inspect-worktree-"));
    roots.push(worktree);
    rmSync(worktree, { recursive: true });
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

    const page = await inspect(worktree, {
      action: "list",
      status: "all",
      offset: 1,
      limit: 1,
    });
    expect(page.content[0].text).toContain(
      "2 all findings; showing 1 from offset 1",
    );
    expect(page.content[0].text).toContain(
      "finding · An incidental detour · closed · 1 occurrence · last seen",
    );
    expect(page.content[0].text).not.toContain("another ·");
    const closed = await inspect(worktree, {
      action: "list",
      status: "closed",
    });
    expect(closed.content[0].text).toContain("finding ·");
    expect(closed.content[0].text).not.toContain("another ·");
    const detail = await inspect(worktree, { action: "get", key: "finding" });
    for (const text of [
      "Status: closed",
      "Assigned task: An unrelated task",
      "Incident: A detour was necessary",
      "Evidence: Observed failing output",
      "1. Inspected local scripts",
      "Task outcome: Continued safely",
      "Guardrail candidate: Document the command",
      "Suggested destination: docs",
      "Occurrences: 1",
      "First seen:",
      "Last seen:",
    ]) {
      expect(detail.content[0].text).toContain(text);
    }
    expect(detail.details.summary).toBe("Papercut · finding · closed");
  });

  it("reports unknown keys and invalid registry content instead of hiding errors", async () => {
    const root = repo();
    const store = await createPapercutStoreForCwd(root);
    const missing = await inspect(root, { action: "get", key: "missing" });
    expect(missing.content[0].text).toBe("Papercut not found: missing");
    await store.initialize();
    writeFileSync(store.registryPath, "not json");
    const invalid = await inspect(root, { action: "list" });
    expect(invalid.content[0].text).toContain(
      "Papercut registry contains invalid JSON.",
    );
  });

  it("bounds the request schema and renders a short summary with expanded content", async () => {
    expect(
      Check(InspectPapercutsSchema, {
        request: { action: "list", status: "all", offset: 255, limit: 25 },
      }),
    ).toBe(true);
    expect(
      Check(InspectPapercutsSchema, { request: { action: "list", limit: 26 } }),
    ).toBe(false);
    expect(
      Check(InspectPapercutsSchema, {
        request: { action: "list", key: "finding" },
      }),
    ).toBe(false);
    expect(
      Check(InspectPapercutsSchema, {
        request: { action: "get", key: "finding" },
      }),
    ).toBe(true);
    expect(
      Check(InspectPapercutsSchema, {
        request: { action: "get", key: "Upper" },
      }),
    ).toBe(false);
    const definition = tool();
    const result = await definition.execute(
      "id",
      { request: { action: "list" } },
      undefined,
      undefined,
      { cwd: repo() },
    );
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };
    const collapsed = definition
      .renderResult(result, { expanded: false, isPartial: false }, theme, {
        isError: false,
      })
      .render(100)
      .join("\n");
    const expanded = definition
      .renderResult(result, { expanded: true, isPartial: false }, theme, {
        isError: false,
      })
      .render(100)
      .join("\n");
    expect(collapsed).toContain("Papercuts · 0 of 0 (all)");
    expect(expanded).toContain("Papercuts: 0 all findings");
  });
});
