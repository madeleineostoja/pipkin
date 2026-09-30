import type { Page } from "playwright-core";
import { BrowserError, browserError } from "./errors.js";
import { LIMITS } from "./limits.js";
import { bounded, type BrowserOwner, sanitizeUrl } from "./owner.js";
import {
  success,
  type BrowserPage,
  type BrowserResult,
  type DiagnosticEvent,
  type ElementData,
  type ObservationSuccess,
} from "./results.js";
import type { BrowserObserveInput } from "./schema.js";
import { strictTarget } from "./target.js";

export async function observe(
  owner: BrowserOwner,
  input: BrowserObserveInput,
): Promise<BrowserResult> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const generation = owner.contextState().generation;
    try {
      const result = await observeOnce(owner, input);
      if (owner.contextState().generation !== generation) {
        throw new BrowserError(
          "browser_disconnected",
          "Browser disconnected during observation.",
        );
      }
      const recovery = owner.consumeActiveChange();
      const notice = owner.stateLossNotice();
      const guidance = [recovery, notice].filter(Boolean).join(" ");
      return success(
        {
          ...result.structuredContent,
          ...(guidance ? { recovery: bounded(guidance, 2000) } : {}),
        },
        { ...result.details, ...(guidance ? { recovery: guidance } : {}) },
      );
    } catch (error) {
      // Retry only an observation after the owner proved this generation disconnected.
      if (attempt === 0 && owner.canRetryObservation(generation)) {
        continue;
      }
      throw owner.withContext(browserError(error));
    }
  }
  throw new BrowserError(
    "backend",
    "Browser observation could not be completed.",
  );
}
async function observeOnce(
  owner: BrowserOwner,
  input: BrowserObserveInput,
): Promise<BrowserResult<ObservationSuccess>> {
  if (input.mode === "tabs") {
    return tabs(owner);
  }
  if (input.mode === "diagnostics") {
    return diagnostics(owner, input);
  }
  const page = await owner.page();
  switch (input.mode) {
    case "snapshot":
      return snapshot(page, input, owner);
    case "screenshot":
      return screenshot(page, input, owner);
    case "text":
      return text(page, input, owner);
    case "element":
      return element(page, input, owner);
  }
}
export async function pageDetails(
  page: Page,
  owner: BrowserOwner,
): Promise<BrowserPage> {
  const generation = owner.contextState().generation;
  const tab = owner.activeTab();
  if (tab?.page !== page || page.isClosed()) {
    throw new BrowserError("page_gone", "Browser page is no longer available.");
  }
  const url = bounded(
    owner.redactText(sanitizeUrl(page.url())),
    LIMITS.urlChars,
  );
  const title = bounded(
    owner.redactText(await page.title().catch(() => "")),
    LIMITS.titleChars,
  );
  // Identity collection can yield to cancellation/disconnection after evidence was read.
  if (owner.contextState().generation !== generation) {
    throw new BrowserError(
      "browser_disconnected",
      "Browser disconnected during identity collection.",
    );
  }
  if (owner.activeTab() !== tab || page.isClosed()) {
    throw new BrowserError("page_gone", "Browser page is no longer available.");
  }
  return { tabId: tab.id, url, title, generation };
}
function clip(
  owner: BrowserOwner,
  value: string,
  chars: number,
  lines: number = LIMITS.outputLines,
) {
  return truncate(
    bounded(owner.redactText(value), Number.MAX_SAFE_INTEGER),
    chars,
    lines,
  );
}
async function snapshot(
  page: Page,
  input: BrowserObserveInput,
  owner: BrowserOwner,
): Promise<BrowserResult<ObservationSuccess>> {
  const root = input.target
    ? await strictTarget(page, input.target, owner)
    : page.locator("body");
  let value: string;
  try {
    value = await root.ariaSnapshot({
      mode: "ai",
      depth: input.depth ?? LIMITS.defaultSnapshotDepth,
      boxes: input.boxes ?? false,
    });
  } catch (error) {
    throw input.target?.kind === "ref"
      ? new BrowserError(
          "stale_ref",
          "Browser ref is stale; use browser_snapshot for fresh refs.",
        )
      : error;
  }
  const emitted = owner.registerSnapshot(
    page,
    bounded(owner.redactText(value), Number.MAX_SAFE_INTEGER),
  );
  const clipped = truncateSnapshot(
    emitted,
    LIMITS.snapshotChars,
    LIMITS.outputLines,
  );
  owner.retainSnapshotRefs(clipped.text);
  const identity = await pageDetails(page, owner);
  return success(
    {
      ok: true,
      page: identity,
      ...owner.contextState(),
      snapshot: clipped.text,
      truncated: clipped.details.truncated,
    },
    { mode: "snapshot", ...identity, ...clipped.details },
  );
}
async function screenshot(
  page: Page,
  input: BrowserObserveInput,
  owner: BrowserOwner,
): Promise<BrowserResult<ObservationSuccess>> {
  const target = input.target
    ? await strictTarget(page, input.target, owner)
    : undefined;
  const dimensions = target
    ? await target.boundingBox()
    : input.fullPage
      ? await page.evaluate(() => ({
          width: document.documentElement.scrollWidth,
          height: document.documentElement.scrollHeight,
        }))
      : page.viewportSize();
  if (
    !dimensions ||
    dimensions.width <= 0 ||
    dimensions.height <= 0 ||
    dimensions.width > LIMITS.screenshotWidth ||
    dimensions.height > LIMITS.screenshotHeight
  ) {
    throw new BrowserError(
      "content",
      "Screenshot exceeds the 4,096×12,000 CSS-pixel limit or has no visible dimensions; use a viewport or element screenshot.",
    );
  }
  const image = await (target
    ? target.screenshot({ type: "png", timeout: LIMITS.navigationMs })
    : page.screenshot({
        type: "png",
        fullPage: input.fullPage ?? false,
        timeout: LIMITS.navigationMs,
      }));
  if (image.byteLength > LIMITS.screenshotBytes) {
    throw new BrowserError(
      "content",
      "Screenshot exceeds the 10 MiB PNG limit; use a viewport or element screenshot.",
    );
  }
  const identity = await pageDetails(page, owner);
  const size = {
    width: Math.ceil(dimensions.width),
    height: Math.ceil(dimensions.height),
    bytes: image.byteLength,
  };
  return success(
    {
      ok: true,
      page: identity,
      ...owner.contextState(),
      image: {
        type: "image",
        data: image.toString("base64"),
        mimeType: "image/png",
      },
      ...size,
    },
    { mode: "screenshot", ...identity, ...size },
  );
}
async function text(
  page: Page,
  input: BrowserObserveInput,
  owner: BrowserOwner,
): Promise<BrowserResult<ObservationSuccess>> {
  const root = input.target
    ? await strictTarget(page, input.target, owner)
    : page.locator("body");
  const clipped = clip(owner, await root.innerText(), LIMITS.textChars);
  const identity = await pageDetails(page, owner);
  return success(
    {
      ok: true,
      page: identity,
      ...owner.contextState(),
      text: clipped.text,
      truncated: clipped.details.truncated,
    },
    { mode: "text", ...identity, ...clipped.details },
  );
}
async function element(
  page: Page,
  input: BrowserObserveInput,
  owner: BrowserOwner,
): Promise<BrowserResult<ObservationSuccess>> {
  const locator = await strictTarget(page, input.target!, owner);
  const inspected = await locator.evaluate((node, properties: string[]) => {
    const element = node as HTMLElement & {
      value?: string;
      checked?: boolean;
      disabled?: boolean;
    };
    const styles = getComputedStyle(element);
    const base = [
      "display",
      "visibility",
      "opacity",
      "position",
      "z-index",
      "overflow",
      "color",
      "background-color",
      "font-family",
      "font-size",
      "font-weight",
      "line-height",
      "margin",
      "padding",
      "width",
      "height",
    ];
    return {
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role") ?? undefined,
      name: element.getAttribute("aria-label") ?? undefined,
      attributes: Object.fromEntries(
        [
          "id",
          "class",
          "type",
          "name",
          "aria-label",
          "aria-describedby",
          "aria-checked",
          "aria-disabled",
          "placeholder",
          "href",
          "title",
        ].flatMap((name) => {
          const value = element.getAttribute(name);
          return value === null ? [] : [[name, value]];
        }),
      ),
      outerHtml: element.outerHTML,
      text: element.innerText ?? "",
      value: element.value,
      checked: element.checked,
      disabled: element.disabled,
      styles: Object.fromEntries(
        [...new Set([...base, ...properties])].map((name) => [
          name,
          styles.getPropertyValue(name),
        ]),
      ),
    };
  }, input.styleProperties ?? []);
  const html = clip(
    owner,
    inspected.outerHtml,
    LIMITS.elementHtmlChars,
    Number.MAX_SAFE_INTEGER,
  );
  const text = clip(owner, inspected.text, LIMITS.textChars);
  let truncated = html.details.truncated || text.details.truncated;
  const field = (value: string, limit: number) => {
    const safe = bounded(owner.redactText(value), Number.MAX_SAFE_INTEGER);
    if (Array.from(safe).length > limit) {
      truncated = true;
    }
    return bounded(safe, limit);
  };
  const box = await locator.boundingBox();
  const data: ElementData = {
    tag: field(inspected.tag, 128),
    ...(inspected.role !== undefined
      ? { role: field(inspected.role, 500) }
      : {}),
    ...(inspected.name !== undefined
      ? { name: field(inspected.name, 500) }
      : {}),
    attributes: Object.fromEntries(
      Object.entries(inspected.attributes).map(([name, value]) => [
        name,
        field(name === "href" ? sanitizeUrl(value) : value, 1000),
      ]),
    ),
    outerHtml: html.text,
    text: text.text,
    ...(typeof inspected.value === "string"
      ? { value: field(inspected.value, LIMITS.elementValueChars) }
      : {}),
    ...(typeof inspected.checked === "boolean"
      ? { checked: inspected.checked }
      : {}),
    ...(typeof inspected.disabled === "boolean"
      ? { disabled: inspected.disabled }
      : {}),
    visible: await locator.isVisible(),
    ...(box ? { box } : {}),
    styles: Object.fromEntries(
      Object.entries(inspected.styles).map(([name, value]) => [
        name,
        field(value, LIMITS.styleValueChars),
      ]),
    ),
  };
  const identity = await pageDetails(page, owner);
  return success(
    {
      ok: true,
      page: identity,
      ...owner.contextState(),
      element: data,
      truncated,
    },
    { mode: "element", ...identity, truncated },
  );
}
async function diagnostics(
  owner: BrowserOwner,
  input: BrowserObserveInput,
): Promise<BrowserResult<ObservationSuccess>> {
  const matching = owner
    .getDiagnostics()
    .filter(
      (entry) => !input.categories || input.categories.includes(entry.category),
    );
  const records = matching.slice(-LIMITS.diagnosticResult);
  const events: DiagnosticEvent[] = [];
  let characters = 2;
  let lines = 0;
  let fieldsTruncated = false;
  for (const entry of [...records].reverse()) {
    let clipped = entry.truncated;
    const field = (value: string, limit: number) => {
      const safe = bounded(owner.redactText(value), Number.MAX_SAFE_INTEGER);
      clipped ||= Array.from(safe).length > limit;
      return bounded(safe, limit);
    };
    const base = {
      sequence: entry.sequence,
      tabId: entry.tabId,
      message: field(entry.message, LIMITS.diagnosticMessageChars),
    };
    const url = field(entry.url ?? "about:blank", LIMITS.urlChars);
    const event: DiagnosticEvent =
      entry.category === "page_error"
        ? { ...base, category: entry.category }
        : entry.category === "request_failed"
          ? {
              ...base,
              category: entry.category,
              url,
              method: field(entry.method ?? "", 100),
            }
          : entry.category === "http_error"
            ? { ...base, category: entry.category, url, status: entry.status! }
            : {
                ...base,
                category: entry.category,
                ...(entry.url ? { url } : {}),
              };
    const encoded = JSON.stringify(event);
    const length = Array.from(encoded).length + (events.length > 0 ? 1 : 0);
    const eventLines = event.message.split("\n").length;
    if (
      characters + length > LIMITS.diagnosticChars ||
      lines + eventLines > LIMITS.outputLines
    ) {
      break;
    }
    characters += length;
    lines += eventLines;
    fieldsTruncated ||= clipped;
    events.unshift(event);
  }
  const omitted = matching.length - events.length;
  const active = owner.activeTab();
  const identity =
    active && !active.page.isClosed()
      ? await pageDetails(active.page, owner)
      : undefined;
  const dropped = owner.diagnosticDropCount();
  return success(
    {
      ok: true,
      ...owner.contextState(),
      ...(identity ? { page: identity } : {}),
      events,
      dropped,
      omitted,
      truncated: fieldsTruncated || dropped > 0 || omitted > 0,
    },
    {
      mode: "diagnostics",
      records: events.length,
      ...identity,
      dropped,
      omitted,
    },
  );
}
async function tabs(
  owner: BrowserOwner,
): Promise<BrowserResult<ObservationSuccess>> {
  const active = owner.activeTab()?.id;
  const items = await Promise.all(
    owner.liveTabs().map(async (tab) => ({
      id: tab.id,
      title: bounded(
        owner.redactText(await tab.page.title().catch(() => "")),
        LIMITS.titleChars,
      ),
      url: bounded(
        owner.redactText(sanitizeUrl(tab.page.url())),
        LIMITS.urlChars,
      ),
      active: tab.id === active,
    })),
  );
  return success(
    { ok: true, ...owner.contextState(), tabs: items, truncated: false },
    { mode: "tabs", tabs: items, activeTabId: active },
  );
}
export function truncate(value: string, chars: number, lines: number) {
  return truncateValue(value, chars, lines, false);
}
export function truncateSnapshot(value: string, chars: number, lines: number) {
  return truncateValue(value, chars, lines, true);
}
function truncateValue(
  value: string,
  chars: number,
  lines: number,
  protectRefs: boolean,
) {
  const sourceLines = value.split("\n");
  const points = Array.from(sourceLines.slice(0, lines).join("\n"));
  let end = Math.min(
    points.length,
    points.length > chars ? Math.max(0, chars - 1) : chars,
  );
  if (protectRefs && end < points.length) {
    const before = points.slice(0, end);
    const tokenStart = before.lastIndexOf("[");
    if (
      tokenStart >= 0 &&
      points.slice(tokenStart, tokenStart + 5).join("") === "[ref=" &&
      !before.slice(tokenStart).includes("]")
    ) {
      end = tokenStart;
    }
  }
  const clipped = points.slice(0, end).join("");
  const truncated = clipped !== value;
  const text = truncated
    ? `${Array.from(clipped)
        .slice(0, Math.max(0, chars - 1))
        .join("")}…`
    : clipped;
  return {
    text,
    details: {
      originalCharacters: Array.from(value).length,
      returnedCharacters: Array.from(text).length,
      originalLines: sourceLines.length,
      returnedLines: text ? text.split("\n").length : 0,
      truncated,
    },
  };
}
