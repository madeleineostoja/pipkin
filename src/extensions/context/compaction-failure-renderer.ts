import type { EntryRenderer } from "@earendil-works/pi-coding-agent";
import { Box } from "@earendil-works/pi-tui";
import {
  toolCallRenderer,
  toolResultRenderer,
} from "#lib/ui/tool-result-renderer";
import type { NativeFailureOutcome } from "./compaction.ts";

export const COMPACTION_FAILURE_ENTRY_TYPE =
  "pipkin.context.compaction-failure.v1";

export type CompactionFailureEntry = {
  reason: string;
  outcome: NativeFailureOutcome;
};

const renderCompactionCall = toolCallRenderer<CompactionFailureEntry>({
  name: "Context compaction",
  detail: () => "· OpenAI Codex",
});

const renderCompactionResult = toolResultRenderer({
  summary: (result) => {
    const data = result.details as CompactionFailureEntry;
    return `Native compaction failed: ${data.reason}. ${outcomeText(data.outcome)}`;
  },
  tone: (result) =>
    (result.details as CompactionFailureEntry).outcome === "cancelled"
      ? "error"
      : "warning",
});

export const renderCompactionFailureEntry: EntryRenderer<
  CompactionFailureEntry
> = (entry, options, theme) => {
  if (!isCompactionFailureEntry(entry.data)) {
    return undefined;
  }
  const background =
    entry.data.outcome === "cancelled" ? "toolErrorBg" : "toolPendingBg";
  const box = new Box(1, 1, (text) => theme.bg(background, text));
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
  if (!value || typeof value !== "object") {
    return false;
  }
  const reason = (value as Partial<CompactionFailureEntry>).reason;
  return (
    typeof reason === "string" &&
    reason.length > 0 &&
    reason.length <= 120 &&
    !/\p{C}/u.test(reason) &&
    ["models-low", "pi", "cancelled"].includes(
      (value as Partial<CompactionFailureEntry>).outcome ?? "",
    )
  );
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
