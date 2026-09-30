import type { EntryRenderer } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  type ElisionReason,
  type PruningMilestone,
  isPruningMilestone,
} from "./policy.ts";

const REASON_LABELS: Record<ElisionReason, string> = {
  "superseded-read": "superseded reads",
  "duplicate-read": "duplicate reads",
  "covered-read": "covered reads",
  "after-consumption-bash": "consumed bash",
  "standard-stale": "stale results",
};

export const renderPruningMilestone: EntryRenderer<PruningMilestone> = (
  entry,
  { expanded },
  theme,
) => {
  if (!isPruningMilestone(entry.data)) {
    return undefined;
  }
  const data = entry.data;
  const lines = [
    theme.fg(
      "muted",
      `Context pruned: ${tokenEstimate(data.estimatedTokensSaved)} tokens (${data.count} ${resultLabel(data.count)})`,
    ),
  ];
  if (expanded) {
    for (const reason of Object.keys(REASON_LABELS) as ElisionReason[]) {
      const count = data.reasons[reason];
      if (count) {
        lines.push(
          theme.fg(
            "dim",
            `  ${REASON_LABELS[reason]} · ${count} ${resultLabel(count)}`,
          ),
        );
      }
    }
  }
  return new Text(lines.join("\n"), 0, 0);
};

function resultLabel(count: number): string {
  return count === 1 ? "result" : "results";
}

function tokenEstimate(tokens: number): string {
  return tokens >= 1_000 ? `~${Math.round(tokens / 1_000)}k` : `~${tokens}`;
}
