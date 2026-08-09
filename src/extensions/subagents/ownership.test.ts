import { describe, expect, it } from "vitest";
import { isImplementOwned } from "./ownership.js";

describe("Subagent ownership", () => {
  it("recognizes direct and nested Implement agents", () => {
    const implement = {
      kind: "pipkin:implement" as const,
      runId: "run",
      role: "implementer" as const,
    };

    expect(isImplementOwned(implement)).toBe(true);
    expect(
      isImplementOwned({
        kind: "nested",
        parentId: "implementer-1",
        tool: "explore",
        parentOwner: implement,
      }),
    ).toBe(true);
  });

  it("does not classify public or ordinary nested agents as Implement-owned", () => {
    expect(isImplementOwned("public-tool")).toBe(false);
    expect(
      isImplementOwned({
        kind: "nested",
        parentId: "review-1",
        tool: "explore",
        parentOwner: { kind: "public", name: "Agent" },
      }),
    ).toBe(false);
  });
});
