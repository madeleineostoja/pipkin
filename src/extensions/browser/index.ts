import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { toolCallRenderer } from "#lib/ui/tool-result-renderer";
import { act } from "./act.js";
import { observe } from "./observe.js";
import { BrowserOwner } from "./owner.js";
import { actionSummary, targetSummary, urlSummary } from "./presentation.js";
import {
  renderBrowserActResult,
  renderBrowserObserveResult,
} from "./result-renderer.js";
import {
  BrowserActParameters,
  BrowserObserveParameters,
  normalizeAct,
  normalizeObserve,
  type BrowserActInput,
  type BrowserObserveInput,
} from "./schema.js";

export default function (pi: ExtensionAPI): void {
  const owner = new BrowserOwner();
  pi.registerTool({
    name: "browser_observe",
    label: "Browser Observe",
    description:
      "Inspect the active rendered browser tab. Use snapshot to get AI refs, then observe a ref or semantic target; screenshots return a native PNG image. Browser state is isolated to this session and refs can become stale after page changes.",
    parameters: BrowserObserveParameters,
    renderCall: toolCallRenderer({
      name: "browser_observe",
      detail: (input: BrowserObserveInput) =>
        `${input.mode}${input.target ? ` · ${targetSummary(input.target)}` : ""}`,
      pending: "Observing rendered page…",
    }),
    async execute(_id, input: BrowserObserveInput, signal, onUpdate) {
      const request = normalizeObserve(input);
      onUpdate?.({
        content: [{ type: "text", text: "Observing browser…" }],
        details: { phase: "observing" },
      });
      return owner.run(signal, () => observe(owner, request));
    },
    renderResult: renderBrowserObserveResult,
  });
  pi.registerTool({
    name: "browser_act",
    label: "Browser Act",
    description:
      "Navigate, interact with strict snapshot refs or semantic targets, scroll, wait for structured rendered state, and manage isolated tabs. Observe first for refs, act without force or replay, then observe after page-changing actions or uncertain outcomes.",
    parameters: BrowserActParameters,
    renderCall: toolCallRenderer({
      name: "browser_act",
      detail: (input) => {
        const summary = actionSummary(input as BrowserActInput);
        return `${input.action}${input.url ? ` · ${urlSummary(input.url)}` : input.tabId ? ` · ${input.tabId}` : summary ? ` · ${summary}` : ""}`;
      },
      pending: "Updating browser…",
    }),
    async execute(_id, input: BrowserActInput, signal, onUpdate) {
      const request = normalizeAct(input);
      onUpdate?.({
        content: [{ type: "text", text: "Navigating browser…" }],
        details: { phase: "navigating" },
      });
      return owner.run(signal, () => act(owner, request));
    },
    renderResult: renderBrowserActResult,
  });
  pi.on("session_start", () => owner.reset());
  pi.on("session_shutdown", () => owner.shutdown());
}
