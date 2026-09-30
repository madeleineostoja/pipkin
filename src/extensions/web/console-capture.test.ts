import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureConsole, CONSOLE_CAPTURE_LIMITS } from "./console-capture.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

afterEach(() => vi.restoreAllMocks());

describe("scoped console capture", () => {
  it("isolates overlapping captures across loader copies and passes unrelated diagnostics through", async () => {
    const terminal = vi.spyOn(console, "error").mockImplementation(() => {});
    const firstGate = gate();
    const secondGate = gate();
    const first = captureConsole(async () => {
      console.error("first before");
      await firstGate.promise;
      console.error("first after");
      return "first result";
    });

    // Pi can load the same owner through separate Jiti graphs.
    vi.resetModules();
    const other = await import("./console-capture.js");
    const second = other.captureConsole(async () => {
      console.error("second before");
      await secondGate.promise;
      console.error("second after");
      return "second result";
    });

    try {
      console.error("unrelated");
      firstGate.release();
      const a = await first;
      console.error("still unrelated");
      secondGate.release();
      const b = await second;
      expect(a.value).toBe("first result");
      expect(b.value).toBe("second result");
      expect(a.diagnostics.entries.map((entry) => entry.text)).toEqual([
        "first before",
        "first after",
      ]);
      expect(b.diagnostics.entries.map((entry) => entry.text)).toEqual([
        "second before",
        "second after",
      ]);
      expect(terminal.mock.calls).toEqual([["unrelated"], ["still unrelated"]]);
      expect(console.error).toBe(terminal);
    } finally {
      firstGate.release();
      secondGate.release();
      await Promise.allSettled([first, second]);
    }
  });

  it("keeps nested captures separate and preserves rejection identity and console methods", async () => {
    const terminal = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failure = new Error("operation failed");
    const originals = {
      debug: console.debug,
      info: console.info,
      log: console.log,
      warn: console.warn,
      error: console.error,
      trace: console.trace,
    };
    const outer = await captureConsole(async () => {
      console.warn("outer before");
      const inner = await captureConsole(() => {
        console.warn("inner");
        return 42;
      });
      expect(inner.value).toBe(42);
      expect(inner.diagnostics.entries.map((entry) => entry.text)).toEqual([
        "inner",
      ]);
      await expect(
        captureConsole(async () => {
          await Promise.resolve();
          console.warn("rejected scope");
          throw failure;
        }),
      ).rejects.toBe(failure);
      console.warn("outer after");
    });
    expect(outer.diagnostics.entries.map((entry) => entry.text)).toEqual([
      "outer before",
      "outer after",
    ]);
    expect(terminal).not.toHaveBeenCalled();
    for (const [method, original] of Object.entries(originals)) {
      expect(console[method as keyof typeof originals]).toBe(original);
    }

    await expect(
      captureConsole(() => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(console.warn).toBe(terminal);
  });

  it("bounds diagnostics without running inspection hooks or changing the operation", async () => {
    const terminal = vi.spyOn(console, "log").mockImplementation(() => {});
    const customInspect = vi.fn(() => {
      throw new Error("must not run");
    });
    const captured = await captureConsole(() => {
      console.log({ [inspect.custom]: customInspect, message: "evidence" });
      console.log("x".repeat(CONSOLE_CAPTURE_LIMITS.characters + 1));
      for (let i = 0; i < CONSOLE_CAPTURE_LIMITS.entries; i++) {
        console.log("more");
      }
      console.log("%s", {
        toString: () => {
          throw new Error("bad diagnostic");
        },
      });
      return "unchanged";
    });
    expect(captured.value).toBe("unchanged");
    expect(captured.diagnostics.entries).toHaveLength(
      CONSOLE_CAPTURE_LIMITS.entries,
    );
    expect(captured.diagnostics.entries[1]).toMatchObject({ truncated: true });
    expect(
      captured.diagnostics.entries.every(
        (entry) => entry.text.length <= CONSOLE_CAPTURE_LIMITS.characters,
      ),
    ).toBe(true);
    expect(captured.diagnostics.omitted).toBe(3);
    expect(customInspect).not.toHaveBeenCalled();
    expect(terminal).not.toHaveBeenCalled();

    const unformattable = await captureConsole(() => {
      console.log("%s", {
        toString: () => {
          throw new Error("bad diagnostic");
        },
      });
      return "also unchanged";
    });
    expect(unformattable.value).toBe("also unchanged");
    expect(unformattable.diagnostics.entries[0]?.text).toBe(
      "Diagnostic could not be formatted.",
    );
  });
});
