import type { Locator, Page } from "playwright-core";
import { BrowserError } from "./errors.js";
import type { Target } from "./schema.js";

/** Maps the intentionally small public target language to Playwright semantic locators. */
export function resolveTarget(page: Page, target: Target): Locator {
  switch (target.kind) {
    case "ref":
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
  const locator = resolveTarget(page, target);
  try {
    if ((await locator.count()) !== 1) {
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
      "Browser target could not be resolved.",
    );
  }
  return locator;
}
