import type { Page } from "playwright-core";
import { BrowserError, browserError } from "./errors.js";
import { LIMITS } from "./limits.js";
import { snapshot, type BrowserResult } from "./observe.js";
import { type BrowserOwner, sanitizeUrl } from "./owner.js";
import type { BrowserActInput } from "./schema.js";

export async function act(
  owner: BrowserOwner,
  input: BrowserActInput,
): Promise<BrowserResult> {
  let dispatched = false;
  try {
    let page = await owner.page();
    const requestedTab =
      input.action === "switch_tab" || input.action === "close_tab"
        ? owner.liveTabs().find((entry) => entry.id === input.tabId)
        : undefined;
    if (
      (input.action === "switch_tab" || input.action === "close_tab") &&
      !requestedTab
    ) {
      throw new BrowserError("target", "Browser tab was not found.");
    }
    let outcome: string;
    owner.beginAction();
    dispatched = true;
    switch (input.action) {
      case "navigate":
        await navigate(page, input.url!);
        outcome = "Navigated";
        break;
      case "back":
        await page.goBack({
          waitUntil: "domcontentloaded",
          timeout: LIMITS.navigationMs,
        });
        outcome = "Went back";
        break;
      case "forward":
        await page.goForward({
          waitUntil: "domcontentloaded",
          timeout: LIMITS.navigationMs,
        });
        outcome = "Went forward";
        break;
      case "reload":
        await page.reload({
          waitUntil: "domcontentloaded",
          timeout: LIMITS.navigationMs,
        });
        outcome = "Reloaded";
        break;
      case "set_viewport":
        await page.setViewportSize({
          width: input.width!,
          height: input.height!,
        });
        outcome = `Viewport set to ${input.width}×${input.height}`;
        break;
      case "open_tab": {
        const tab = await owner.newTab();
        page = tab.page;
        if (input.url) {
          await navigate(page, input.url);
        }
        outcome = `Opened ${tab.id}`;
        break;
      }
      case "switch_tab": {
        owner.activate(requestedTab!);
        page = requestedTab!.page;
        outcome = `Switched to ${requestedTab!.id}`;
        break;
      }
      case "close_tab": {
        await owner.close(requestedTab!);
        outcome = `Closed ${requestedTab!.id}`;
        break;
      }
    }
    await owner.settleAction();
    page = await owner.page();
    const change = owner.consumeActiveChange();
    if (change) {
      outcome = `${outcome}; ${change}`;
    }
    const fresh = await snapshot(page, { mode: "snapshot", depth: 4 });
    return {
      content: [
        {
          type: "text",
          text: `${outcome}.\n\n${(fresh.content[0] as { text: string }).text}`,
        },
      ],
      details: {
        ...fresh.details,
        action: input.action,
        outcome,
        activeTabId: owner.activeTab()?.id,
        url: sanitizeUrl(page.url()),
        ...owner.contextState(),
      },
    };
  } catch (error) {
    if (dispatched) {
      await owner.settleAction().catch(() => {});
    }
    throw browserError(error, { dispatched, mutation: true });
  }
}

async function navigate(page: Page, url: string): Promise<void> {
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: LIMITS.navigationMs,
  });
}
