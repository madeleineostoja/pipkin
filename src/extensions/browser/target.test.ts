import { describe, expect, it } from "vitest";
import type { Page } from "playwright-core";
import { BrowserError } from "./errors.js";
import { resolveTarget, strictWaitTarget } from "./target.js";

function fakePage(calls: unknown[]): Page {
  const locator = { kind: "locator" };
  return {
    locator: (...args: unknown[]) => (
      calls.push(["locator", ...args]),
      locator
    ),
    getByRole: (...args: unknown[]) => (calls.push(["role", ...args]), locator),
    getByText: (...args: unknown[]) => (calls.push(["text", ...args]), locator),
    getByLabel: (...args: unknown[]) => (
      calls.push(["label", ...args]),
      locator
    ),
    getByPlaceholder: (...args: unknown[]) => (
      calls.push(["placeholder", ...args]),
      locator
    ),
    getByTestId: (...args: unknown[]) => (
      calls.push(["test_id", ...args]),
      locator
    ),
  } as unknown as Page;
}

describe("Browser target resolution", () => {
  it("uses only the corresponding public Playwright locator for every target kind", () => {
    const calls: unknown[] = [];
    const page = fakePage(calls);
    resolveTarget(page, { kind: "ref", value: "e12" });
    resolveTarget(page, {
      kind: "role",
      value: "button",
      name: "Save",
      exact: true,
    });
    resolveTarget(page, { kind: "text", value: "Save" });
    resolveTarget(page, { kind: "label", value: "Message" });
    resolveTarget(page, { kind: "placeholder", value: "Type here" });
    resolveTarget(page, { kind: "test_id", value: "save" });
    resolveTarget(page, { kind: "css", value: "button.save" });
    expect(calls).toEqual([
      ["locator", "aria-ref=e12"],
      ["role", "button", { name: "Save", exact: true }],
      ["text", "Save", { exact: false }],
      ["label", "Message", { exact: false }],
      ["placeholder", "Type here", { exact: false }],
      ["test_id", "save"],
      ["locator", "button.save"],
    ]);
  });

  it("allows an absent semantic target to wait, but rejects ambiguous and stale targets", async () => {
    const count = (value: number) =>
      ({
        locator: () => ({ count: async () => value }),
        getByRole: () => ({ count: async () => value }),
      }) as unknown as Page;

    await expect(
      strictWaitTarget(count(0), { kind: "role", value: "button" }),
    ).resolves.toBeDefined();
    await expect(
      strictWaitTarget(count(2), { kind: "role", value: "button" }),
    ).rejects.toMatchObject({
      category: "target",
    } satisfies Partial<BrowserError>);
    await expect(
      strictWaitTarget(count(0), { kind: "ref", value: "e12" }),
    ).rejects.toMatchObject({
      category: "stale_ref",
      message: expect.stringContaining("observe again"),
    } satisfies Partial<BrowserError>);
  });

  it("does not allow snapshot refs to compose a selector", () => {
    const page = fakePage([]);
    expect(() =>
      resolveTarget(page, { kind: "ref", value: "e12 >> text=other" }),
    ).toThrow(BrowserError);
  });
});
