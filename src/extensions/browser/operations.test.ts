import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { Check } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { BrowserOwner } from "./owner.js";
import { registerBrowserOperations } from "./operations.js";
import { LIMITS } from "./limits.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1foAAAAASUVORK5CYII=",
  "base64",
);
function fixture() {
  const listeners = new Map<string, (...args: any[]) => void>();
  const locator = {
    count: vi.fn(async () => 1),
    ariaSnapshot: vi.fn(async () => '- button "Save" [ref=e1]'),
    innerText: vi.fn(async () => "rendered text"),
    boundingBox: vi.fn(async () => ({ x: 0, y: 0, width: 1, height: 1 })),
    screenshot: vi.fn(async () => png),
    fill: vi.fn(async () => {}),
    selectOption: vi.fn(async () => [] as string[]),
    click: vi.fn(async () => {}),
    isVisible: vi.fn(async () => true),
    evaluate: vi.fn(async () => ({
      tag: "input",
      attributes: { id: "message" },
      outerHtml: "<input>",
      text: "",
      value: "",
      checked: false,
      disabled: false,
      styles: { color: "red" },
    })),
    waitFor: vi.fn(async () => {
      throw new Error("Timeout 100ms exceeded");
    }),
  };
  const pageListeners = new Map<string, (...args: any[]) => void>();
  const page = {
    on: (name: string, callback: (...args: any[]) => void) =>
      pageListeners.set(name, callback),
    isClosed: () => false,
    title: vi.fn(async () => "Fixture"),
    url: () => "https://example.test/?token=secret",
    locator: vi.fn(() => locator),
    getByRole: vi.fn(() => locator),
    getByText: vi.fn(() => locator),
    viewportSize: () => ({ width: 1, height: 1 }),
    screenshot: vi.fn(async () => png),
    goto: vi.fn(async () => {}),
    setViewportSize: vi.fn(async () => {}),
    close: vi.fn(async () => {
      pageListeners.get("close")?.();
    }),
  };
  let created = 0;
  const context = {
    setDefaultTimeout: () => {},
    setDefaultNavigationTimeout: () => {},
    on: () => {},
    newPage: vi.fn(async () => {
      if (created++ === 0) {
        return page as unknown as Page;
      }
      let closed = false;
      const callbacks = new Map<string, (...args: any[]) => void>();
      return {
        ...page,
        on: (name: string, callback: (...args: any[]) => void) =>
          callbacks.set(name, callback),
        isClosed: () => closed,
        close: async () => {
          closed = true;
          callbacks.get("close")?.();
        },
      } as unknown as Page;
    }),
    close: vi.fn(async () => {}),
  };
  const browser = {
    isConnected: () => true,
    on: (name: string, callback: (...args: any[]) => void) =>
      listeners.set(name, callback),
    newContext: async () => context as unknown as BrowserContext,
    close: vi.fn(async () => {}),
  };
  const launch = vi.fn(async () => browser as unknown as Browser);
  const owner = new BrowserOwner({ launch });
  const tools = new Map<string, ToolDefinition>();
  registerBrowserOperations(
    {
      registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    } as unknown as ExtensionAPI,
    owner,
  );
  const call = async (name: string, input: unknown, signal?: AbortSignal) => {
    const tool = tools.get(`browser_${name}`)!;
    const result = await tool.execute(
      "fixture",
      input,
      signal,
      undefined,
      {} as never,
    );
    expect(Check(tool.outputSchema!, result.structuredContent)).toBe(true);
    expect(result.isError ?? false).toBe(
      (result.structuredContent as { ok: boolean }).ok === false,
    );
    return result;
  };
  return {
    call,
    owner,
    tools,
    launch,
    locator,
    page,
    pageListeners,
    listeners,
  };
}

describe("Browser structured operations", () => {
  it("keeps passive inspection empty before launch and navigation compact until explicit snapshot", async () => {
    const f = fixture();
    try {
      expect((await f.call("tabs", {})).structuredContent).toMatchObject({
        ok: true,
        tabs: [],
        truncated: false,
      });
      expect((await f.call("diagnostics", {})).structuredContent).toMatchObject(
        { ok: true, events: [], dropped: 0, omitted: 0 },
      );
      expect(f.launch).not.toHaveBeenCalled();
      const navigation = await f.call("navigate", {
        url: "https://example.test",
      });
      expect(navigation.structuredContent).toMatchObject({
        ok: true,
        action: "navigate",
        page: { tabId: "tab-1", url: "https://example.test/" },
      });
      expect(navigation.structuredContent).not.toHaveProperty("snapshot");
      expect(f.locator.ariaSnapshot).not.toHaveBeenCalled();
      const snapshot = await f.call("snapshot", {});
      expect(snapshot.structuredContent).toMatchObject({
        ok: true,
        snapshot: expect.stringContaining("[ref=e1@1]"),
      });
      expect(f.locator.ariaSnapshot).toHaveBeenCalledWith({
        mode: "ai",
        depth: 10,
        boxes: false,
      });
      expect(
        (await f.call("viewport", { width: 640, height: 480 }))
          .structuredContent,
      ).toMatchObject({ viewport: { width: 640, height: 480 } });
    } finally {
      await f.owner.shutdown();
    }
  });
  it("activates and closes tabs with compact page identity and invalidates old refs", async () => {
    const f = fixture();
    try {
      await f.call("snapshot", {});
      expect((await f.call("open_tab", {})).structuredContent).toMatchObject({
        tabId: "tab-2",
        page: { tabId: "tab-2" },
      });
      expect(
        (await f.call("switch_tab", { tabId: "tab-1" })).structuredContent,
      ).toMatchObject({ page: { tabId: "tab-1" } });
      expect(
        (await f.call("click", { target: { kind: "ref", value: "e1@1" } }))
          .structuredContent,
      ).toMatchObject({ ok: false, error: { code: "stale_ref" } });
      expect(
        (await f.call("close_tab", { tabId: "tab-2" })).structuredContent,
      ).toMatchObject({ page: { tabId: "tab-1" } });
      expect((await f.call("tabs", {})).structuredContent).toMatchObject({
        tabs: [{ id: "tab-1", active: true }],
      });
    } finally {
      await f.owner.shutdown();
    }
  });
  it("returns native images in both transports and rejects oversized screenshots", async () => {
    const f = fixture();
    try {
      const shot = await f.call("screenshot", {});
      expect(shot.structuredContent).toMatchObject({
        image: {
          type: "image",
          data: png.toString("base64"),
          mimeType: "image/png",
        },
        width: 1,
        height: 1,
        bytes: png.length,
      });
      expect(shot.content[1]).toEqual(
        (shot.structuredContent as { image: unknown }).image,
      );
      expect((shot.content[0] as { text: string }).text).not.toContain(
        png.toString("base64"),
      );
      f.page.screenshot.mockResolvedValueOnce(
        Buffer.alloc(LIMITS.screenshotBytes + 1),
      );
      expect((await f.call("screenshot", {})).structuredContent).toMatchObject({
        ok: false,
        error: { code: "content" },
      });
    } finally {
      await f.owner.shutdown();
    }
  });
  it("rejects ambiguous/stale refs without CSS fallback and marks bounded text", async () => {
    const f = fixture();
    try {
      await f.call("snapshot", {});
      f.locator.count.mockResolvedValueOnce(2);
      expect(
        (await f.call("click", { target: { kind: "role", value: "button" } }))
          .structuredContent,
      ).toMatchObject({ ok: false, error: { code: "target" } });
      await f.call("navigate", { url: "https://example.test" });
      // A new snapshot replaces old ref identity even if the backend uses e1 again.
      await f.call("snapshot", {});
      expect(
        (await f.call("click", { target: { kind: "ref", value: "e1@1" } }))
          .structuredContent,
      ).toMatchObject({ ok: false, error: { code: "stale_ref" } });
      expect(f.locator.click).not.toHaveBeenCalled();
      f.locator.innerText.mockResolvedValueOnce("x".repeat(18000));
      const text = (await f.call("text", {})).structuredContent as {
        text: string;
        truncated: boolean;
      };
      expect(text.text.length).toBe(LIMITS.textChars);
      expect(text.truncated).toBe(true);
    } finally {
      await f.owner.shutdown();
    }
  });
  it("redacts form text from success, failure, element data and retained diagnostics", async () => {
    const f = fixture();
    const secret = "private form text";
    try {
      await f.call("text", {});
      f.pageListeners.get("console")?.({
        type: () => "error",
        text: () => secret,
        location: () => ({ url: "https://example.test/?password=secret" }),
      });
      f.locator.fill.mockRejectedValueOnce(
        new Error(`Failed to fill ${secret}`),
      );
      const failure = await f.call("fill", {
        target: { kind: "css", value: "input" },
        value: secret,
      });
      expect(failure.structuredContent).toMatchObject({
        ok: false,
        error: { code: "uncertain_outcome" },
        generation: 0,
        stateLost: false,
      });
      expect(JSON.stringify(failure)).not.toContain(secret);
      f.locator.evaluate.mockResolvedValueOnce({
        tag: "input",
        attributes: { id: secret },
        outerHtml: `<input value="${secret}">`,
        text: secret,
        value: secret,
        checked: false,
        disabled: false,
        styles: { color: "x".repeat(1200) },
      });
      const element = await f.call("element", {
        target: { kind: "css", value: "input" },
      });
      expect(element.structuredContent).toMatchObject({
        ok: true,
        element: { tag: "input", text: "[redacted]", value: "[redacted]" },
        truncated: true,
      });
      expect(
        (element.structuredContent as { element: object }).element,
      ).not.toHaveProperty("name");
      const diagnostics = await f.call("diagnostics", {});
      expect(diagnostics.structuredContent).toMatchObject({
        events: [
          {
            category: "console",
            message: "[redacted]",
            url: "https://example.test/",
          },
        ],
      });
      expect(JSON.stringify([element, diagnostics])).not.toContain(secret);
    } finally {
      await f.owner.shutdown();
    }
  });
  it("bounds category-specific diagnostics and discloses dropped records", async () => {
    const f = fixture();
    try {
      await f.call("text", {});
      for (let i = 0; i < 101; i++) {
        f.pageListeners.get("pageerror")?.(new Error("x".repeat(1500)));
      }
      f.pageListeners.get("requestfailed")?.({
        failure: () => ({ errorText: "failed" }),
        url: () => "https://example.test/?token=secret",
        method: () => "GET",
      });
      f.pageListeners.get("response")?.({
        status: () => 403,
        url: () => "https://example.test/forbidden",
      });
      const result = await f.call("diagnostics", {});
      const data = result.structuredContent as {
        events: object[];
        omitted: number;
      };
      expect(data.events).toContainEqual(
        expect.objectContaining({
          category: "request_failed",
          method: "GET",
          url: "https://example.test/",
        }),
      );
      expect(data.events).toContainEqual(
        expect.objectContaining({ category: "http_error", status: 403 }),
      );
      expect(result.structuredContent).toMatchObject({
        dropped: 3,
        truncated: true,
      });
      expect(data.omitted).toBeGreaterThan(0);
      expect(JSON.stringify(data.events).length).toBeLessThanOrEqual(
        LIMITS.diagnosticChars,
      );
    } finally {
      await f.owner.shutdown();
    }
  });
  it("retries only observations after proven generation loss and reports recreated state", async () => {
    const f = fixture();
    try {
      f.locator.ariaSnapshot.mockImplementationOnce(async () => {
        f.listeners.get("disconnected")?.();
        throw new Error("Target page, context or browser has been closed");
      });
      expect((await f.call("snapshot", {})).structuredContent).toMatchObject({
        ok: true,
        generation: 1,
        stateLost: true,
        recovery: expect.stringContaining("prior tabs, refs"),
      });
      expect(f.launch).toHaveBeenCalledTimes(2);
      expect((await f.call("snapshot", {})).structuredContent).toMatchObject({
        ok: true,
        stateLost: false,
      });
      f.page.goto.mockImplementationOnce(async () => {
        f.listeners.get("disconnected")?.();
        throw new Error("browser disconnected");
      });
      expect(
        (await f.call("navigate", { url: "https://example.test" }))
          .structuredContent,
      ).toMatchObject({
        ok: false,
        error: { code: "uncertain_outcome" },
        generation: 2,
        stateLost: true,
      });
      expect(f.page.goto).toHaveBeenCalledTimes(1);
      expect(f.launch).toHaveBeenCalledTimes(2);
    } finally {
      await f.owner.shutdown();
    }
  });
  it.each(["text", "navigate"])(
    "preserves state loss when %s is cancelled during final identity collection",
    async (operation) => {
      const f = fixture();
      const controller = new AbortController();
      try {
        f.page.title.mockImplementationOnce(async () => {
          controller.abort();
          return "Discarded title";
        });
        const result = await f.call(
          operation,
          operation === "navigate" ? { url: "https://example.test" } : {},
          controller.signal,
        );
        expect(result.structuredContent).toMatchObject({
          ok: false,
          error: {
            code: operation === "navigate" ? "uncertain_outcome" : "cancelled",
          },
          generation: 1,
          stateLost: true,
          recovery: expect.stringContaining("prior tabs, refs"),
        });
        expect(result.structuredContent).not.toHaveProperty("page");
        expect(f.launch).toHaveBeenCalledTimes(1);
        expect(f.page.goto).toHaveBeenCalledTimes(
          operation === "navigate" ? 1 : 0,
        );
        expect((await f.call("text", {})).structuredContent).toMatchObject({
          ok: true,
          generation: 1,
          stateLost: false,
        });
        expect(f.page.goto).toHaveBeenCalledTimes(
          operation === "navigate" ? 1 : 0,
        );
      } finally {
        await f.owner.shutdown();
      }
    },
  );
  it.each(["text", "snapshot"])(
    "recollects %s evidence after disconnection during identity collection",
    async (operation) => {
      const f = fixture();
      try {
        f.locator.innerText.mockResolvedValueOnce("old generation text");
        f.page.title.mockImplementationOnce(async () => {
          f.listeners.get("disconnected")?.();
          throw new Error("browser disconnected");
        });
        const result = await f.call(operation, {});
        expect(result.structuredContent).toMatchObject({
          ok: true,
          generation: 1,
          stateLost: true,
          page: { tabId: "tab-2", generation: 1 },
        });
        expect(f.launch).toHaveBeenCalledTimes(2);
        if (operation === "text") {
          expect(result.structuredContent).toHaveProperty(
            "text",
            "rendered text",
          );
          expect(f.locator.innerText).toHaveBeenCalledTimes(2);
        } else {
          expect(result.structuredContent).toHaveProperty(
            "snapshot",
            '- button "Save" [ref=e1@2]',
          );
          expect(f.locator.ariaSnapshot).toHaveBeenCalledTimes(2);
          expect(
            (await f.call("click", { target: { kind: "ref", value: "e1@1" } }))
              .isError,
          ).toBe(true);
          expect(
            (await f.call("click", { target: { kind: "ref", value: "e1@2" } }))
              .isError,
          ).not.toBe(true);
          expect(f.locator.click).toHaveBeenCalledTimes(1);
        }
      } finally {
        await f.owner.shutdown();
      }
    },
  );
  it("returns a structured failure when late observation loss exhausts the single retry", async () => {
    const f = fixture();
    try {
      f.page.title.mockImplementation(async () => {
        f.listeners.get("disconnected")?.();
        throw new Error("browser disconnected");
      });
      const result = await f.call("snapshot", {});
      expect(result.structuredContent).toMatchObject({
        ok: false,
        error: { code: "browser_disconnected" },
        generation: 2,
        stateLost: true,
        recovery: expect.stringContaining("prior tabs, refs"),
      });
      expect(result.structuredContent).not.toHaveProperty("snapshot");
      expect(f.launch).toHaveBeenCalledTimes(2);
      expect(f.locator.ariaSnapshot).toHaveBeenCalledTimes(2);
    } finally {
      await f.owner.shutdown();
    }
  });
  it("reports late action disconnection without advertising a replacement page or replaying", async () => {
    const f = fixture();
    try {
      f.page.title.mockImplementationOnce(async () => {
        f.listeners.get("disconnected")?.();
        return "Old page";
      });
      const result = await f.call("navigate", { url: "https://example.test" });
      expect(result.structuredContent).toMatchObject({
        ok: false,
        error: { code: "uncertain_outcome" },
        generation: 1,
        stateLost: true,
        recovery: expect.stringContaining("prior tabs, refs"),
      });
      expect(result.structuredContent).not.toHaveProperty("page");
      expect(f.launch).toHaveBeenCalledTimes(1);
      await f.call("snapshot", {});
      expect(f.page.goto).toHaveBeenCalledTimes(1);
    } finally {
      await f.owner.shutdown();
    }
  });
  it("bounds Unicode snapshots while preserving complete refs or omitting them entirely", async () => {
    const f = fixture();
    try {
      for (const prefix of [
        "😀".repeat(10) + "x".repeat(15980),
        "😀" + "x".repeat(15996),
      ]) {
        f.locator.ariaSnapshot.mockResolvedValueOnce(`${prefix} [ref=e1]`);
        const result = await f.call("snapshot", {});
        const data = result.structuredContent as {
          snapshot: string;
          truncated: boolean;
        };
        expect(data.truncated).toBe(true);
        expect(Array.from(data.snapshot).length).toBeLessThanOrEqual(
          LIMITS.snapshotChars,
        );
        expect(data.snapshot).not.toContain("[");
        expect(data.snapshot).toBe(`${prefix} …`);
      }
      f.locator.ariaSnapshot.mockResolvedValueOnce(
        `${"😀".repeat(10)}${"x".repeat(15979)} [ref=e1]`,
      );
      const result = await f.call("snapshot", {});
      expect(result.structuredContent).toMatchObject({
        truncated: false,
        snapshot: expect.stringContaining("[ref=e1@3]"),
      });
    } finally {
      await f.owner.shutdown();
    }
  });
  it("discloses clipped diagnostic fields even without dropped or omitted records", async () => {
    const f = fixture();
    try {
      await f.call("text", {});
      f.pageListeners.get("pageerror")?.(new Error("short error"));
      expect((await f.call("diagnostics", {})).structuredContent).toMatchObject(
        {
          truncated: false,
          dropped: 0,
          omitted: 0,
        },
      );
      f.pageListeners.get("pageerror")?.(new Error("x".repeat(1500)));
      expect((await f.call("diagnostics", {})).structuredContent).toMatchObject(
        {
          truncated: true,
          dropped: 0,
          omitted: 0,
          events: [
            expect.anything(),
            expect.objectContaining({ message: "x".repeat(1000) }),
          ],
        },
      );
      f.pageListeners.get("requestfailed")?.({
        failure: () => ({ errorText: "failed" }),
        url: () => `https://example.test/${"x".repeat(3000)}`,
        method: () => "M".repeat(150),
      });
      expect(
        (await f.call("diagnostics", { categories: ["request_failed"] }))
          .structuredContent,
      ).toMatchObject({
        truncated: true,
        dropped: 0,
        omitted: 0,
        events: [expect.objectContaining({ method: "M".repeat(100) })],
      });
    } finally {
      await f.owner.shutdown();
    }
  });
  it("keeps supplied selection values out of failure transports without replay", async () => {
    const f = fixture();
    const values = ["private-choice", "another-private-choice"];
    try {
      f.locator.selectOption.mockRejectedValueOnce(
        new Error(`Failed to select ${values.join(", ")}`),
      );
      const result = await f.call("select", {
        target: { kind: "css", value: "select" },
        values,
      });
      expect(result.structuredContent).toMatchObject({
        ok: false,
        error: { code: "uncertain_outcome" },
        generation: 0,
        stateLost: false,
      });
      for (const value of values) {
        expect(JSON.stringify(result)).not.toContain(value);
      }
      await f.call("text", {});
      expect(f.locator.selectOption).toHaveBeenCalledTimes(1);
    } finally {
      await f.owner.shutdown();
    }
  });
  it("reports timeout and dispatch-aware cancellation without replay", async () => {
    const f = fixture();
    try {
      expect(
        (
          await f.call("wait", {
            condition: { kind: "text", value: "ready" },
            timeoutMs: 100,
          })
        ).structuredContent,
      ).toMatchObject({ ok: false, error: { code: "timeout" } });
      const controller = new AbortController();
      f.page.goto.mockImplementationOnce(async () => {
        controller.abort();
        throw new Error("browser disconnected");
      });
      const result = await f.call(
        "navigate",
        { url: "https://example.test" },
        controller.signal,
      );
      expect(result.structuredContent).toMatchObject({
        ok: false,
        error: { code: "uncertain_outcome" },
        stateLost: true,
        generation: 1,
        recovery: expect.stringContaining("prior tabs, refs"),
      });
      expect(f.page.goto).toHaveBeenCalledTimes(1);
      expect(f.launch).toHaveBeenCalledTimes(1);
      expect((await f.call("text", {})).structuredContent).toMatchObject({
        ok: true,
        generation: 1,
      });
      expect(f.page.goto).toHaveBeenCalledTimes(1);
      expect(
        (
          await f.call(
            "navigate",
            { url: "https://example.test" },
            controller.signal,
          )
        ).structuredContent,
      ).toMatchObject({
        ok: false,
        error: { code: "cancelled" },
        generation: 1,
      });
      expect(f.page.goto).toHaveBeenCalledTimes(1);
    } finally {
      await f.owner.shutdown();
    }
  });
});
