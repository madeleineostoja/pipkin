import { describe, expect, it } from "vitest";
import { resolveChildToolNames } from "./tool-policy.ts";

describe("resolveChildToolNames", () => {
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
