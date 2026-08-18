import { toolResultRenderer } from "#lib/ui/tool-result-renderer";
import { bounded, sanitizeUrl } from "./owner.js";

function details(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function first(content: unknown): string {
  return Array.isArray(content)
    ? (content.find(
        (entry): entry is { type: "text"; text: string } =>
          typeof entry === "object" &&
          entry !== null &&
          (entry as { type?: unknown }).type === "text" &&
          typeof (entry as { text?: unknown }).text === "string",
      )?.text ?? "")
    : "";
}
function context(value: Record<string, unknown>): string {
  if (typeof value.title === "string" && value.title) {
    return bounded(value.title, 120);
  }
  if (typeof value.url === "string") {
    return origin(value.url);
  }
  if (typeof value.activeTabId === "string") {
    return value.activeTabId;
  }
  return "current tab";
}
function origin(url: string): string {
  try {
    return new URL(sanitizeUrl(url)).origin;
  } catch {
    return "current tab";
  }
}

export const renderBrowserObserveResult = toolResultRenderer({
  summary(result) {
    const value = details(result.details);
    if (value.mode === "screenshot") {
      return `Screenshot · ${context(value)} · ${value.width}×${value.height} · ${value.bytes} bytes`;
    }
    if (value.mode === "tabs") {
      return `Tabs · ${Array.isArray(value.tabs) ? value.tabs.length : 0} · ${typeof value.activeTabId === "string" ? value.activeTabId : "current tab"}`;
    }
    const count =
      typeof value.returnedCharacters === "number"
        ? `${value.returnedCharacters} characters`
        : typeof value.records === "number"
          ? `${value.records} records`
          : "complete";
    return `${value.mode ?? "Observation"} · ${context(value)} · ${count}`;
  },
  partial(result) {
    return `${details(result.details).phase ?? "Observing"}…`;
  },
  error(result) {
    return (
      first(result.content).split("\n", 1)[0] || "Browser observation failed."
    );
  },
});

export const renderBrowserActResult = toolResultRenderer({
  summary(result) {
    const value = details(result.details);
    return `${value.action ?? "Browser action"} · ${typeof value.activeTabId === "string" ? value.activeTabId : context(value)} · ${value.outcome ?? "complete"}`;
  },
  partial(result) {
    return `${details(result.details).phase ?? "Navigating"}…`;
  },
  error(result) {
    return first(result.content).split("\n", 1)[0] || "Browser action failed.";
  },
});
