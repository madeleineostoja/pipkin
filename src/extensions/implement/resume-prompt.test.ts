import { stripVTControlCharacters } from "node:util";
import {
  initTheme,
  type ExtensionUIContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, expect, it, vi } from "vitest";
import { confirmResume } from "./resume-prompt.js";
import type { ResumePreview } from "./resume.js";

beforeAll(() => initTheme("dark", false));

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;
const keys: Record<string, string> = {
  "tui.select.up": "\x1b[A",
  "tui.select.down": "\x1b[B",
  "tui.select.confirm": "\r",
  "tui.select.cancel": "\x1b",
};
const keybindings = {
  matches: (data: string, binding: string) => keys[binding] === data,
};

type CustomFactory = Parameters<ExtensionUIContext["custom"]>[0];
function uiFor(inputs: string[][]) {
  const screens: string[][] = [];
  const custom = vi.fn(async (factory: CustomFactory) => {
    const done = vi.fn();
    const component = await factory(
      { terminal: { rows: 24 }, requestRender: vi.fn() } as never,
      theme,
      keybindings as never,
      done,
    );
    const frames: string[] = [];
    const capture = () => {
      const lines = component.render(60);
      expect(lines.every((line) => visibleWidth(line) <= 60)).toBe(true);
      frames.push(lines.map(stripVTControlCharacters).join("\n"));
    };
    capture();
    for (const input of inputs.shift() ?? []) {
      component.handleInput?.(input);
      capture();
    }
    screens.push(frames);
    component.dispose?.();
    return done.mock.calls[0]?.[0];
  });
  return {
    ui: { custom, select: vi.fn() } as unknown as Pick<
      ExtensionUIContext,
      "custom" | "select"
    >,
    screens,
  };
}

const preview: ResumePreview = {
  runId: "run-1",
  generation: 1,
  startupRecovery: false,
  preservedSourceIds: ["delivered"],
  discardedSourceIds: ["unfinished", "queued", "blocked"],
  resources: [
    {
      id: "workspace:g0:unfinished",
      kind: "worktree",
      path: "/repo/worktrees/g0/unfinished",
      branch: "pipkin/implement/run-1/g0/unfinished",
      ownershipEvidence: "observed",
      status: "pending",
    },
  ],
  remainingSteps: [
    "Settle publication transactions",
    "Discard /repo/worktrees/g0/unfinished (pipkin/implement/run-1/g0/unfinished)",
    "Validate the target and activate",
  ],
};

it("defaults to cancellation and keeps exact disposal metadata out of the compact warning", async () => {
  const { ui, screens } = uiFor([["\r"]]);
  await expect(confirmResume(ui, preview)).resolves.toBe(false);
  const summary = screens[0]![0]!;
  expect(summary).toContain("1 delivered workstream");
  expect(summary).toContain("3 unfinished workstreams");
  expect(summary).toMatch(
    /Unpublished work in 1 workspace\s+will be discarded/,
  );
  expect(summary).not.toContain(preview.resources[0]!.path);
  expect(summary).not.toContain("findings and evidence");
  expect(summary).not.toContain("reviewed again");
});

it("requires explicit selection of the destructive resume action", async () => {
  const { ui, screens } = uiFor([["\x1b[B", "\r"]]);
  await expect(
    confirmResume(ui, {
      ...preview,
      resources: [{ ...preview.resources[0]!, kind: "branch" }],
    }),
  ).resolves.toBe(true);
  expect(screens[0]![0]).toContain("Discard & resume");
  expect(screens[0]![0]).toContain("1 unpublished branch will be removed.");
});

it("shows exact resources on demand and returns to a cancellation default", async () => {
  const { ui, screens } = uiFor([
    ["\x1b[B", "\x1b[B", "\r"],
    [...Array<string>(12).fill("\x1b[B"), "\x1b"],
    ["\r"],
  ]);
  await expect(confirmResume(ui, preview)).resolves.toBe(false);
  const details = screens[1]!.join("\n");
  expect(details).toContain(preview.resources[0]!.path);
  expect(details).toContain(preview.resources[0]!.branch);
  expect(details).toContain("findings and evidence remain intact");
  expect(screens).toHaveLength(3);
});

it("omits disposal warnings and restart claims when recovering startup with only retired resources", async () => {
  const { ui, screens } = uiFor([["\x1b[B", "\r"]]);
  await expect(
    confirmResume(ui, {
      ...preview,
      startupRecovery: true,
      resources: [{ ...preview.resources[0]!, status: "retired" }],
    }),
  ).resolves.toBe(true);
  const summary = screens[0]![0]!;
  expect(summary).toContain("Continue startup");
  expect(summary).toContain("Resume run");
  expect(summary).not.toContain("Restart");
  expect(summary).not.toContain("discarded");
  expect(summary).not.toContain("Discard & resume");
});
