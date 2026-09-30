import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { toolCallRenderer } from "#lib/ui/tool-result-renderer";
import { act } from "./act.js";
import { browserError, failureResult } from "./errors.js";
import { observe } from "./observe.js";
import type { BrowserOwner } from "./owner.js";
import { actionSummary, targetSummary, urlSummary } from "./presentation.js";
import {
  renderBrowserActResult,
  renderBrowserObserveResult,
} from "./result-renderer.js";
import {
  actionOutput,
  observationOutputs,
  type BrowserResult,
} from "./results.js";
import {
  actionParameters,
  observationParameters,
  normalizeAct,
  normalizeObserve,
  type Action,
  type Observation,
} from "./schema.js";

const namespace = {
  name: "browser",
  description:
    "Bounded observations and strict interactions in one isolated rendered browser session.",
};
const observationDescriptions: Record<Observation, string> = {
  snapshot:
    "Capture a bounded AI accessibility snapshot with opaque actionable refs. Use these strict generation-bound refs or semantic targets with Browser operations; snapshot again after document/tab changes.",
  screenshot:
    "Capture a bounded native PNG of the viewport (default), full page, or strict target. In codemode explicitly forward the image with image(result.image); do not print the base64 JSON payload.",
  text: "Read bounded rendered inner text of the active page or one strict target; not source HTML or article extraction.",
  element:
    "Inspect one strict element: bounded redacted HTML/text, tag, role/name/attributes when available, form state, visibility, box and styles.",
  diagnostics:
    "Read bounded category-specific browser diagnostic events with dropped/omitted counts; does not clear records or launch Chromium.",
  tabs: "List live isolated browser tabs with opaque IDs, bounded sanitized URLs/titles and active markers; does not launch Chromium.",
};
const actionDescriptions: Record<Action, string> = {
  navigate:
    "Navigate the active tab to a credential-free HTTP(S) URL and return compact page identity. Call browser_snapshot explicitly to inspect rendered state.",
  history:
    "Go back/forward or reload the active page; returns compact identity without an implicit snapshot.",
  click:
    "Click one strict snapshot ref or semantic target, without force or replay.",
  hover:
    "Hover one strict snapshot ref or semantic target, without force or replay.",
  set_checked:
    "Set one strict target's checked state using Playwright actionability, without force or replay.",
  fill: "Fill one strict target with bounded text; supplied text is never echoed in Browser results.",
  type: "Type bounded text sequentially into one strict target; supplied text is never echoed in Browser results.",
  press: "Press a bounded key on the active page or one strict target.",
  select:
    "Select existing options on one strict target; values are not echoed in the result.",
  scroll:
    "Scroll the viewport or one strict target by bounded non-zero CSS-pixel deltas.",
  wait: "Wait for a closed structured rendered-state condition; timeout is an error, not a fixed sleep or action retry.",
  viewport:
    "Apply bounded viewport dimensions and return applied size and compact page identity.",
  open_tab:
    "Create and activate an isolated tab, optionally navigating to HTTP(S); return its ID and compact page identity.",
  switch_tab:
    "Activate an existing opaque tab ID from browser_tabs; return compact active page identity.",
  close_tab:
    "Close an existing opaque tab ID and return active page identity. Closing the last tab opens a fresh blank page.",
};
async function execute(
  owner: BrowserOwner,
  signal: AbortSignal | undefined,
  operation: () => Promise<BrowserResult>,
): Promise<BrowserResult> {
  let result: BrowserResult;
  try {
    result = await owner.run(signal, operation);
  } catch (error) {
    result = failureResult(browserError(error));
  }
  // Acknowledge only the delivered result, after the lane's final cancellation check.
  if (
    result.structuredContent.stateLost &&
    result.structuredContent.generation === owner.contextState().generation
  ) {
    owner.consumeStateLossNotice();
  }
  return result;
}
export function registerBrowserOperations(
  pi: ExtensionAPI,
  owner: BrowserOwner,
): void {
  for (const mode of Object.keys(observationParameters) as Observation[]) {
    const name = `browser_${mode}`;
    pi.registerTool({
      name,
      exposure: "deferred",
      namespace,
      annotations: { readOnlyHint: true, openWorldHint: true },
      label: `Browser ${mode}`,
      description: observationDescriptions[mode],
      parameters: observationParameters[mode],
      outputSchema: observationOutputs[mode],
      renderCall: toolCallRenderer({
        name,
        detail: (input) => {
          const request = normalizeObserve(mode, input);
          return request.target ? targetSummary(request.target) : mode;
        },
        pending: "Observing rendered page…",
      }),
      execute: (_id, input, signal) =>
        execute(owner, signal, () =>
          observe(owner, normalizeObserve(mode, input)),
        ),
      renderResult: renderBrowserObserveResult,
    });
  }
  for (const action of Object.keys(actionParameters) as Action[]) {
    const name = `browser_${action}`;
    pi.registerTool({
      name,
      exposure: "deferred",
      namespace,
      annotations: { readOnlyHint: action === "wait", openWorldHint: true },
      label: `Browser ${action.replaceAll("_", " ")}`,
      description: `${actionDescriptions[action]} Use strict refs from browser_snapshot or semantic targets. A dispatched uncertain/state-lost action is never replayed; observing afterward is not permission to retry.`,
      parameters: actionParameters[action],
      outputSchema: actionOutput,
      renderCall: toolCallRenderer({
        name,
        detail: (input) => {
          const request = normalizeAct(action, input);
          return request.url
            ? urlSummary(request.url)
            : (request.tabId ?? actionSummary(request) ?? request.action);
        },
        pending: "Updating browser…",
      }),
      execute: (_id, input, signal) =>
        execute(owner, signal, () => act(owner, normalizeAct(action, input))),
      renderResult: renderBrowserActResult,
    });
  }
}
