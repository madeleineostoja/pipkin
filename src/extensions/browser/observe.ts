import type { Page } from "playwright-core";
import { BrowserError, browserError } from "./errors.js";
import { LIMITS } from "./limits.js";
import { bounded, type BrowserOwner, sanitizeUrl } from "./owner.js";
import type { BrowserObserveInput } from "./schema.js";
import { strictTarget } from "./target.js";

type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: "image/png" };
export type BrowserResult = {
  content: Content[];
  details: Record<string, unknown>;
};

export async function observe(
  owner: BrowserOwner,
  input: BrowserObserveInput,
): Promise<BrowserResult> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await observeOnce(owner, input);
    } catch (error) {
      const normalized = browserError(error);
      if (attempt === 0 && normalized.category === "browser_disconnected") {
        continue;
      }
      throw normalized;
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
): Promise<BrowserResult> {
  // Tabs and diagnostics are observations of a usable session too: establish it first.
  const page = await owner.page();
  switch (input.mode) {
    case "tabs":
      return tabs(owner);
    case "diagnostics":
      return diagnostics(owner, input, page);
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

export async function snapshot(
  page: Page,
  input: BrowserObserveInput,
  owner?: BrowserOwner,
): Promise<BrowserResult> {
  const root = input.target
    ? await strictTarget(page, input.target)
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
          "Browser ref is stale; observe again for fresh refs.",
        )
      : error;
  }
  const clipped = truncateSnapshot(
    value,
    LIMITS.snapshotChars,
    LIMITS.outputLines,
  );
  return result(
    clipped.text,
    page,
    {
      mode: "snapshot",
      scope: input.target ? input.target.kind : "page",
      depth: input.depth ?? LIMITS.defaultSnapshotDepth,
      boxes: input.boxes ?? false,
      ...clipped.details,
    },
    owner,
  );
}

async function screenshot(
  page: Page,
  input: BrowserObserveInput,
  owner: BrowserOwner,
): Promise<BrowserResult> {
  const target = input.target
    ? await strictTarget(page, input.target)
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
    dimensions.width > LIMITS.screenshotWidth ||
    dimensions.height > LIMITS.screenshotHeight
  ) {
    throw new BrowserError(
      "content",
      "Screenshot exceeds the 4,096×12,000 CSS-pixel limit; use a viewport or element screenshot.",
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
  const details = {
    mode: "screenshot",
    ...(await pageDetails(page)),
    scope: target
      ? input.target!.kind
      : input.fullPage
        ? "full_page"
        : "viewport",
    width: Math.ceil(dimensions.width),
    height: Math.ceil(dimensions.height),
    bytes: image.byteLength,
    ...owner.contextState(),
  };
  return {
    content: [
      {
        type: "text",
        text: `PNG screenshot · ${details.width}×${details.height} · ${details.bytes} bytes`,
      },
      { type: "image", data: image.toString("base64"), mimeType: "image/png" },
    ],
    details,
  };
}

async function text(
  page: Page,
  input: BrowserObserveInput,
  owner: BrowserOwner,
): Promise<BrowserResult> {
  const root = input.target
    ? await strictTarget(page, input.target)
    : page.locator("body");
  const clipped = truncate(
    await root.innerText(),
    LIMITS.textChars,
    LIMITS.outputLines,
  );
  return result(
    clipped.text,
    page,
    {
      mode: "text",
      scope: input.target ? input.target.kind : "page",
      ...clipped.details,
    },
    owner,
  );
}

async function element(
  page: Page,
  input: BrowserObserveInput,
  owner: BrowserOwner,
): Promise<BrowserResult> {
  const locator = await strictTarget(page, input.target!);
  const html = truncate(
    await locator.evaluate((node) => node.outerHTML),
    LIMITS.elementHtmlChars,
    Number.MAX_SAFE_INTEGER,
  );
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
      text: element.innerText,
      value: element.value,
      checked: element.checked,
      disabled: element.disabled,
      styles: Object.fromEntries(
        [...base, ...properties].map((name) => [
          name,
          styles.getPropertyValue(name),
        ]),
      ),
    };
  }, input.styleProperties ?? []);
  const clippedText = truncate(
    inspected.text,
    LIMITS.textChars,
    LIMITS.outputLines,
  );
  const styles = Object.fromEntries(
    Object.entries(inspected.styles).map(([name, value]) => [
      name,
      bounded(value, LIMITS.styleValueChars),
    ]),
  );
  const box = await locator.boundingBox();
  return result(
    [`HTML:\n${html.text}`, `Text:\n${clippedText.text}`].join("\n\n"),
    page,
    {
      mode: "element",
      target: input.target!.kind,
      outerHtml: html.text,
      value:
        typeof inspected.value === "string"
          ? bounded(inspected.value, LIMITS.elementValueChars)
          : undefined,
      checked: inspected.checked,
      disabled: inspected.disabled,
      visible: await locator.isVisible(),
      box,
      styles,
      html: html.details,
      text: clippedText.details,
    },
    owner,
  );
}

function diagnostics(
  owner: BrowserOwner,
  input: BrowserObserveInput,
  page: Page,
): BrowserResult {
  const categories = input.categories ? new Set(input.categories) : undefined;
  const records = owner
    .getDiagnostics()
    .filter((entry) => !categories || categories.has(entry.category))
    .slice(-LIMITS.diagnosticResult);
  const lines = records.map(
    (entry) =>
      `${entry.sequence} ${entry.category} [${entry.tabId}] ${entry.message}${entry.url ? ` · ${entry.url}` : ""}`,
  );
  const clipped = truncate(
    lines.join("\n"),
    LIMITS.diagnosticChars,
    LIMITS.outputLines,
  );
  return {
    content: [
      {
        type: "text",
        text: clipped.text || "No matching browser diagnostics.",
      },
    ],
    details: {
      mode: "diagnostics",
      records: records.length,
      url: sanitizeUrl(page.url()),
      ...owner.contextState(),
      ...clipped.details,
    },
  };
}

async function tabs(owner: BrowserOwner): Promise<BrowserResult> {
  const active = owner.activeTab()?.id;
  const items = await Promise.all(
    owner.liveTabs().map(async (tab) => ({
      id: tab.id,
      title: tab.page.isClosed()
        ? ""
        : bounded(await tab.page.title().catch(() => ""), LIMITS.titleChars),
      url: tab.page.isClosed() ? "about:blank" : sanitizeUrl(tab.page.url()),
      active: tab.id === active,
    })),
  );
  return {
    content: [
      {
        type: "text",
        text:
          items
            .map((item) => `${item.active ? "*" : " "} ${item.id} ${item.url}`)
            .join("\n") || "No tabs.",
      },
    ],
    details: { mode: "tabs", tabs: items, ...owner.contextState() },
  };
}

async function result(
  text: string,
  page: Page,
  details: Record<string, unknown>,
  owner?: BrowserOwner,
): Promise<BrowserResult> {
  return {
    content: [{ type: "text", text }],
    details: {
      ...(await pageDetails(page)),
      ...details,
      ...owner?.contextState(),
    },
  };
}
async function pageDetails(
  page: Page,
): Promise<{ url: string; title: string }> {
  return {
    url: sanitizeUrl(page.url()),
    title: bounded(await page.title().catch(() => ""), LIMITS.titleChars),
  };
}

export function truncate(
  value: string,
  chars: number,
  lines: number,
): { text: string; details: Record<string, number | boolean> } {
  const originalCharacters = Array.from(value).length;
  const sourceLines = value.split("\n");
  const lineLimited = sourceLines.slice(0, lines).join("\n");
  const clipped = clipCharacters(lineLimited, chars, false);
  const truncated = clipped !== value;
  const text = truncated ? addMarker(clipped, chars) : clipped;
  return truncation(text, sourceLines, originalCharacters, truncated);
}

export function truncateSnapshot(
  value: string,
  chars: number,
  lines: number,
): { text: string; details: Record<string, number | boolean> } {
  const sourceLines = value.split("\n");
  const lineLimited = sourceLines.slice(0, lines).join("\n");
  const clipped = clipCharacters(lineLimited, chars, true);
  const truncated = clipped !== value;
  const text = truncated ? addMarker(clipped, chars) : clipped;
  return truncation(text, sourceLines, Array.from(value).length, truncated);
}

function clipCharacters(
  value: string,
  chars: number,
  protectRefs: boolean,
): string {
  const points = Array.from(value);
  const limit = points.length > chars ? Math.max(0, chars - 1) : chars;
  let end = Math.min(points.length, limit);
  if (protectRefs && end < points.length) {
    const before = points.slice(0, end).join("");
    const tokenStart = before.lastIndexOf("[ref=");
    const tokenEnd = before.lastIndexOf("]");
    if (tokenStart > tokenEnd) {
      end = tokenStart;
    }
  }
  return points.slice(0, end).join("");
}
function addMarker(value: string, chars: number): string {
  return `${Array.from(value)
    .slice(0, Math.max(0, chars - 1))
    .join("")}…`;
}
function truncation(
  text: string,
  sourceLines: string[],
  originalCharacters: number,
  truncated: boolean,
) {
  return {
    text,
    details: {
      originalCharacters,
      returnedCharacters: Array.from(text).length,
      originalLines: sourceLines.length,
      returnedLines: text ? text.split("\n").length : 0,
      truncated,
    },
  };
}
