import { Defuddle, type DefuddleResponse } from "defuddle/node";
import { parseHTML } from "linkedom";
import { captureConsole } from "./console-capture.js";
import { assertActive, type Deadline } from "./cancellation.js";
import type { WebTransport } from "./transport.js";
import { WebError } from "./errors.js";

export type ExtractedPage = {
  content: string;
  title?: string;
  site?: string;
  published?: string;
};

type ExtractionDependencies = {
  transport: WebTransport;
  parentSignal?: AbortSignal;
  deadline: Deadline;
  defuddle?: typeof Defuddle;
};

export async function extractHtml(
  html: string,
  url: string,
  dependencies: ExtractionDependencies,
): Promise<ExtractedPage> {
  assertActive(dependencies.deadline, dependencies.parentSignal);
  const { document } = parseHTML(html);
  assertActive(dependencies.deadline, dependencies.parentSignal);
  let nestedFailure: unknown;
  assertActive(dependencies.deadline, dependencies.parentSignal);
  let extracted: DefuddleResponse;
  try {
    // Defuddle logs some caught failures directly; keep those out of Pi's TUI.
    extracted = (
      await captureConsole(() =>
        (dependencies.defuddle ?? Defuddle)(document, url, {
          markdown: true,
          separateMarkdown: false,
          removeImages: true,
          includeReplies: "extractors",
          fetch: async (request, init) => {
            try {
              return await dependencies.transport.fetch(
                request,
                init,
                dependencies.parentSignal,
                dependencies.deadline,
              );
            } catch (error) {
              nestedFailure ??= error;
              throw error;
            }
          },
        }),
      )
    ).value;
  } catch {
    assertActive(dependencies.deadline, dependencies.parentSignal);
    extracted = { content: "" } as DefuddleResponse;
  }
  assertActive(dependencies.deadline, dependencies.parentSignal);
  if (nestedFailure) {
    throw nestedFailure;
  }
  const content = extracted.content;
  if (useful(content)) {
    return {
      content,
      title: optional(extracted.title),
      site: optional(extracted.site),
      published: optional(extracted.published),
    };
  }
  const fallback = fallbackContent(html, dependencies);
  if (!useful(fallback)) {
    throw new WebError(
      "extract",
      "Web Fetch could not find readable content; the page may require JavaScript.",
    );
  }
  return {
    content: fallback,
    title: optional(document.title),
  };
}

export function renderJson(text: string): string | undefined {
  try {
    return Array.from(JSON.stringify(JSON.parse(text), undefined, 2))
      .map((character) => {
        const code = character.codePointAt(0)!;
        return code >= 127 && code <= 159
          ? `\\u${code.toString(16).padStart(4, "0")}`
          : character;
      })
      .join("");
  } catch {
    return undefined;
  }
}

export function isHtml(contentType: string): boolean {
  return /(?:^|\/)html(?:;|$)|application\/xhtml\+xml/iu.test(contentType);
}

function fallbackContent(
  html: string,
  dependencies: ExtractionDependencies,
): string {
  assertActive(dependencies.deadline, dependencies.parentSignal);
  const { document } = parseHTML(html);
  for (const element of document.querySelectorAll(
    "script, style, noscript, template, [hidden], [aria-hidden='true']",
  )) {
    element.remove();
  }
  const text = (document.body.textContent ?? "").replace(/\s+/gu, " ").trim();
  assertActive(dependencies.deadline, dependencies.parentSignal);
  return text;
}

export function inspectHtml(
  html: string,
  url: string,
  dependencies: Pick<ExtractionDependencies, "deadline" | "parentSignal">,
): { meta?: string } {
  assertActive(dependencies.deadline, dependencies.parentSignal);
  const { document } = parseHTML(html);
  const result = { meta: metaRefresh(document, url) };
  assertActive(dependencies.deadline, dependencies.parentSignal);
  return result;
}

export function metaRefresh(
  document: Document,
  url: string,
): string | undefined {
  const content = [...document.querySelectorAll("meta[http-equiv]")]
    .find(
      (meta) => meta.getAttribute("http-equiv")?.toLowerCase() === "refresh",
    )
    ?.getAttribute("content");
  const match = content?.match(/^\s*0(?:\.0*)?\s*;\s*url\s*=\s*(.+?)\s*$/iu);
  if (!match?.[1]) {
    return undefined;
  }
  try {
    return new URL(match[1].replace(/^['"]|['"]$/gu, ""), url).href;
  } catch {
    throw new WebError(
      "redirect",
      "Web Fetch received an invalid meta refresh target.",
    );
  }
}

function useful(value: string): boolean {
  const text = value
    .replace(/<[^>]*>/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return text.length > 0 && !loadingPlaceholder(text);
}

function loadingPlaceholder(value: string): boolean {
  return /^(?:loading(?:[ .…!]+| (?:app(?:lication)?|page|content))?|(?:please )?wait(?:[ .…!]+)?|(?:initiali[sz]ing|booting|starting)(?: (?:app(?:lication)?|page))?[ .…!]*|redirecting[ .…!]*|(?:enable|requires?) javascript[ .…!]*)$/iu.test(
    value,
  );
}

function optional(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned ? cleaned.slice(0, 300) : undefined;
}
