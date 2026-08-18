import { describe, expect, it } from "vitest";
import { BrowserError } from "./errors.js";
import { truncate, truncateSnapshot } from "./observe.js";
import { normalizeAct, normalizeObserve, normalizeTarget } from "./schema.js";

describe("Browser schemas", () => {
  it("keeps action fields closed and permits loopback HTTP navigation", () => {
    expect(
      normalizeAct({ action: "navigate", url: "http://localhost:3000/app" }),
    ).toMatchObject({ action: "navigate" });
    expect(() =>
      normalizeAct({ action: "navigate", url: "file:///tmp/x" }),
    ).toThrow(BrowserError);
    expect(() =>
      normalizeAct({ action: "back", url: "https://example.test" }),
    ).toThrow(BrowserError);
  });

  it("validates the closed interaction and wait action surface before dispatch", () => {
    expect(
      normalizeAct({
        action: "fill",
        target: { kind: "role", value: "textbox", name: "Message" },
        value: "secret value",
      }),
    ).toMatchObject({ action: "fill" });
    expect(
      normalizeAct({
        action: "wait",
        condition: { kind: "url", value: "/ready", match: "contains" },
        timeoutMs: 100,
      }),
    ).toMatchObject({ action: "wait" });
    expect(() =>
      normalizeAct({ action: "scroll", deltaX: 0, deltaY: 0 }),
    ).toThrow(BrowserError);
    expect(() =>
      normalizeAct({
        action: "select",
        target: { kind: "css", value: "select" },
        values: [],
      }),
    ).toThrow(BrowserError);
    expect(() =>
      normalizeAct({
        action: "wait",
        condition: { kind: "load_state", state: "networkidle" },
      }),
    ).toThrow(BrowserError);
    expect(() =>
      normalizeAct({
        action: "click",
        target: { kind: "ref", value: "x", exact: false },
      }),
    ).toThrow(BrowserError);
    expect(() =>
      normalizeAct({
        action: "click",
        target: { kind: "ref", value: "e12 >> text=other" },
      }),
    ).toThrow(BrowserError);
    expect(
      normalizeAct({
        action: "click",
        target: { kind: "ref", value: "f1e12" },
      }),
    ).toMatchObject({ target: { value: "f1e12" } });
  });

  it("preserves Unicode boundaries while marking bounded output", () => {
    const result = truncate("a😀bc", 3, 600);
    expect(result.text).toBe("a😀…");
    expect(result.details).toMatchObject({
      truncated: true,
      returnedCharacters: 3,
    });
  });

  it("rejects incompatible observation options before a browser is used", () => {
    for (const fullPage of [true, false]) {
      expect(() =>
        normalizeObserve({
          mode: "screenshot",
          target: { kind: "css", value: "main" },
          fullPage,
        }),
      ).toThrow(BrowserError);
    }
    expect(() =>
      normalizeObserve({ mode: "tabs", categories: ["console"] }),
    ).toThrow(BrowserError);
    expect(() => normalizeObserve({ mode: "element" })).toThrow(BrowserError);
    expect(normalizeObserve({ mode: "snapshot", depth: 10 })).toMatchObject({
      mode: "snapshot",
    });
  });

  it("rejects blank targets without changing meaningful selector spelling", () => {
    expect(() => normalizeTarget({ kind: "css", value: "   " })).toThrow(
      BrowserError,
    );
    expect(
      normalizeTarget({ kind: "css", value: " main > button " }).value,
    ).toBe(" main > button ");
  });

  it("truncates snapshots without splitting a ref token", () => {
    const snapshot = truncateSnapshot(
      `button ${"x".repeat(20)} [ref=abcdefgh]`,
      35,
      600,
    );
    expect(snapshot.text).not.toContain("[ref=");
    expect(snapshot.text.endsWith("…")).toBe(true);
    expect(snapshot.details).toMatchObject({ truncated: true });
  });
});
