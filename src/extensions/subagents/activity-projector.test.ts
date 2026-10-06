import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { ACTIVITY_CHANNEL } from "#ui/activity";
import { ActivityStore } from "../ui/activity-store.js";
import { renderActivity } from "../ui/activity-widget.js";
import { SubagentActivityProjector } from "./activity-projector.js";

describe("Subagent Activity projector", () => {
  it("keeps descriptions and durations compact while expanding nested agents, usage, and latest turns", () => {
    const events = createEventBus();
    const store = new ActivityStore();
    events.on(ACTIVITY_CHANNEL, (event) => store.accept(event));
    let snapshots = [
      {
        id: "agent-1",
        owner: "public-tool" as const,
        type: "Review",
        description: "Inspect the code\ncarefully",
        status: "running",
        timestamps: {
          startedAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "2026-03-09T10:00:00.000Z",
        },
        health: {
          contextUsage: { tokens: 82_000, contextWindow: 200_000 },
          tokensTotal: 140_000,
          estimatedCost: 0.12,
          pendingSteering: 2,
          lastAssistantText: "Checking \u001b[31mproducer\u001b[0m records…",
        },
      },
      {
        id: "nested-1",
        owner: {
          kind: "nested" as const,
          parentId: "agent-1",
          tool: "explore",
        },
        type: "Explore",
        description: "Inspect nested-agent lifecycle",
        status: "running",
        timestamps: {
          startedAt: "2026-03-09T10:01:25.000Z",
          updatedAt: "2026-03-09T10:01:25.000Z",
        },
        health: {
          contextUsage: { tokens: 24_000, contextWindow: 200_000 },
          tokensTotal: 31_000,
          estimatedCost: 0.02,
          pendingSteering: 0,
          lastAssistantText: "Reading shutdown\nhandling…",
        },
      },
    ];
    let listener: (() => void) | undefined;
    const runtime = {
      snapshots: () => snapshots,
      subscribeSnapshots: vi.fn((next) => {
        listener = next;
        return () => undefined;
      }),
    };

    const projector = new SubagentActivityProjector(runtime as never, events);
    projector.start();

    const theme = { fg: (_tone: string, text: string) => text } as never;
    const now = Date.parse("2026-03-09T10:02:00.000Z");
    const compact = renderActivity(store.records, 120, theme, now).join("\n");
    expect(compact).toContain("Inspect the code carefully");
    expect(compact).toContain("2 guidance pending · 1 exploring · 2m 0s");
    for (const hidden of [
      "nested-agent",
      "Context",
      "Usage",
      "Checking",
      "agent-1",
      "more",
    ]) {
      expect(compact).not.toContain(hidden);
    }

    const expanded = renderActivity(store.records, 120, theme, now, {
      expanded: true,
      lineLimit: 8,
    });
    expect(expanded).toHaveLength(6);
    expect(expanded[1]).toBe("  Context 82k/200k · Usage 140k · $0.12");
    expect(expanded[2]).toBe("  Checking producer records…");
    expect(expanded[3]).toContain("└ ● Agent · explore");
    expect(expanded[3]).toContain("Inspect nested-agent lifecycle");
    expect(expanded[3]).toContain("35s");
    expect(expanded[4]).toBe("    Context 24k/200k · Usage 31k · $0.02");
    expect(expanded[5]).toBe("    Reading shutdown handling…");

    snapshots = snapshots.slice(0, 1);
    listener?.();
    expect(store.records).toHaveLength(1);
    expect(
      renderActivity(store.records, 120, theme, now).join("\n"),
    ).not.toContain("exploring");
    projector.dispose();
    store.dispose();
  });

  it("excludes Implement-owned agents from generic Subagent activity", () => {
    const events = createEventBus();
    const store = new ActivityStore();
    events.on(ACTIVITY_CHANNEL, (event) => store.accept(event));
    const implementOwner = {
      kind: "pipkin:implement" as const,
      runId: "run",
      role: "implementer" as const,
    };
    const runtime = {
      snapshots: () => [
        {
          id: "implement-1",
          owner: implementOwner,
          type: "pipkin:implement:implementer",
          description: "Implement a workstream",
          status: "running",
          timestamps: { updatedAt: "2026-03-09T10:00:00.000Z" },
        },
        {
          id: "nested-1",
          owner: {
            kind: "nested",
            parentId: "implement-1",
            tool: "explore",
            parentOwner: implementOwner,
          },
          type: "Explore",
          description: "Explore implementation details",
          status: "running",
          timestamps: { updatedAt: "2026-03-09T10:00:00.000Z" },
        },
      ],
      subscribeSnapshots: vi.fn(() => () => {}),
    };

    const projector = new SubagentActivityProjector(runtime as never, events);
    projector.start();

    expect(store.records).toEqual([]);
  });

  it("omits unknown usage without inventing zero values", () => {
    const events = createEventBus();
    const store = new ActivityStore();
    events.on(ACTIVITY_CHANNEL, (event) => store.accept(event));
    const runtime = {
      snapshots: () => [
        {
          id: "agent-1",
          owner: "public-tool",
          type: "Review",
          description: "Review the change",
          status: "running",
          timestamps: { updatedAt: "2026-03-09T10:00:00.000Z" },
          health: {
            contextUsage: { tokens: null, contextWindow: 200_000 },
            tokensTotal: undefined,
            estimatedCost: Number.NaN,
          },
        },
      ],
      subscribeSnapshots: vi.fn(() => () => {}),
    };
    const projector = new SubagentActivityProjector(runtime as never, events);
    projector.start();
    expect(store.records[0].expandedMetric).toBeUndefined();
    projector.dispose();
    store.dispose();
  });

  it("removes terminal work and notifies a public-agent failure once", () => {
    const events = createEventBus();
    const store = new ActivityStore();
    events.on(ACTIVITY_CHANNEL, (event) => store.accept(event));
    let snapshots: any[] = [
      {
        id: "agent-1",
        owner: "public-tool",
        type: "Explore",
        description: "Inspect renderer ownership",
        status: "running" as const,
        health: {
          contextUsage: { tokens: 82_000 },
          lastAssistantText: "Reading renderer registration paths.",
        },
        timestamps: {
          startedAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "2026-03-09T10:00:00.000Z",
        },
      },
    ];
    let listener: (() => void) | undefined;
    const runtime = {
      snapshots: () => snapshots,
      subscribeSnapshots: vi.fn((next) => {
        listener = next;
        return () => undefined;
      }),
    };
    const notify = vi.fn();
    const projector = new SubagentActivityProjector(runtime as never, events);
    projector.start(notify);
    expect(store.records[0]).toMatchObject({
      expandedMetric: "Context 82k",
      detail: "Reading renderer registration paths.",
    });

    snapshots = [
      {
        ...snapshots[0],
        status: "failed" as const,
        error: "provider unavailable",
      },
    ];
    listener?.();
    listener?.();

    expect(store.records).toEqual([]);
    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(
      "Managed subagent agent-1 failed: provider unavailable",
      "warning",
    );
  });
});
