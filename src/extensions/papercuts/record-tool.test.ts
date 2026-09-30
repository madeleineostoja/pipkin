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
import { afterEach, describe, expect, it, vi } from "vitest";
import { Check } from "typebox/value";
import { registerRecordTool } from "./record-tool.js";
import { PapercutObservationSchema } from "./tool-contract.js";
import { createPapercutStoreForCwd } from "./store.js";
import { createPapercutStatusController } from "./status.js";

const roots: string[] = [];
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "pipkin-record-tool-"));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);

const observation = {
  key: "validation-convention",
  title: "Undocumented validation convention",
  task: "Implement unrelated work",
  incident: "Had to discover validation.",
  evidence: "Scripts showed the convention.",
  workarounds: ["Inspected scripts.", "Ran the command."],
  taskOutcome: "Completed validation safely.",
  suggestedDestination: "docs" as const,
};

describe("papercut_record", () => {
  it("renders a concise recorded key, title, and outcome", () => {
    let tool: any;
    registerRecordTool(
      { registerTool: (definition: unknown) => (tool = definition) } as never,
      createPapercutStatusController(),
    );
    const result = {
      content: [
        { type: "text" as const, text: "Papercut created: durable-key (1)" },
      ],
      details: {
        outcome: "created",
        key: "durable-key",
        title: "Useful friction",
        occurrences: 1,
        summary: "Recorded · created · durable-key",
      },
    };
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };
    const collapsed = tool
      .renderResult(result, { expanded: false, isPartial: false }, theme, {
        isError: false,
      })
      .render(200)
      .map((line: string) => line.trimEnd())
      .join("\n");
    const expanded = tool
      .renderResult(result, { expanded: true, isPartial: false }, theme, {
        isError: false,
      })
      .render(200)
      .map((line: string) => line.trimEnd())
      .join("\n");

    const call = tool
      .renderCall(
        { ...observation, key: "durable-key", title: "Useful friction" },
        theme,
        { isPartial: false },
      )
      .render(200)
      .map((line: string) => line.trimEnd())
      .join("\n");
    expect(call).toBe("papercut_record durable-key · Useful friction");
    expect(collapsed).toBe("Recorded · created · durable-key");
    expect(expanded).toContain("Papercut created: durable-key (1)");
  });
  it("registers the bounded factual incident schema and eligibility guidance", () => {
    let tool: any;
    registerRecordTool(
      {
        registerTool: (definition: unknown) => {
          tool = definition;
        },
      } as never,
      createPapercutStatusController(),
    );
    expect(tool.name).toBe("papercut_record");
    expect(tool.exposure).toBe("direct");
    expect(tool.namespace.name).toBe("papercuts");
    expect(
      JSON.parse(JSON.stringify(PapercutObservationSchema))
        .additionalProperties,
    ).toBe(false);
    expect(tool.parameters.properties.workarounds).toMatchObject({
      minItems: 1,
      maxItems: 5,
    });
    expect(tool.description).toContain("No outage");
    expect(tool.description).toContain("undocumented validation convention");
    expect(tool.description).toContain("manual worktree setup");
    expect(tool.description).toContain("papercut_list");
    expect(tool.description).toContain("papercut_get");
    expect(tool.description).toContain("open and closed");
    expect(tool.description).toContain("reuse the existing key");
  });

  it("enforces every public observation bound, shape, and trim rule", () => {
    expect(Check(PapercutObservationSchema, observation)).toBe(true);
    expect(Check(PapercutObservationSchema, { ...observation, key: "a" })).toBe(
      true,
    );
    expect(
      Check(PapercutObservationSchema, {
        ...observation,
        key: "a".repeat(64),
        title: "a".repeat(120),
        task: "a".repeat(1_000),
        incident: "a".repeat(2_000),
        evidence: "a".repeat(2_000),
        workarounds: Array.from({ length: 5 }, () => "a".repeat(1_000)),
        taskOutcome: "a".repeat(1_000),
        guardrailCandidate: "a".repeat(1_000),
      }),
    ).toBe(true);
    for (const [field, value] of Object.entries({
      key: "A-key",
      title: "a".repeat(121),
      task: "a".repeat(1_001),
      incident: "a".repeat(2_001),
      evidence: "a".repeat(2_001),
      taskOutcome: "a".repeat(1_001),
      guardrailCandidate: "a".repeat(1_001),
    })) {
      expect(
        Check(PapercutObservationSchema, { ...observation, [field]: value }),
      ).toBe(false);
    }
    expect(
      Check(PapercutObservationSchema, {
        ...observation,
        key: "a".repeat(65),
      }),
    ).toBe(false);
    for (const key of ["-leading-hyphen", "trailing-hyphen-"]) {
      expect(Check(PapercutObservationSchema, { ...observation, key })).toBe(
        false,
      );
    }
    for (const field of [
      "title",
      "task",
      "incident",
      "evidence",
      "taskOutcome",
      "guardrailCandidate",
    ]) {
      expect(
        Check(PapercutObservationSchema, { ...observation, [field]: " \n\t " }),
      ).toBe(false);
    }
    expect(
      Check(PapercutObservationSchema, { ...observation, workarounds: [" "] }),
    ).toBe(false);
    expect(
      Check(PapercutObservationSchema, { ...observation, workarounds: [] }),
    ).toBe(false);
    expect(
      Check(PapercutObservationSchema, {
        ...observation,
        workarounds: ["a".repeat(1_001)],
      }),
    ).toBe(false);
    expect(
      Check(PapercutObservationSchema, {
        ...observation,
        workarounds: Array.from({ length: 6 }, () => "done"),
      }),
    ).toBe(false);
    expect(
      Check(PapercutObservationSchema, {
        ...observation,
        suggestedDestination: "other",
      }),
    ).toBe(false);
    expect(
      Check(PapercutObservationSchema, { ...observation, unexpected: true }),
    ).toBe(false);
    const {
      guardrailCandidate: _candidate,
      suggestedDestination: _destination,
      ...required
    } = { ...observation, guardrailCandidate: "Document it." };
    expect(Check(PapercutObservationSchema, required)).toBe(true);
  });

  it("trims accepted surrounding whitespace before persistence", async () => {
    const root = repo();
    const status = createPapercutStatusController();
    const ctx = {
      cwd: root,
      mode: "json",
      ui: { notify: vi.fn(), setStatus: vi.fn() },
    };
    expect(
      Check(PapercutObservationSchema, {
        ...observation,
        title: "  Undocumented validation convention  ",
        workarounds: ["  Inspected scripts.  "],
        guardrailCandidate: "  Document it.  ",
      }),
    ).toBe(true);
    const result = await (
      await status.storeFor(ctx as never)
    ).record({
      ...observation,
      title: "  Undocumented validation convention  ",
      workarounds: ["  Inspected scripts.  "],
      guardrailCandidate: "  Document it.  ",
    });
    expect(result).toMatchObject({ kind: "created" });
    expect(
      (await (await status.storeFor(ctx as never)).load()).records[0],
    ).toMatchObject({
      title: "Undocumented validation convention",
      workarounds: ["Inspected scripts."],
      guardrailCandidate: "Document it.",
    });
  });

  it("refreshes the open-count status after a successful registered record", async () => {
    let tool: any;
    registerRecordTool(
      { registerTool: (definition: unknown) => (tool = definition) } as never,
      createPapercutStatusController(),
    );
    const setStatus = vi.fn();
    const result = await tool.execute("id", observation, undefined, undefined, {
      cwd: repo(),
      mode: "tui",
      ui: {
        notify: vi.fn(),
        setStatus,
        theme: { fg: (_tone: string, text: string) => text },
      },
    });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      outcome: "created",
    });
    expect(Check(tool.outputSchema, result.structuredContent)).toBe(true);
    expect(setStatus).toHaveBeenLastCalledWith(
      "pipkin:status:0300:papercuts",
      "󰶯 1 papercuts",
    );
  });

  it("returns schema-valid recorded identities for creation, independent recurrence and reopening", async () => {
    let tool: any;
    registerRecordTool(
      {
        registerTool: (definition: unknown) => {
          tool = definition;
        },
      } as never,
      createPapercutStatusController(),
    );
    const ctx = {
      cwd: repo(),
      mode: "json",
      ui: { notify: vi.fn(), setStatus: vi.fn() },
    };
    const result = await tool.execute(
      "id",
      observation,
      undefined,
      undefined,
      ctx,
    );
    expect(result.structuredContent).toMatchObject({
      ok: true,
      outcome: "created",
      key: observation.key,
      occurrences: 1,
    });
    expect(Check(tool.outputSchema, result.structuredContent)).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual(
      result.structuredContent,
    );
    expect(result.content[0].text).not.toContain(observation.incident);
    expect(
      Buffer.byteLength(result.content[0].text, "utf8"),
    ).toBeLessThanOrEqual(512);
    const store = await createPapercutStoreForCwd(ctx.cwd);
    const firstSeenAt = (await store.load()).records[0].firstSeenAt;
    for (const outcome of ["merged", "reopened"]) {
      if (outcome === "reopened") {
        await store.close(observation.key);
      }
      const recurrence = await tool.execute(
        "id",
        {
          ...observation,
          title: "Replacement title",
          incident: "An independently encountered recurrence",
        },
        undefined,
        undefined,
        ctx,
      );
      expect(Check(tool.outputSchema, recurrence.structuredContent)).toBe(true);
      expect(recurrence.structuredContent).toMatchObject({
        ok: true,
        outcome,
        key: observation.key,
        title: observation.title,
        occurrences: outcome === "merged" ? 2 : 3,
      });
      expect((await store.load()).records[0]).toMatchObject({
        firstSeenAt,
        status: "open",
        incident: "An independently encountered recurrence",
      });
    }
  });

  it("rejects malformed writes before initialization and reports persistence failure as structured data", async () => {
    const status = createPapercutStatusController();
    let tool: any;
    registerRecordTool(
      {
        registerTool: (value: unknown) => {
          tool = value;
        },
      } as never,
      status,
    );
    const ctx = {
      cwd: repo(),
      mode: "json",
      ui: { notify: vi.fn(), setStatus: vi.fn() },
    };
    const store = await createPapercutStoreForCwd(ctx.cwd);
    for (const args of [
      { ...observation, workarounds: [] },
      { ...observation, unexpected: true },
      { key: "finding" },
    ]) {
      const rejected = await tool.execute(
        "id",
        args,
        undefined,
        undefined,
        ctx,
      );
      expect(Check(tool.outputSchema, rejected.structuredContent)).toBe(true);
      expect(rejected).toMatchObject({
        isError: true,
        structuredContent: { ok: false, error: { code: "invalid_arguments" } },
      });
    }
    expect(existsSync(join(ctx.cwd, ".pi", "pipkin"))).toBe(false);
    await store.initialize();
    writeFileSync(store.registryPath, "not json");
    const failed = await tool.execute(
      "id",
      observation,
      undefined,
      undefined,
      ctx,
    );
    expect(Check(tool.outputSchema, failed.structuredContent)).toBe(true);
    expect(failed).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error: {
          code: "persistence_failed",
          message: "Papercut registry contains invalid JSON.",
        },
      },
    });
    expect(readFileSync(store.registryPath, "utf8")).toBe("not json");
  });
});
