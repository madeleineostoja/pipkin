import type { BrowserActInput, Target, WaitCondition } from "./schema.js";

const SUMMARY_LIMIT = 120;

/** Rendering sees streaming/invalid arguments too; never validate or echo form values. */
export function callSummary(operation: string, input: unknown): string {
  const fields = record(input);
  if (
    (operation === "navigate" || operation === "open_tab") &&
    typeof fields.url === "string"
  ) {
    return urlSummary(fields.url);
  }
  if (
    (operation === "switch_tab" || operation === "close_tab") &&
    typeof fields.tabId === "string"
  ) {
    return bounded(fields.tabId);
  }
  if (operation === "history" && typeof fields.action === "string") {
    return bounded(fields.action);
  }
  const target = record(fields.target);
  if (typeof target.kind === "string" && typeof target.value === "string") {
    return `${bounded(target.kind)}:${bounded(target.value)}`;
  }
  const condition = record(fields.condition);
  if (operation === "wait" && typeof condition.kind === "string") {
    return `wait:${bounded(condition.kind)}`;
  }
  return operation;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function targetSummary(target: Target): string {
  return `${target.kind}:${bounded(target.value)}`;
}

export function actionSummary(input: BrowserActInput): string | undefined {
  if (input.target) {
    return targetSummary(input.target);
  }
  if (input.action === "wait" && input.condition) {
    return waitConditionSummary(input.condition);
  }
  return undefined;
}

export function waitConditionSummary(condition: WaitCondition): string {
  switch (condition.kind) {
    case "url":
      return `url:${urlSummary(condition.value)}`;
    case "text":
      return `text:${bounded(condition.value)}`;
    case "target":
      return `target:${targetSummary(condition.target)} · ${condition.state}`;
    case "load_state":
      return `load_state:${condition.state}`;
  }
}

export function urlSummary(value: string): string {
  const normalized = value.trimStart();
  if (normalized.startsWith("//")) {
    try {
      return summarizeAbsolute(new URL(`http:${normalized}`)).slice(
        "http:".length,
      );
    } catch {
      return "//[invalid]";
    }
  }
  try {
    return summarizeAbsolute(new URL(normalized));
  } catch {
    if (/^[a-z][a-z\d+.-]*:/iu.test(normalized)) {
      return "[invalid URL]";
    }
    // Wait URL values may be relative. They still must not expose query or
    // fragment data in call rows or compact results.
    const [path] = normalized.split(/[?#]/u, 1);
    return bounded(path || "/");
  }
}

function summarizeAbsolute(url: URL): string {
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return bounded(url.toString());
}

function bounded(value: string): string {
  return Array.from(value).slice(0, SUMMARY_LIMIT).join("");
}
