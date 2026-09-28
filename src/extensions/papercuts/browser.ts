import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { promptForPermission } from "#lib/permission-prompt";
import { formatPapercutDetail, sortedPapercuts } from "./inspection.js";
import type { PapercutFile, PapercutStatus } from "./store.js";
import { createPapercutStatusController } from "./status.js";

const SUMMARY_LIMIT = 16_384;

type PapercutStatusController = ReturnType<
  typeof createPapercutStatusController
>;

export function formatPapercutSummary(file: PapercutFile): string {
  const records = sortedPapercuts(file);
  const lines = [
    `open (${records.filter((record) => record.status === "open").length})`,
    `closed (${records.filter((record) => record.status === "closed").length})`,
  ];
  let included = 0;
  for (const record of records) {
    const line = `- ${record.status} ${record.key}: ${record.title} (${record.occurrences})`;
    const candidate = [...lines, line].join("\n");
    if (Buffer.byteLength(candidate, "utf8") > SUMMARY_LIMIT) {
      break;
    }
    lines.push(line);
    included += 1;
  }
  const omitted = records.length - included;
  if (!omitted) {
    return lines.join("\n");
  }
  const suffix = `… ${omitted} record${omitted === 1 ? "" : "s"} omitted`;
  while (
    Buffer.byteLength([...lines, suffix].join("\n"), "utf8") > SUMMARY_LIMIT &&
    lines.length > 2
  ) {
    lines.pop();
    included -= 1;
  }
  return [
    ...lines,
    `… ${records.length - included} record${records.length - included === 1 ? "" : "s"} omitted`,
  ].join("\n");
}

async function browseStatus(
  ctx: ExtensionContext,
  status: PapercutStatus,
  controller: PapercutStatusController,
  pi: ExtensionAPI,
): Promise<boolean> {
  while (true) {
    const records = sortedPapercuts(
      await (await controller.storeFor(ctx)).load(),
      status,
    );
    const deleteClosed = "Delete all closed findings";
    const selected = await ctx.ui.select(
      `${status === "open" ? "Open" : "Closed"} papercuts`,
      [
        ...records.map((record) => `${record.key} — ${record.title}`),
        ...(status === "closed" && records.length ? [deleteClosed] : []),
        "Back",
      ],
    );
    if (!selected || selected === "Back") {
      return false;
    }
    if (selected === deleteClosed) {
      const confirmed = await ctx.ui.confirm(
        "Delete all closed findings?",
        `Permanently delete ${records.length} closed finding${records.length === 1 ? "" : "s"} and their occurrence history?`,
      );
      if (!confirmed) {
        continue;
      }
      try {
        const deleted = await (await controller.storeFor(ctx)).deleteClosed();
        ctx.ui.notify(
          `Deleted ${deleted} closed finding${deleted === 1 ? "" : "s"}.`,
          "info",
        );
        return false;
      } catch {
        ctx.ui.notify("Papercut cleanup failed.", "error");
        continue;
      }
    }
    const record = records.find((candidate) =>
      selected.startsWith(`${candidate.key} — `),
    );
    if (!record) {
      continue;
    }
    const action = await promptForPermission({
      ui: ctx.ui,
      title: record.title,
      detail: formatPapercutDetail(record),
      choices: [
        ...(status === "open"
          ? [{ value: "close", label: "Close Finding" }]
          : []),
        { value: "back", label: "Back" },
        { value: "discuss", label: "Discuss with agent" },
      ],
    });
    if (action.kind !== "selected" || action.value === "back") {
      continue;
    }
    if (action.value === "discuss") {
      pi.sendUserMessage(
        `Inspect papercut ${JSON.stringify(record.key)} and discuss possible fixes with me. Do not implement changes until I approve.`,
        { deliverAs: "followUp" },
      );
      return true;
    }
    try {
      await (await controller.storeFor(ctx)).close(record.key);
      await controller.refreshStatus(ctx);
    } catch {
      ctx.ui.notify("Papercut action failed.", "error");
    }
  }
}

export function registerPapercutsBrowser(
  pi: ExtensionAPI,
  status: PapercutStatusController,
): void {
  pi.registerCommand("papercuts", {
    description: "Browse incidental papercut findings",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("usage: /papercuts", "warning");
        return;
      }
      try {
        const file = await (await status.storeFor(ctx)).load();
        if (!ctx.hasUI || ctx.mode !== "tui") {
          ctx.ui.notify(formatPapercutSummary(file), "info");
          return;
        }
        while (true) {
          const current = await (await status.storeFor(ctx)).load();
          const open = current.records.filter(
            (record) => record.status === "open",
          ).length;
          const closed = current.records.length - open;
          const choice = await ctx.ui.select("Papercuts", [
            `Open (${open})`,
            `Closed (${closed})`,
            "Back",
          ]);
          if (!choice || choice === "Back") {
            return;
          }
          if (
            await browseStatus(
              ctx,
              choice.startsWith("Open") ? "open" : "closed",
              status,
              pi,
            )
          ) {
            return;
          }
        }
      } catch {
        ctx.ui.notify("Papercuts unavailable.", "error");
      }
    },
  });
}
