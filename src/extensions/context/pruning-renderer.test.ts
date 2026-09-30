import { describe, expect, it } from "vitest";
import { renderPruningMilestone } from "./pruning-renderer.ts";

const theme = { fg: (_color: string, text: string) => text };
const milestone = {
  kind: "warm",
  count: 3,
  estimatedTokensSaved: 18_000,
  reasons: { "superseded-read": 2, "after-consumption-bash": 1 },
};

function render(data: unknown, expanded = false): string | undefined {
  return renderPruningMilestone({ data } as never, { expanded }, theme as never)
    ?.render(80)
    .map((line) => line.trimEnd())
    .join("\n");
}

describe("Context pruning rendering", () => {
  it("shows bounded savings and expands to reason counts", () => {
    expect(render(milestone)).toBe("Context pruned: ~18k tokens (3 results)");
    expect(render(milestone, true)).toBe(
      [
        "Context pruned: ~18k tokens (3 results)",
        "  superseded reads · 2 results",
        "  consumed bash · 1 result",
      ].join("\n"),
    );
  });

  it("rejects invalid milestones rather than displaying misleading counts", () => {
    expect(render({ ...milestone, count: 4 })).toBeUndefined();
    expect(render({ ...milestone, estimatedTokensSaved: 0 })).toBeUndefined();
    expect(render({ ...milestone, reasons: { unknown: 3 } })).toBeUndefined();
  });
});
