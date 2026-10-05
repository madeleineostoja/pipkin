import { describe, expect, it, vi } from "vitest";
import {
  type Component,
  type TuiMouseEvent,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
  ACTIVITY_CHANNEL,
  ACTIVITY_PROGRESS_MAX,
  ACTIVITY_TEXT_BYTE_LIMIT,
  ACTIVITY_TIMESTAMP_MAX,
  createActivityPublisher,
  validateActivityRecord,
} from "./activity.js";
import { ActivityStore } from "./activity-store.js";
import { installActivityWidget, renderActivity } from "./activity-widget.js";

const record = (id: string, overrides = {}) => ({
  id,
  label: "Agent",
  title: "A bounded task",
  state: "running" as const,
  updatedAt: 1,
  ...overrides,
});

const theme = {
  fg: (_tone: string, text: string) => text,
  bold: (text: string) => text,
} as never;

function activityView(mode: string) {
  const events = createEventBus();
  const store = new ActivityStore();
  const unsubscribe = events.on(ACTIVITY_CHANNEL, (event) =>
    store.accept(event),
  );
  const publisher = createActivityPublisher(events, "test");
  let factory: ((tui: unknown, theme: unknown) => Component) | undefined;
  let widget: Component;
  const tui = { mode, terminal: { rows: 40 }, requestRender: vi.fn() };
  const view = {
    nativeExpanded: false,
    tui,
    publisher,
    get widget() {
      return widget;
    },
    dispose() {
      dispose();
      unsubscribe();
      store.dispose();
    },
  };
  const dispose = installActivityWidget(
    {
      mode: "tui",
      hasUI: true,
      ui: {
        getToolsExpanded: () => view.nativeExpanded,
        setWidget: (_key: string, value: typeof factory) => {
          factory = value;
          if (factory) {
            widget = factory(tui, {
              fg: (_tone: string, text: string) => text,
              bg: (_tone: string, text: string) => text,
            });
          }
        },
      },
    } as never,
    store,
  );
  for (let index = 0; index < 12; index++) {
    publisher.upsert(record(`work-${index}`, { detail: `preview ${index}` }));
  }
  return view;
}

describe("Activity", () => {
  it("isolates replaced and disposed publisher generations", () => {
    const events = createEventBus();
    const store = new ActivityStore();
    events.on(ACTIVITY_CHANNEL, (event) => store.accept(event));
    const first = createActivityPublisher(events, "subagents");
    expect(first.upsert(record("first"))).toBe(true);
    const second = createActivityPublisher(events, "subagents");
    expect(store.records).toEqual([]);
    expect(first.upsert(record("stale"))).toBe(true);
    expect(store.records).toEqual([]);
    second.upsert(record("current"));
    second.dispose();
    expect(second.upsert(record("after-dispose"))).toBe(false);
    expect(store.records).toEqual([]);
  });

  it("rejects malformed events, cycles, and excess active records", () => {
    const store = new ActivityStore();
    expect(
      store.accept({
        version: 1,
        source: "x",
        generation: "g",
        operation: "upsert",
        record: record("x"),
      }),
    ).toBe(false);
    store.accept({
      version: 1,
      source: "x",
      generation: "g",
      operation: "replace",
    });
    expect(
      store.accept({
        version: 1,
        source: "x",
        generation: "g",
        operation: "upsert",
        record: record("a", { parent: { source: "x", id: "b" } }),
      }),
    ).toBe(true);
    expect(
      store.accept({
        version: 1,
        source: "x",
        generation: "g",
        operation: "upsert",
        record: record("b", { parent: { source: "x", id: "a" } }),
      }),
    ).toBe(false);
    for (let index = 0; index < 63; index += 1) {
      store.accept({
        version: 1,
        source: "x",
        generation: "g",
        operation: "upsert",
        record: record(`n${index}`),
      });
    }
    expect(
      store.accept({
        version: 1,
        source: "x",
        generation: "g",
        operation: "upsert",
        record: record("overflow"),
      }),
    ).toBe(false);
  });

  it("keeps insertion order when live progress updates", () => {
    const events = createEventBus();
    const store = new ActivityStore();
    events.on(ACTIVITY_CHANNEL, (event) => store.accept(event));
    const publisher = createActivityPublisher(events, "x");
    publisher.upsert(record("first", { updatedAt: 1 }));
    publisher.upsert(record("second", { updatedAt: 2 }));
    publisher.upsert(record("first", { updatedAt: 3, metric: "20k context" }));

    expect(store.records.map((item) => item.id)).toEqual(["first", "second"]);
  });

  it("removes final active work immediately", () => {
    const events = createEventBus();
    const store = new ActivityStore();
    events.on(ACTIVITY_CHANNEL, (event) => store.accept(event));
    const publisher = createActivityPublisher(events, "x");
    publisher.upsert(record("running", { startedAt: Date.now() }));
    expect(store.records).toHaveLength(1);
    publisher.remove("running");
    expect(store.records).toEqual([]);
  });

  it("repaints quiet timed work and stops after removal", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
      const store = new ActivityStore();
      const notify = vi.fn();
      store.subscribe(notify);
      store.accept({
        version: 1,
        source: "x",
        generation: "g",
        operation: "replace",
      });
      notify.mockClear();
      store.accept({
        version: 1,
        source: "x",
        generation: "g",
        operation: "upsert",
        record: record("quiet", { startedAt: Date.now() }),
      });
      notify.mockClear();

      vi.advanceTimersByTime(499);
      expect(notify).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(notify).toHaveBeenCalledOnce();

      notify.mockClear();
      store.accept({
        version: 1,
        source: "x",
        generation: "g",
        operation: "remove",
        id: "quiet",
      });
      notify.mockClear();
      vi.advanceTimersByTime(2_000);
      expect(notify).not.toHaveBeenCalled();
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("checkpoints far-future duration timers at Node's maximum delay", () => {
    let now = 100;
    const scheduled: Array<{ handler: () => void; milliseconds: number }> = [];
    const clock = {
      now: () => now,
      setTimeout: vi.fn((handler: () => void, milliseconds: number) => {
        scheduled.push({ handler, milliseconds });
        return scheduled.length;
      }),
      clearTimeout: vi.fn(),
    };
    const store = new ActivityStore(clock as never);
    const notify = vi.fn();
    store.subscribe(notify);
    store.accept({
      version: 1,
      source: "x",
      generation: "g",
      operation: "replace",
    });
    notify.mockClear();
    store.accept({
      version: 1,
      source: "x",
      generation: "g",
      operation: "upsert",
      record: record("future", { startedAt: ACTIVITY_TIMESTAMP_MAX }),
    });

    expect(scheduled.at(-1)?.milliseconds).toBe(2_147_483_647);
    notify.mockClear();
    now += scheduled.at(-1)!.milliseconds;
    scheduled.at(-1)!.handler();

    expect(notify).toHaveBeenCalledOnce();
    expect(scheduled.at(-1)?.milliseconds).toBe(2_147_483_647);
    store.dispose();
  });

  it("rejects terminal states and oversized or unsafe fields", () => {
    expect(validateActivityRecord(record("x", { state: "failed" }))).toBe(
      false,
    );
    expect(
      validateActivityRecord(
        record("x", { updatedAt: ACTIVITY_TIMESTAMP_MAX + 1 }),
      ),
    ).toBe(false);
    expect(validateActivityRecord(record("x", { updatedAt: -1 }))).toBe(false);
    expect(
      validateActivityRecord(
        record("x", { progress: { completed: 0.5, total: 1 } }),
      ),
    ).toBe(false);
    expect(
      validateActivityRecord(
        record("x", {
          progress: { completed: 1, total: ACTIVITY_PROGRESS_MAX + 1 },
        }),
      ),
    ).toBe(false);
    expect(
      validateActivityRecord(
        record("x", { title: "😀".repeat(ACTIVITY_TEXT_BYTE_LIMIT) }),
      ),
    ).toBe(false);
  });

  it("registers the activity widget only while records exist", () => {
    const store = new ActivityStore();
    const setWidget = vi.fn();
    const dispose = installActivityWidget(
      {
        mode: "tui",
        hasUI: true,
        ui: { setWidget, getToolsExpanded: () => false },
      } as never,
      store,
    );

    expect(setWidget).not.toHaveBeenCalled();
    store.accept({
      version: 1,
      source: "x",
      generation: "g",
      operation: "replace",
    });
    store.accept({
      version: 1,
      source: "x",
      generation: "g",
      operation: "upsert",
      record: record("live"),
    });
    expect(setWidget).toHaveBeenLastCalledWith(
      "pipkin.ui.activity",
      expect.any(Function),
      { placement: "aboveEditor" },
    );

    store.accept({
      version: 1,
      source: "x",
      generation: "g",
      operation: "remove",
      id: "live",
    });
    expect(setWidget).toHaveBeenLastCalledWith("pipkin.ui.activity", undefined);
    dispose();
    dispose();
  });

  it("keeps the activity background active and separated from the editor", () => {
    const store = new ActivityStore();
    store.accept({
      version: 1,
      source: "x",
      generation: "g",
      operation: "replace",
    });
    store.accept({
      version: 1,
      source: "x",
      generation: "g",
      operation: "upsert",
      record: record("long", {
        title: "a deliberately long activity title that must truncate",
        metric: "12k context",
      }),
    });
    let factory:
      | ((tui: unknown, theme: unknown) => { render(width: number): string[] })
      | undefined;
    const dispose = installActivityWidget(
      {
        mode: "tui",
        hasUI: true,
        ui: {
          getToolsExpanded: () => false,
          setWidget: (
            _key: string,
            value:
              | ((
                  tui: unknown,
                  theme: unknown,
                ) => { render(width: number): string[] })
              | undefined,
          ) => {
            factory = value;
          },
        },
      } as never,
      store,
    );
    const backgroundStart = "\x1b[48;5;17m";
    const component = factory!(
      { requestRender() {} },
      {
        fg: (_tone: string, text: string) => `\x1b[38;5;7m${text}\x1b[39m`,
        bg: (_tone: string, text: string) =>
          `${backgroundStart}${text}\x1b[49m`,
      },
    );

    const rendered = component.render(32).join("\n");
    expect(rendered).toContain(`\x1b[0m${backgroundStart}…`);
    const reset = "\x1b[0m";
    for (const suffix of rendered.split(reset).slice(1)) {
      expect(suffix.startsWith(backgroundStart)).toBe(true);
    }
    const lines = component.render(32);
    expect(lines.at(-1)).toBe("");
    expect(lines.slice(0, -1).every((line) => visibleWidth(line) === 32)).toBe(
      true,
    );
    dispose();
  });

  it.each(["regular", "fullscreen"])(
    "follows native expansion and bounds details after resize in %s mode",
    (mode) => {
      const view = activityView(mode);
      const collapsed = view.widget.render(80);
      expect(collapsed).toHaveLength(8);
      expect(collapsed.join("\n")).toContain("… 8 more");
      expect(collapsed.join("\n")).not.toContain("preview");

      view.nativeExpanded = true;
      const expanded = view.widget.render(80);
      expect(expanded).toHaveLength(20);
      expect(expanded.join("\n")).toContain("preview");
      expect(expanded.join("\n")).toContain("… 4 more");
      view.tui.terminal.rows = 24;
      expect(view.widget.render(80)).toHaveLength(12);
      for (const width of [1, 2, 24]) {
        expect(
          view.widget
            .render(width)
            .every((line) => visibleWidth(line) <= width),
        ).toBe(true);
      }
      view.nativeExpanded = false;
      expect(view.widget.render(80)).toEqual(collapsed);
      view.dispose();
    },
  );

  it("keeps clicks local, ignores non-clicks, and retains the choice when work returns", () => {
    const view = activityView("fullscreen");
    const click = {
      type: "click",
      button: "left",
      x: 1,
      y: 1,
      screenX: 1,
      screenY: 1,
      width: 80,
      height: 8,
      shift: false,
      alt: false,
      ctrl: false,
    } satisfies TuiMouseEvent;
    view.widget.render(80);
    for (const event of [
      { ...click, type: "wheel" as const },
      { ...click, type: "drag" as const },
      { ...click, button: "right" as const },
      { ...click, y: 7 },
    ]) {
      expect(view.widget.handleMouse?.(event)).toBeUndefined();
    }
    expect(view.widget.render(80)).toHaveLength(8);
    expect(view.widget.handleMouse?.(click)).toEqual({ handled: true });
    expect(view.nativeExpanded).toBe(false);
    expect(view.tui.requestRender).toHaveBeenCalled();
    expect(view.widget.render(80)).toHaveLength(20);

    view.publisher.clear();
    view.publisher.upsert(record("returned", { detail: "preview returned" }));
    expect(view.widget.render(80).join("\n")).toContain("preview returned");
    view.nativeExpanded = true;
    view.widget.render(80);
    view.widget.handleMouse?.(click);
    expect(view.widget.render(80).join("\n")).not.toContain("preview returned");
    expect(view.nativeExpanded).toBe(true);
    view.nativeExpanded = false;
    view.widget.render(80);
    view.nativeExpanded = true;
    expect(view.widget.render(80).join("\n")).toContain("preview returned");

    const retired = view.widget;
    view.dispose();
    expect(retired.handleMouse?.(click)).toBeUndefined();
  });

  it("keeps hierarchy, details, overflow, and ANSI-safe width bounded", () => {
    const store = new ActivityStore();
    store.accept({
      version: 1,
      source: "x",
      generation: "g",
      operation: "replace",
    });
    for (let index = 0; index < 8; index += 1) {
      store.accept({
        version: 1,
        source: "x",
        generation: "g",
        operation: "upsert",
        record: record(`root${index}`, { updatedAt: 1 }),
      });
    }
    store.accept({
      version: 1,
      source: "x",
      generation: "g",
      operation: "upsert",
      record: record("child", {
        parent: { source: "x", id: "root0" },
        detail: "reading registration paths",
        metric: "82k context",
        updatedAt: 1,
      }),
    });
    const lines = renderActivity(store.records, 24, theme, Date.now(), {
      lineLimit: 8,
      expanded: true,
    });
    expect(lines.join("\n")).toContain("reading");
    expect(lines.join("\n")).toContain("… 2 more");
    expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
  });
});
