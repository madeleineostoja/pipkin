import { createRequire } from "node:module";

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

/** A bounded, stable tool error; Pi converts thrown errors to native failures. */
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

export function failureResult(error: BrowserError): {
  content: [{ type: "text"; text: string }];
  details: Record<string, unknown>;
} {
  const recovery =
    typeof error.details.recovery === "string"
      ? ` ${error.details.recovery}`
      : "";
  const stateLoss =
    error.details.stateLost === true ? `${BROWSER_STATE_LOSS_NOTICE}\n\n` : "";
  return {
    content: [
      {
        type: "text",
        text: `${stateLoss}Browser ${error.category}: ${error.message}${recovery}`,
      },
    ],
    details: { category: error.category, ...error.details },
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
      `Chromium is unavailable for Playwright ${playwrightVersion}. Repair Pipkin's normal npm installation (npm install or npm rebuild) so @playwright/browser-chromium can populate its managed cache.`,
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
    "Browser action may have completed before it failed; observe the page before retrying.",
    { cause: redactCause ? "Sensitive text action failed." : bounded(cause) },
  );
}
function bounded(value: string): string {
  return Array.from(value).slice(0, 1_000).join("");
}
