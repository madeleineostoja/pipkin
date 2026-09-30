import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import { BrowserError } from "./errors.js";
import { truncate, truncateSnapshot } from "./observe.js";
import {
  actionParameters,
  observationParameters,
  normalizeAct,
  normalizeObserve,
  normalizeTarget,
} from "./schema.js";

describe("Browser operation inputs", () => {
  it("rejects unrelated fields and unsafe URLs before dispatch", () => {
    expect(
      normalizeAct("navigate", { url: "http://localhost:3000/app" }),
    ).toMatchObject({ action: "navigate" });
    expect(() => normalizeAct("navigate", { url: "file:///tmp/x" })).toThrow(
      BrowserError,
    );
    expect(() =>
      normalizeAct("history", { action: "back", url: "https://example.test" }),
    ).toThrow(BrowserError);
    expect(() => normalizeObserve("tabs", { categories: ["console"] })).toThrow(
      BrowserError,
    );
    expect(() => normalizeObserve("element", {})).toThrow(BrowserError);
    expect(() => normalizeObserve("snapshot", { depth: 21 })).toThrow(
      BrowserError,
    );
    expect(normalizeObserve("snapshot", { depth: 10 })).toMatchObject({
      mode: "snapshot",
    });
  });
  it("keeps capture and wait choices closed and checked state explicit", () => {
    expect(normalizeObserve("screenshot", {})).toMatchObject({
      mode: "screenshot",
      fullPage: false,
    });
    expect(
      normalizeObserve("screenshot", { capture: { kind: "page" } }),
    ).toMatchObject({ fullPage: true });
    expect(() =>
      normalizeObserve("screenshot", {
        capture: { kind: "page", target: { kind: "css", value: "main" } },
      }),
    ).toThrow(BrowserError);
    expect(
      normalizeAct("set_checked", {
        target: { kind: "role", value: "checkbox" },
        checked: false,
      }),
    ).toMatchObject({ action: "uncheck" });
    expect(
      Check(actionParameters.set_checked, {
        target: { kind: "css", value: "input" },
      }),
    ).toBe(false);
    expect(() =>
      normalizeAct("wait", {
        condition: { kind: "load_state", state: "networkidle" },
      }),
    ).toThrow(BrowserError);
    expect(() =>
      normalizeAct("wait", {
        condition: { kind: "url", value: "/ready", match: "regex" },
      }),
    ).toThrow(BrowserError);
    expect(
      normalizeAct("wait", {
        condition: { kind: "url", value: "/ready", match: "contains" },
        timeoutMs: 100,
      }),
    ).toMatchObject({ action: "wait" });
    expect(() => normalizeAct("scroll", { deltaX: 0, deltaY: 0 })).toThrow(
      BrowserError,
    );
    expect(
      Check(observationParameters.element, {
        target: { kind: "css", value: "main" },
        styleProperties: ["color", "color"],
      }),
    ).toBe(false);
  });
  it("rejects kind-specific fields in the public target schema and preserves selector spelling", () => {
    const validate = new Ajv().compile(actionParameters.click);
    const target = { kind: "role", value: "button", name: "Save", exact: true };
    expect(validate({ target })).toBe(true);
    expect(normalizeTarget(target)).toEqual(target);
    expect(
      validate({ target: { kind: "css", value: "main", name: "Main" } }),
    ).toBe(false);
    expect(
      validate({ target: { kind: "ref", value: "e12", exact: false } }),
    ).toBe(false);
    expect(() => normalizeTarget({ kind: "css", value: "   " })).toThrow(
      BrowserError,
    );
    expect(() =>
      normalizeTarget({ kind: "ref", value: "e12 >> text=other" }),
    ).toThrow(BrowserError);
    expect(
      normalizeTarget({ kind: "css", value: " main > button " }).value,
    ).toBe(" main > button ");
  });
  it("marks bounded Unicode output without splitting snapshot refs", () => {
    expect(truncate("a😀bc", 3, 600)).toMatchObject({
      text: "a😀…",
      details: { truncated: true, returnedCharacters: 3 },
    });
    const snapshot = truncateSnapshot(
      `button ${"x".repeat(20)} [ref=abcdefgh]`,
      35,
      600,
    );
    expect(snapshot.text).not.toContain("[ref=");
    expect(snapshot.details.truncated).toBe(true);
  });
});
