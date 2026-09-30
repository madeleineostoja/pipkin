import { describe, expect, it } from "vitest";
import {
  getConfigPath,
  getProjectConfigPath,
  MAX_CONFIG_BYTES,
  MAX_SANDBOX_WRITABLE_ENTRIES,
  MAX_SANDBOX_WRITABLE_LENGTH,
  SandboxConfigSchema,
  parsePipkinConfig,
  parseProjectPipkinConfig,
  presetIssue,
} from "./config.ts";

const models = {
  utility: { model: "test/utility", thinking: "minimal" },
  low: { model: "test/low", thinking: "low" },
  medium: { model: "test/medium", thinking: "medium" },
  high: { model: "test/high", thinking: "high" },
};

describe("Pipkin config", () => {
  it("keeps valid sections when a sibling preset is invalid", () => {
    const snapshot = parsePipkinConfig(
      JSON.stringify({
        models: { ...models, utility: { model: "bad", thinking: "minimal" } },
        implement: { workerConcurrency: 99 },
        unsupported: { enabled: false },
      }),
    );
    expect(snapshot.config.models.utility).toBeUndefined();
    expect(snapshot.config.models.low).toEqual(models.low);
    expect(snapshot.config.implement.workerConcurrency).toBe(8);
    expect(snapshot.config).not.toHaveProperty("unsupported");
    expect(snapshot.issues).toContainEqual(
      expect.objectContaining({ path: "unsupported" }),
    );
    expect(presetIssue(snapshot, "utility")?.message).toContain("model");
  });

  it("reports missing and unknown model fields without substituting a preset", () => {
    const snapshot = parsePipkinConfig(
      JSON.stringify({
        models: {
          utility: models.utility,
          low: { model: "test/low", thinking: "nope" },
          high: { ...models.high, extra: true },
          extra: models.medium,
        },
        implement: { workerConcurrency: 0 },
      }),
    );
    expect(snapshot.config.models.low).toBeUndefined();
    expect(snapshot.config.models.medium).toBeUndefined();
    expect(snapshot.config.models.high).toBeUndefined();
    expect(presetIssue(snapshot, "high")?.path).toBe("models.high.extra");
    expect(snapshot.config.implement.workerConcurrency).toBe(3);
    expect(snapshot.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        "models.low",
        "models.medium",
        "models.high.extra",
        "models.extra",
        "implement.workerConcurrency",
      ]),
    );
  });

  it("normalizes nicknames and rejects empty, control, and oversized values", () => {
    const snapshot = parsePipkinConfig(
      JSON.stringify({ models, nickname: "  Mads   Ostoja  " }),
    );
    expect(snapshot.config.nickname).toBe("Mads Ostoja");
    expect(Object.isFrozen(snapshot.config)).toBe(true);
    for (const nickname of ["   ", "Mads\n", "x".repeat(41)]) {
      const invalid = parsePipkinConfig(JSON.stringify({ models, nickname }));
      expect(invalid.config.nickname).toBeUndefined();
      expect(invalid.issues).toContainEqual(
        expect.objectContaining({ path: "nickname" }),
      );
    }
  });

  it("rejects retired MCP configuration in both scopes with native setup guidance", () => {
    for (const [scope, parse] of [
      ["global", parsePipkinConfig],
      ["project", parseProjectPipkinConfig],
    ] as const) {
      for (const mcp of [{}, { old: { url: "https://example.test/mcp" } }]) {
        const snapshot = parse(
          JSON.stringify({
            models,
            nickname: "Mads",
            implement: { workerConcurrency: 2 },
            sandbox: { writable: ["build"] },
            mcp,
          }),
        );
        expect(snapshot.config).not.toHaveProperty("mcp");
        expect(snapshot.config.sandbox?.writable).toEqual(["build"]);
        expect(snapshot.issues).toContainEqual(
          expect.objectContaining({
            path: "mcp",
            scope,
            message: expect.stringContaining("mcp.json"),
          }),
        );
        expect(
          snapshot.issues.find((issue) => issue.path === "mcp")?.message,
        ).toContain("/mcp");
        if (scope === "global") {
          expect(snapshot.config).toMatchObject({
            models,
            nickname: "Mads",
            implement: { workerConcurrency: 2 },
          });
        }
      }
    }
  });

  it("rejects removed context policy configuration", () => {
    const snapshot = parsePipkinConfig(
      JSON.stringify({ models, context: { staleTurns: 6 } }),
    );
    expect(snapshot.config).not.toHaveProperty("context");
    expect(snapshot.issues).toContainEqual(
      expect.objectContaining({ path: "context", message: "is not supported" }),
    );
  });

  it("reports malformed and oversized input with immutable snapshots", () => {
    const snapshot = parsePipkinConfig("{ nope");
    expect(snapshot.issues[0]?.message).toContain("malformed JSON");
    expect(snapshot.issues[0]?.scope).toBe("global");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.config.models)).toBe(true);
    expect(
      parsePipkinConfig(" ".repeat(MAX_CONFIG_BYTES + 1)).issues[0]?.message,
    ).toContain("byte limit");
  });

  it("recovers valid writable entries and bounds lists in both scopes", () => {
    expect(SandboxConfigSchema.safeParse({ extra: true }).success).toBe(false);
    for (const parse of [parsePipkinConfig, parseProjectPipkinConfig]) {
      const invalid = parse(
        JSON.stringify({
          models,
          sandbox: {
            writable: ["build", 1, "x".repeat(MAX_SANDBOX_WRITABLE_LENGTH + 1)],
          },
        }),
      );
      expect(invalid.config.sandbox?.writable).toEqual(["build"]);
      expect(invalid.issues.map((issue) => issue.path)).toEqual(
        expect.arrayContaining(["sandbox.writable.1", "sandbox.writable.2"]),
      );
      const writable = Array.from(
        { length: MAX_SANDBOX_WRITABLE_ENTRIES + 1 },
        (_, index) => `generated-${index}`,
      );
      const bounded = parse(JSON.stringify({ models, sandbox: { writable } }));
      expect(bounded.config.sandbox?.writable).toEqual(
        writable.slice(0, MAX_SANDBOX_WRITABLE_ENTRIES),
      );
      expect(bounded.issues).toContainEqual(
        expect.objectContaining({
          path: `sandbox.writable.${MAX_SANDBOX_WRITABLE_ENTRIES}`,
        }),
      );
    }
  });

  it("uses scoped paths and rejects global-only project fields", () => {
    expect(getConfigPath("/agent")).toBe("/agent/pipkin/config.json");
    expect(getProjectConfigPath("/checkout")).toBe(
      "/checkout/.pi/pipkin/config.json",
    );
    const project = parseProjectPipkinConfig(
      JSON.stringify({ nickname: "no", sandbox: { writable: ["build"] } }),
    );
    expect(project.config.sandbox.writable).toEqual(["build"]);
    expect(project.issues).toContainEqual(
      expect.objectContaining({ path: "nickname", scope: "project" }),
    );
  });
});
