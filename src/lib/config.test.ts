import { describe, expect, it } from "vitest";
import {
  getConfigPath,
  getProjectConfigPath,
  MAX_CONFIG_BYTES,
  MAX_MCP_OAUTH_CLIENT_NAME_LENGTH,
  MAX_MCP_SERVER_NAME_LENGTH,
  MAX_MCP_SERVER_URL_LENGTH,
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

const sandboxParsers = [
  {
    scope: "global",
    parse: (writable: string[]) => {
      const snapshot = parsePipkinConfig(
        JSON.stringify({ sandbox: { writable } }),
      );
      return {
        writable: snapshot.config.sandbox?.writable,
        issues: snapshot.issues,
      };
    },
  },
  {
    scope: "project",
    parse: (writable: string[]) => {
      const snapshot = parseProjectPipkinConfig(
        JSON.stringify({ sandbox: { writable } }),
      );
      return {
        writable: snapshot.config.sandbox.writable,
        issues: snapshot.issues,
      };
    },
  },
];

describe("Pipkin config", () => {
  it("uses the sole agent-level config path", () => {
    expect(getConfigPath("/agent")).toBe("/agent/pipkin/config.json");
  });

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
    expect(snapshot.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "unsupported" }),
      ]),
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

  it("accepts a normalized nickname while keeping the snapshot immutable", () => {
    const snapshot = parsePipkinConfig(
      JSON.stringify({ models, nickname: "  Mads   Ostoja  " }),
    );

    expect(snapshot.config.nickname).toBe("Mads Ostoja");
    expect(Object.isFrozen(snapshot.config)).toBe(true);
  });

  it("rejects empty, control, and oversized nicknames", () => {
    for (const nickname of ["   ", "Mads\n", "x".repeat(41)]) {
      const snapshot = parsePipkinConfig(JSON.stringify({ models, nickname }));
      expect(snapshot.config.nickname).toBeUndefined();
      expect(snapshot.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: "nickname" })]),
      );
    }
  });

  it("parses strict global MCP servers while retaining valid siblings", () => {
    const snapshot = parsePipkinConfig(
      JSON.stringify({
        models,
        implement: { workerConcurrency: 2 },
        mcp: {
          docs: {
            url: "https://mcp.example.test/v1",
            oauth: { clientName: "  Approved Client  " },
          },
          local: { url: "http://127.0.0.1:7777/mcp" },
          broken: { url: "ftp://example.test", extra: true },
        },
      }),
    );

    expect(snapshot.config.mcp).toEqual({
      docs: {
        url: "https://mcp.example.test/v1",
        oauth: { clientName: "Approved Client" },
      },
      local: { url: "http://127.0.0.1:7777/mcp" },
    });
    expect(snapshot.config.implement.workerConcurrency).toBe(2);
    expect(snapshot.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(["mcp.broken.url", "mcp.broken.extra"]),
    );
    expect(Object.isFrozen(snapshot.config.mcp)).toBe(true);
    expect(Object.isFrozen(snapshot.config.mcp?.docs?.oauth)).toBe(true);
  });

  it("rejects malformed MCP OAuth client metadata while retaining valid siblings", () => {
    const snapshot = parsePipkinConfig(
      JSON.stringify({
        mcp: {
          valid: { url: "https://valid.test/mcp" },
          malformed: { url: "https://invalid.test/mcp", oauth: false },
          empty: {
            url: "https://invalid.test/mcp",
            oauth: { clientName: "   " },
          },
          control: {
            url: "https://invalid.test/mcp",
            oauth: { clientName: "bad\nname" },
          },
          oversized: {
            url: "https://invalid.test/mcp",
            oauth: {
              clientName: "x".repeat(MAX_MCP_OAUTH_CLIENT_NAME_LENGTH + 1),
            },
          },
          interpolated: {
            url: "https://invalid.test/mcp",
            oauth: { clientName: "${MCP_CLIENT_NAME}" },
          },
          unsupported: {
            url: "https://invalid.test/mcp",
            oauth: { clientName: "Client", clientId: "not-supported" },
          },
        },
      }),
    );

    expect(snapshot.config.mcp).toEqual({
      valid: { url: "https://valid.test/mcp" },
    });
    expect(snapshot.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        "mcp.malformed.oauth",
        "mcp.empty.oauth.clientName",
        "mcp.control.oauth.clientName",
        "mcp.oversized.oauth.clientName",
        "mcp.interpolated.oauth.clientName",
        "mcp.unsupported.oauth.clientId",
      ]),
    );
  });

  it("rejects malformed bounded MCP names and URLs without adding MCP config", () => {
    const snapshot = parsePipkinConfig(
      JSON.stringify({
        models,
        mcp: {
          Bad: { url: "https://mcp.example.test" },
          ["a".repeat(MAX_MCP_SERVER_NAME_LENGTH + 1)]: {
            url: "https://mcp.example.test",
          },
          malformed: { url: "not a url" },
          oversized: {
            url: `https://example.test/${"x".repeat(MAX_MCP_SERVER_URL_LENGTH)}`,
          },
        },
      }),
    );

    expect(snapshot.config.mcp).toEqual({});
    expect(snapshot.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        "mcp.Bad",
        `mcp.${"a".repeat(MAX_MCP_SERVER_NAME_LENGTH + 1)}`,
        "mcp.malformed.url",
        "mcp.oversized.url",
      ]),
    );
  });

  it("parses strict project MCP servers independently from invalid siblings", () => {
    const project = parseProjectPipkinConfig(
      JSON.stringify({
        sandbox: { writable: ["build"] },
        mcp: {
          project: {
            url: "https://project.test/mcp",
            oauth: { clientName: "Project Client" },
          },
          project__reserved: { url: "https://not-used.test" },
          broken: { url: "ftp://not-used.test" },
        },
      }),
    );

    expect(project.config.mcp).toEqual({
      project: {
        url: "https://project.test/mcp",
        oauth: { clientName: "Project Client" },
      },
    });
    expect(project.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "mcp.project__reserved",
          scope: "project",
        }),
        expect.objectContaining({ path: "mcp.broken.url", scope: "project" }),
      ]),
    );
  });

  it("reserves generated project names in both configuration scopes", () => {
    for (const parse of [parsePipkinConfig, parseProjectPipkinConfig]) {
      const snapshot = parse(
        JSON.stringify({
          mcp: { project__reserved: { url: "https://mcp.test" } },
        }),
      );
      expect(snapshot.config.mcp).toEqual({});
      expect(snapshot.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "mcp.project__reserved" }),
        ]),
      );
    }
  });

  it("rejects removed context policy configuration", () => {
    const snapshot = parsePipkinConfig(
      JSON.stringify({ models, context: { staleTurns: 6 } }),
    );

    expect(snapshot.config).not.toHaveProperty("context");
    expect(snapshot.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "context",
          message: "is not supported",
        }),
      ]),
    );
  });

  it("reports malformed JSON and returns an immutable snapshot", () => {
    const snapshot = parsePipkinConfig("{ nope");
    expect(snapshot.issues[0]?.message).toContain("malformed JSON");
    expect(snapshot.issues[0]?.scope).toBe("global");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.config.models)).toBe(true);
  });

  it("models the strict optional Sandbox shape", () => {
    expect(SandboxConfigSchema.safeParse({}).success).toBe(true);
    expect(SandboxConfigSchema.safeParse({ writable: ["build"] }).success).toBe(
      true,
    );
    expect(SandboxConfigSchema.safeParse({ extra: true }).success).toBe(false);
  });

  it("recovers valid writable entries while preserving sibling global settings", () => {
    const snapshot = parsePipkinConfig(
      JSON.stringify({
        models,
        implement: { workerConcurrency: 2 },
        sandbox: { writable: ["~/safe", 1, "x".repeat(1025)] },
      }),
    );
    expect(snapshot.config.sandbox?.writable).toEqual(["~/safe"]);
    expect(snapshot.config.implement.workerConcurrency).toBe(2);
    expect(snapshot.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(["sandbox.writable.1", "sandbox.writable.2"]),
    );
  });

  it("enforces writable entry counts on well-typed lists in both scopes", () => {
    const writable = Array.from(
      { length: MAX_SANDBOX_WRITABLE_ENTRIES + 1 },
      (_, index) => `generated-${index}`,
    );

    for (const { scope, parse } of sandboxParsers) {
      const snapshot = parse(writable);
      expect(snapshot.writable).toEqual(
        writable.slice(0, MAX_SANDBOX_WRITABLE_ENTRIES),
      );
      expect(snapshot.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: `sandbox.writable.${MAX_SANDBOX_WRITABLE_ENTRIES}`,
            scope,
            message: expect.stringContaining("entry limit"),
          }),
        ]),
      );
    }
  });

  it("omits overlong strings from well-typed writable lists in both scopes", () => {
    const writable = ["generated", "x".repeat(MAX_SANDBOX_WRITABLE_LENGTH + 1)];

    for (const { scope, parse } of sandboxParsers) {
      const snapshot = parse(writable);
      expect(snapshot.writable).toEqual(["generated"]);
      expect(snapshot.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "sandbox.writable.1",
            scope,
            message: expect.stringContaining("characters"),
          }),
        ]),
      );
    }
  });

  it("limits configuration input and rejects global-only project fields", () => {
    expect(getProjectConfigPath("/checkout")).toBe(
      "/checkout/.pi/pipkin/config.json",
    );
    const project = parseProjectPipkinConfig(
      JSON.stringify({ nickname: "no", sandbox: { writable: ["build"] } }),
    );
    expect(project.config.sandbox.writable).toEqual(["build"]);
    expect(project.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "nickname", scope: "project" }),
      ]),
    );
    const oversized = parsePipkinConfig(" ".repeat(MAX_CONFIG_BYTES + 1));
    expect(oversized.issues[0]?.message).toContain("byte limit");
  });
});
