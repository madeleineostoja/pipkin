import { describe, expect, it } from "vitest";
import {
  normalizeDiagnosticsResult,
  normalizeLocations,
  normalizeSymbolsResult,
} from "./normalize.js";

const range = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 3 },
};

describe("normalized semantic data", () => {
  it("reports diagnostic per-item and item-count truncation while preserving severity ordering and deduplication", () => {
    const diagnostics = normalizeDiagnosticsResult([
      {
        message: "x".repeat(2001),
        source: "s".repeat(2001),
        code: "c".repeat(2001),
        severity: 2,
        range,
      },
      { message: "urgent", severity: 1, range },
      { message: "urgent", severity: 1, range },
    ]);
    expect(diagnostics.truncated).toBe(true);
    expect(diagnostics.items).toHaveLength(2);
    expect(diagnostics.items[0].message).toBe("urgent");
    expect(diagnostics.items[1].message).toHaveLength(2000);
    expect(diagnostics.items[1].source).toHaveLength(2000);
    expect(diagnostics.items[1].code).toHaveLength(2000);
    const many = normalizeDiagnosticsResult(
      Array.from({ length: 101 }, (_, index) => ({
        message: `issue-${index}`,
        range,
      })),
    );
    expect(many.items).toHaveLength(100);
    expect(many.truncated).toBe(true);
  });

  it("rejects malformed ranges instead of inventing source positions", () => {
    expect(() =>
      normalizeLocations([{ uri: "custom:source", range: {} }]),
    ).toThrow("Invalid LSP range position");
    expect(() =>
      normalizeDiagnosticsResult([
        {
          message: "issue",
          range: { start: { line: 0, character: 1.5 }, end: range.end },
        },
      ]),
    ).toThrow("Invalid LSP range position");
    expect(() =>
      normalizeLocations([
        {
          uri: "custom:source",
          range: { start: { line: 2, character: 0 }, end: range.end },
        },
      ]),
    ).toThrow("Invalid LSP range end");
  });

  it("does not guess locations for symbols without resolved ranges", () => {
    expect(
      normalizeSymbolsResult(
        [{ name: "value", location: { uri: "custom:source" } }],
        100,
      ),
    ).toEqual({ items: [{ name: "value" }], truncated: false });
  });
});
