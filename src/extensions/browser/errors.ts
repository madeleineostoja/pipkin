import { createRequire } from "node:module";
import type { BrowserFailure, BrowserResult } from "./results.js";

export const BROWSER_STATE_LOSS_NOTICE =
  "Browser context was recreated; prior tabs, refs, and diagnostics were lost.";

export type BrowserErrorCategory =
  | "installation"
  | "launch"
  | "cancelled"
  | "target"
  | "stale_ref"
  | "timeout"
  | "page_gone"
  | "uncertain_outcome"
  | "browser_disconnected"
  | "content"
  | "backend";

type ErrorContext = {
  dispatched?: boolean;
  mutation?: boolean;
  /** Input text was supplied to a keyboard/form action and must never reach output. */
  redactCause?: boolean;
};

const require = createRequire(import.meta.url);
const playwrightVersion =
  (require("playwright-core/package.json") as { version?: string }).version ??
  "installed";

/** A bounded, stable owner error, converted directly to native structured failures. */
export class BrowserError extends Error {
  constructor(
    readonly category: BrowserErrorCategory,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "BrowserError";
  }
}

export function failureResult(
  error: BrowserError,
): BrowserResult<BrowserFailure> {
  const payload: BrowserFailure = {
    ok: false,
    error: { code: error.category, message: bounded(error.message) },
    generation:
      typeof error.details.generation === "number"
        ? error.details.generation
        : 0,
    stateLost: error.details.stateLost === true,
    ...(typeof error.details.cause === "string"
      ? { cause: bounded(error.details.cause) }
      : {}),
    ...(typeof error.details.recovery === "string" ||
    error.details.stateLost === true
      ? {
          recovery: bounded(
            [
              error.details.stateLost === true ? BROWSER_STATE_LOSS_NOTICE : "",
              typeof error.details.recovery === "string"
                ? error.details.recovery
                : "",
            ]
              .filter(Boolean)
              .join(" "),
          ),
        }
      : {}),
  };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
    details: { category: error.category, ...payload },
  };
}

export function browserError(
  error: unknown,
  context: ErrorContext = {},
): BrowserError {
  if (error instanceof BrowserError) {
    if (
      context.dispatched &&
      context.mutation &&
      error.category !== "target" &&
      error.category !== "stale_ref"
    ) {
      return uncertain(error, context.redactCause);
    }
    return error;
  }
  const message =
    error instanceof Error ? error.message : "Browser backend failed.";
  if (context.dispatched && context.mutation) {
    return uncertain(message, context.redactCause);
  }
  if (/executable doesn't exist|executable.*not found/i.test(message)) {
    return new BrowserError(
      "installation",
      `Chromium is unavailable for Playwright ${playwrightVersion}. Repair Pipkin's npm installation: permit @playwright/browser-chromium's standard install lifecycle, then npm rebuild @playwright/browser-chromium to populate its managed cache.`,
    );
  }
  if (/browserType\.launch|failed to launch/i.test(message)) {
    return new BrowserError(
      "launch",
      "Chromium could not start. Check platform dependencies or the host sandbox, then observe again after repair.",
      { cause: bounded(message) },
    );
  }
  if (/browser.*disconnected|connection closed/i.test(message)) {
    return new BrowserError(
      "browser_disconnected",
      "Browser disconnected; observe again to start a fresh isolated context.",
      { cause: bounded(message) },
    );
  }
  if (
    /Target page, context or browser has been closed|browser has been closed|has been closed/i.test(
      message,
    )
  ) {
    return new BrowserError(
      "page_gone",
      "Browser page is no longer available; observe the current tabs.",
      { cause: bounded(message) },
    );
  }
  if (/Timeout|timed out/i.test(message)) {
    return new BrowserError(
      "timeout",
      "Browser operation timed out; observe the page before retrying.",
      { cause: bounded(message) },
    );
  }
  return new BrowserError("backend", bounded(message), {
    cause: bounded(message),
  });
}

function uncertain(
  error: BrowserError | string,
  redactCause = false,
): BrowserError {
  const cause = typeof error === "string" ? error : error.message;
  return new BrowserError(
    "uncertain_outcome",
    "Browser action may have completed before it failed; observe the page, but do not replay the action automatically.",
    { cause: redactCause ? "Sensitive text action failed." : bounded(cause) },
  );
}
function bounded(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const code = character.codePointAt(0)!;
      return (code >= 32 && code !== 127) || "\t\n\r".includes(character);
    })
    .slice(0, 1_000)
    .join("");
}
