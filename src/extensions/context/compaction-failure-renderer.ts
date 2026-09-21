import type { EntryRenderer } from "@earendil-works/pi-coding-agent";
import { Box } from "@earendil-works/pi-tui";
import {
  toolCallRenderer,
  toolResultRenderer,
} from "#lib/ui/tool-result-renderer";
import type { NativeFailureOutcome } from "./compaction.ts";

export const COMPACTION_FAILURE_ENTRY_TYPE =
  "pipkin.context.compaction-failure.v1";

export type NativeCompactionFailureEntry = {
  reason: string;
  outcome: NativeFailureOutcome;
};

export type TerminalCompactionFailureEntry = {
  terminal: true;
  trigger: "manual" | "threshold" | "overflow";
  aborted: boolean;
  willRetry: boolean;
  fromExtension: boolean;
};

export type CompactionFailureEntry =
  | NativeCompactionFailureEntry
  | TerminalCompactionFailureEntry;

const renderCompactionCall = toolCallRenderer<CompactionFailureEntry>({
  name: "Context compaction",
  detail: (data) =>
    isTerminalFailure(data)
      ? `· ${data.trigger} · ${data.fromExtension ? "extension summary" : "Pi summary"}`
      : "· OpenAI Codex",
});

const renderCompactionResult = toolResultRenderer({
  summary: (result) => failureSummary(result.details as CompactionFailureEntry),
  tone: (result) =>
    isTerminalFailure(result.details)
      ? "error"
      : (result.details as NativeCompactionFailureEntry).outcome === "cancelled"
        ? "error"
        : "warning",
});

export const renderCompactionFailureEntry: EntryRenderer<
  CompactionFailureEntry
> = (entry, options, theme) => {
  if (!isCompactionFailureEntry(entry.data)) {
    return undefined;
  }
  const isError =
    isTerminalFailure(entry.data) || entry.data.outcome === "cancelled";
  const box = new Box(1, 1, (text) =>
    theme.bg(isError ? "toolErrorBg" : "toolPendingBg", text),
  );
  box.addChild(
    renderCompactionCall(entry.data, theme, {
      isPartial: false,
      state: { hasToolOutput: true },
    }),
  );
  box.addChild(
    renderCompactionResult(
      { content: [], details: entry.data },
      { expanded: options.expanded, isPartial: false },
      theme,
    ),
  );
  return box;
};

function isCompactionFailureEntry(
  value: unknown,
): value is CompactionFailureEntry {
  return isTerminalFailure(value) || isNativeFailure(value);
}

function isNativeFailure(
  value: unknown,
): value is NativeCompactionFailureEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const reason = (value as Partial<NativeCompactionFailureEntry>).reason;
  return (
    typeof reason === "string" &&
    reason.length > 0 &&
    reason.length <= 120 &&
    !/\p{C}/u.test(reason) &&
    ["models-low", "pi", "cancelled"].includes(
      (value as Partial<NativeCompactionFailureEntry>).outcome ?? "",
    )
  );
}

function isTerminalFailure(
  value: unknown,
): value is TerminalCompactionFailureEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const data = value as Partial<TerminalCompactionFailureEntry>;
  return (
    data.terminal === true &&
    ["manual", "threshold", "overflow"].includes(data.trigger ?? "") &&
    typeof data.aborted === "boolean" &&
    typeof data.willRetry === "boolean" &&
    typeof data.fromExtension === "boolean"
  );
}

function failureSummary(data: CompactionFailureEntry): string {
  if (isTerminalFailure(data)) {
    const status = data.aborted ? "aborted" : "failed";
    const retry = data.willRetry
      ? " The interrupted turn would have retried after successful compaction."
      : "";
    return `Compaction ${status}; no checkpoint was saved.${retry}`;
  }
  return `Native compaction failed: ${data.reason}. ${outcomeText(data.outcome)}`;
}

function outcomeText(outcome: NativeFailureOutcome): string {
  switch (outcome) {
    case "models-low":
      return "Using the models.low textual fallback.";
    case "pi":
      return "Falling back to Pi's active-model compaction.";
    case "cancelled":
      return "Compaction was cancelled.";
  }
}
