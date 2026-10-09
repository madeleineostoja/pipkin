import { stripVTControlCharacters } from "node:util";
import {
  keyHint,
  rawKeyHint,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { promptForAction } from "#lib/ui/action-prompt";
import { Panel } from "#lib/ui/panel";
import { ScrollViewport } from "#lib/ui/scroll-viewport";
import type { ResumePreview } from "./resume.js";

type ResumeUI = Pick<ExtensionUIContext, "select" | "custom">;

const safeText = (text: string) =>
  stripVTControlCharacters(text).replace(/\p{C}/gu, " ");

export async function confirmResume(
  ui: ResumeUI,
  preview: ResumePreview,
): Promise<boolean> {
  const pending = preview.resources.filter(
    (resource) => resource.status === "pending",
  );
  const workspaces = pending.filter(
    (resource) => resource.kind !== "branch",
  ).length;
  const branches = pending.length - workspaces;
  const detail = [
    `Keep       ${preview.preservedSourceIds.length} delivered workstream${preview.preservedSourceIds.length === 1 ? "" : "s"}`,
    preview.startupRecovery
      ? "Continue startup in the current generation."
      : `Restart    ${preview.discardedSourceIds.length} unfinished workstream${preview.discardedSourceIds.length === 1 ? "" : "s"}`,
    ...(workspaces || branches ? [""] : []),
    ...(workspaces
      ? [
          `Unpublished work in ${workspaces} workspace${workspaces === 1 ? "" : "s"} will be discarded.`,
        ]
      : []),
    ...(branches
      ? [
          `${branches} unpublished branch${branches === 1 ? "" : "es"} will be removed.`,
        ]
      : []),
    "",
  ].join("\n");

  while (true) {
    const result = await promptForAction({
      ui,
      title: preview.startupRecovery ? "Resume startup?" : "Resume run?",
      detail,
      choices: [
        { value: "cancel", label: "Cancel" },
        {
          value: "resume",
          label: pending.length ? "Discard & resume" : "Resume run",
        },
        { value: "details", label: "Details" },
      ],
      initialValue: "cancel",
    });
    if (result.kind === "aborted" || result.value === "cancel") {
      return false;
    }
    if (result.value === "resume") {
      return true;
    }
    await showResumeDetails(ui, preview);
  }
}

async function showResumeDetails(
  ui: ResumeUI,
  preview: ResumePreview,
): Promise<void> {
  const detail = [
    `Generation ${preview.generation}${preview.startupRecovery ? " · startup recovery" : ""}`,
    "",
    "Keep delivered workstreams",
    ...preview.preservedSourceIds.map((id) => `  ${safeText(id)}`),
    ...(preview.preservedSourceIds.length ? [] : ["  None"]),
    ...(!preview.startupRecovery
      ? [
          "",
          "Restart unfinished workstreams",
          ...preview.discardedSourceIds.map((id) => `  ${safeText(id)}`),
          ...(preview.discardedSourceIds.length ? [] : ["  None"]),
        ]
      : []),
    "",
    "Remaining preparation",
    ...preview.remainingSteps.map((step) => `  ${safeText(step)}`),
    "",
    "The original plan, findings and evidence remain intact.",
    "The complete plan will be reviewed again; unpublished candidates are not salvaged.",
  ].join("\n");

  await ui.custom<void>((tui, theme, keybindings, done) => {
    const scroll = new ScrollViewport({
      content: new Text(detail, 0, 0),
      viewportHeight: 1,
    });
    const panel = new Panel({
      theme,
      title: "Resume details",
      subtitle: safeText(preview.runId),
      child: scroll,
      footer: `${rawKeyHint("↑↓", "scroll")}  ${keyHint("tui.select.cancel", "back")}`,
    });
    return {
      render(width: number) {
        scroll.setViewportHeight(Math.max(1, (tui.terminal.rows ?? 24) - 7));
        return panel.render(width);
      },
      invalidate() {
        panel.invalidate();
      },
      handleInput(data: string) {
        if (
          keybindings.matches(data, "tui.select.cancel") ||
          keybindings.matches(data, "tui.select.confirm")
        ) {
          done();
          return;
        }
        const up = keybindings.matches(data, "tui.select.up");
        const down = keybindings.matches(data, "tui.select.down");
        if (up || down) {
          scroll.handleInput(up ? "\x1b[A" : "\x1b[B");
          tui.requestRender();
        }
      },
    };
  });
}
