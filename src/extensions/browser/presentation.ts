import type { BrowserActInput, Target, WaitCondition } from "./schema.js";

const SUMMARY_LIMIT = 120;

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
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return bounded(url.toString());
  } catch {
    return bounded(value);
  }
}

function bounded(value: string): string {
  return Array.from(value).slice(0, SUMMARY_LIMIT).join("");
}
