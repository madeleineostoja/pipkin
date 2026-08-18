import type { Locator, Page } from "playwright-core";
import { BrowserError } from "./errors.js";
import type { Target } from "./schema.js";

/** Maps the intentionally small public target language to Playwright semantic locators. */
const snapshotRef = /^(?:e\d+|f\d+e\d+)$/u;

export function isSnapshotRef(value: string): boolean {
  return snapshotRef.test(value);
}

export function resolveTarget(page: Page, target: Target): Locator {
  switch (target.kind) {
    case "ref":
      if (!isSnapshotRef(target.value)) {
        throw new BrowserError(
          "target",
          "Browser ref has an invalid spelling.",
        );
      }
      return page.locator(`aria-ref=${target.value}`);
    case "role":
      return page.getByRole(target.value as never, {
        name: target.name,
        exact: target.exact ?? false,
      });
    case "text":
      return page.getByText(target.value, { exact: target.exact ?? false });
    case "label":
      return page.getByLabel(target.value, { exact: target.exact ?? false });
    case "placeholder":
      return page.getByPlaceholder(target.value, {
        exact: target.exact ?? false,
      });
    case "test_id":
      return page.getByTestId(target.value);
    case "css":
      return page.locator(target.value);
  }
}

export async function strictTarget(
  page: Page,
  target: Target,
): Promise<Locator> {
  return checkedTarget(page, target, false);
}

/**
 * A semantic wait may begin before its unique target exists. Refs are snapshot
 * handles, so they must still resolve before the wait is dispatched.
 */
export async function strictWaitTarget(
  page: Page,
  target: Target,
): Promise<Locator> {
  return checkedTarget(page, target, target.kind !== "ref");
}

async function checkedTarget(
  page: Page,
  target: Target,
  allowAbsent: boolean,
): Promise<Locator> {
  let locator: Locator;
  try {
    locator = resolveTarget(page, target);
    const count = await locator.count();
    if (count !== 1 && !(allowAbsent && count === 0)) {
      throw new BrowserError(
        target.kind === "ref" ? "stale_ref" : "target",
        target.kind === "ref"
          ? "Browser ref is stale; observe again for fresh refs."
          : "Browser target must resolve to exactly one element.",
      );
    }
  } catch (error) {
    if (error instanceof BrowserError) {
      throw error;
    }
    throw new BrowserError(
      target.kind === "ref" ? "stale_ref" : "target",
      target.kind === "ref"
        ? "Browser ref is stale; observe again for fresh refs."
        : "Browser target could not be resolved.",
    );
  }
  return locator;
}
