import type { Locator, Page } from "playwright-core";
import { BrowserError, browserError } from "./errors.js";
import { LIMITS } from "./limits.js";
import { snapshot, type BrowserResult } from "./observe.js";
import { bounded, type BrowserOwner, sanitizeUrl } from "./owner.js";
import { actionSummary } from "./presentation.js";
import type { BrowserActInput, WaitCondition } from "./schema.js";
import { strictTarget, strictWaitTarget } from "./target.js";

const snapshotActions = new Set([
  "navigate",
  "back",
  "forward",
  "reload",
  "open_tab",
  "switch_tab",
  "close_tab",
]);
const elementActions = new Set([
  "click",
  "hover",
  "check",
  "uncheck",
  "fill",
  "type",
  "press",
  "select",
  "scroll",
]);

export async function act(
  owner: BrowserOwner,
  input: BrowserActInput,
): Promise<BrowserResult> {
  let dispatched = false;
  const mutation = input.action !== "wait";
  const redacted = input.action === "fill" || input.action === "type";
  let recovered: string | undefined;
  try {
    let page = await owner.page();
    recovered = owner.consumeActiveChange();
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
    if (
      input.action === "open_tab" &&
      owner.liveTabs().length >= LIMITS.tabCount
    ) {
      throw new BrowserError("target", "Browser has reached its 20-tab limit.");
    }

    // Resolve strict targets before the dispatch boundary; no action can heal a stale ref.
    let locator: Locator | undefined;
    if (elementActions.has(input.action) && input.target) {
      locator = await strictTarget(page, input.target, owner);
    }
    let waitTarget: Locator | undefined;
    if (input.action === "wait" && input.condition?.kind === "target") {
      waitTarget = await strictWaitTarget(page, input.condition.target, owner);
    }

    if (redacted) {
      owner.rememberSensitiveText(input.value!);
    }
    owner.beginAction();
    const dispatch = () => {
      dispatched = true;
      owner.markDispatched(mutation);
    };
    let outcome: string;
    switch (input.action) {
      case "navigate":
        dispatch();
        await navigate(page, input.url!);
        outcome = "Navigated";
        break;
      case "back":
        dispatch();
        await page.goBack({
          waitUntil: "domcontentloaded",
          timeout: LIMITS.navigationMs,
        });
        outcome = "Went back";
        break;
      case "forward":
        dispatch();
        await page.goForward({
          waitUntil: "domcontentloaded",
          timeout: LIMITS.navigationMs,
        });
        outcome = "Went forward";
        break;
      case "reload":
        dispatch();
        await page.reload({
          waitUntil: "domcontentloaded",
          timeout: LIMITS.navigationMs,
        });
        outcome = "Reloaded";
        break;
      case "click":
        dispatch();
        await locator!.click({ timeout: LIMITS.elementMs });
        outcome = "Clicked";
        break;
      case "hover":
        dispatch();
        await locator!.hover({ timeout: LIMITS.elementMs });
        outcome = "Hovered";
        break;
      case "check":
        dispatch();
        await locator!.check({ timeout: LIMITS.elementMs });
        outcome = "Checked";
        break;
      case "uncheck":
        dispatch();
        await locator!.uncheck({ timeout: LIMITS.elementMs });
        outcome = "Unchecked";
        break;
      case "fill":
        dispatch();
        await locator!.fill(input.value!, { timeout: LIMITS.elementMs });
        outcome = "Filled";
        break;
      case "type":
        dispatch();
        await locator!.pressSequentially(input.value!, {
          timeout: LIMITS.elementMs,
        });
        outcome = "Typed";
        break;
      case "press":
        dispatch();
        if (locator) {
          await locator.press(input.key!, { timeout: LIMITS.elementMs });
        } else {
          await targetlessPress(owner, page, input.key!);
        }
        outcome = "Pressed key";
        break;
      case "select":
        dispatch();
        await locator!.selectOption(input.values!, {
          timeout: LIMITS.elementMs,
        });
        outcome = "Selected options";
        break;
      case "scroll":
        dispatch();
        await scroll(page, locator, input.deltaX!, input.deltaY!);
        outcome = "Scrolled";
        break;
      case "wait":
        dispatch();
        await waitFor(
          page,
          input.condition!,
          input.timeoutMs ?? LIMITS.waitDefaultMs,
          waitTarget,
        );
        outcome = "Wait condition satisfied";
        break;
      case "set_viewport":
        dispatch();
        await page.setViewportSize({
          width: input.width!,
          height: input.height!,
        });
        outcome = `Viewport set to ${input.width}×${input.height}`;
        break;
      case "open_tab": {
        dispatch();
        const tab = await owner.newTab();
        page = tab.page;
        if (input.url) {
          await navigate(page, input.url);
        }
        outcome = `Opened ${tab.id}`;
        break;
      }
      case "switch_tab":
        dispatch();
        owner.activate(requestedTab!);
        page = requestedTab!.page;
        outcome = `Switched to ${requestedTab!.id}`;
        break;
      case "close_tab":
        dispatch();
        await owner.close(requestedTab!);
        outcome = `Closed ${requestedTab!.id}`;
        break;
    }
    await owner.settleAction();
    page = await owner.page();
    const change = owner.consumeActiveChange();
    if (recovered || change) {
      outcome = `${outcome}; ${[recovered, change].filter(Boolean).join(" ")}`;
    }
    const target = actionSummary(input);
    if (snapshotActions.has(input.action) || recovered || change) {
      const fresh = await snapshot(page, { mode: "snapshot", depth: 4 }, owner);
      const contextState = owner.contextState();
      const notice = owner.consumeStateLossNotice();
      return {
        content: [
          {
            type: "text",
            text: `${notice ? `${notice}\n\n` : ""}${outcome}.\n\n${(fresh.content[0] as { text: string }).text}`,
          },
        ],
        details: {
          ...fresh.details,
          action: input.action,
          target,
          outcome,
          activeTabId: owner.activeTab()?.id,
          ...contextState,
        },
      };
    }
    return compact(page, owner, input.action, target, outcome);
  } catch (error) {
    if (dispatched) {
      await owner.settleAction().catch(() => {});
    }
    throw owner.withContext(
      browserError(error, { dispatched, mutation, redactCause: redacted }),
      recovered,
    );
  }
}

async function navigate(page: Page, url: string): Promise<void> {
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: LIMITS.navigationMs,
  });
}

async function scroll(
  page: Page,
  target: Locator | undefined,
  deltaX: number,
  deltaY: number,
): Promise<void> {
  if (target) {
    await target.evaluate(
      (element, delta) => element.scrollBy(delta),
      { left: deltaX, top: deltaY },
      { timeout: LIMITS.elementMs },
    );
    return;
  }
  await page
    .locator("html")
    .evaluate(
      (element, delta) =>
        element.ownerDocument.defaultView?.scrollBy(delta.left, delta.top),
      { left: deltaX, top: deltaY },
      { timeout: LIMITS.elementMs },
    );
}

async function waitFor(
  page: Page,
  condition: WaitCondition,
  timeout: number,
  target?: Locator,
): Promise<void> {
  switch (condition.kind) {
    case "url":
      await page.waitForURL(
        (url) =>
          condition.match === "exact"
            ? url.href === condition.value
            : url.href.includes(condition.value),
        { timeout },
      );
      return;
    case "text":
      await page
        .getByText(condition.value, { exact: condition.exact ?? false })
        .waitFor({ state: "visible", timeout });
      return;
    case "target":
      await target!.waitFor({ state: condition.state, timeout });
      return;
    case "load_state":
      await page.waitForLoadState(condition.state, { timeout });
  }
}

async function compact(
  page: Page,
  owner: BrowserOwner,
  action: string,
  target: string | undefined,
  outcome: string,
): Promise<BrowserResult> {
  const title = owner.redactText(
    bounded(await page.title().catch(() => ""), LIMITS.titleChars),
  );
  const details = {
    action,
    target,
    activeTabId: owner.activeTab()?.id,
    url: owner.redactText(sanitizeUrl(page.url())),
    title,
    outcome,
    observe: "Observe again when rendered state matters.",
    ...owner.contextState(),
  };
  const notice = owner.consumeStateLossNotice();
  return {
    content: [
      {
        type: "text",
        text: `${notice ? `${notice}\n\n` : ""}${outcome}. Observe again when rendered state matters.`,
      },
    ],
    details,
  };
}

async function targetlessPress(
  owner: BrowserOwner,
  page: Page,
  key: string,
): Promise<void> {
  const operation = page.keyboard.press(key);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), LIMITS.elementMs);
  });
  try {
    if (
      (await Promise.race([
        operation.then(() => "complete" as const),
        deadline,
      ])) === "deadline"
    ) {
      // Keyboard has no timeout option. Closing this generation makes the
      // underlying protocol call settle before this invocation releases the lane.
      await owner.abortOperation();
      await operation.catch(() => {});
      throw new BrowserError("timeout", "Element action timed out.");
    }
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
