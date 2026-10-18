import { describe, expect, it } from "vitest";
import { resolveChildToolNames } from "./tool-policy.ts";

describe("resolveChildToolNames", () => {
  it("denies closure to workers even with explicit tool overrides and recording permission", () => {
    for (const access of ["inherit", "repository-read-only"] as const) {
      expect(
        resolveChildToolNames({
          parentActiveTools: ["read", "papercut_record", "papercut_close"],
          tools: ["read", "papercut_record", "papercut_close"],
          access,
          allowExplore: false,
          allowPapercut: true,
        }),
      ).toEqual(["read", "papercut_record"]);
    }
  });

  it("retains active external MCP tools for repository-read-only children", () => {
    expect(
      resolveChildToolNames({
        parentActiveTools: ["read", "edit", "write", "mcp", "mcpScript"],
        access: "repository-read-only",
        allowExplore: false,
        allowPapercut: false,
      }),
    ).toEqual(["read", "mcp", "mcpScript"]);
  });
});
