import { describe, expect, it } from "vitest";
import { BrowserError } from "./errors.js";
import { BrowserOwner, sanitizeUrl } from "./owner.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("BrowserOwner invocation lane", () => {
  it("keeps later work and shutdown behind a cancelled queued call's predecessor", async () => {
    const owner = new BrowserOwner();
    const first = deferred<void>();
    const started: string[] = [];
    const firstCall = owner.run(undefined, async () => {
      started.push("first");
      await first.promise;
    });
    const firstResult = firstCall.then(
      () => undefined,
      (error: unknown) => error,
    );
    const controller = new AbortController();
    const cancelled = owner.run(controller.signal, async () => {
      started.push("cancelled");
    });
    const after = owner.run(undefined, async () => {
      started.push("after");
      return "complete";
    });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({
      category: "cancelled",
    } satisfies Partial<BrowserError>);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(["first"]);
    const shutdown = owner.shutdown();
    let stopped = false;
    void shutdown.then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopped).toBe(false);
    first.resolve();
    await expect(firstResult).resolves.toMatchObject({
      category: "cancelled",
    } satisfies Partial<BrowserError>);
    await expect(after).rejects.toMatchObject({
      category: "cancelled",
    } satisfies Partial<BrowserError>);
    await shutdown;
    expect(started).toEqual(["first"]);
  });

  it("serializes operations", async () => {
    const owner = new BrowserOwner();
    const first = deferred<void>();
    const order: string[] = [];
    const one = owner.run(undefined, async () => {
      order.push("one-start");
      await first.promise;
      order.push("one-end");
    });
    const two = owner.run(undefined, async () => {
      order.push("two");
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["one-start"]);
    first.resolve();
    await Promise.all([one, two]);
    expect(order).toEqual(["one-start", "one-end", "two"]);
  });

  it("preserves dispatch classification when cancellation races an action", async () => {
    const owner = new BrowserOwner();
    const controller = new AbortController();
    await expect(
      owner.run(controller.signal, async () => {
        owner.markDispatched(true);
        controller.abort();
      }),
    ).rejects.toMatchObject({
      category: "uncertain_outcome",
    } satisfies Partial<BrowserError>);
  });

  it("keeps a dispatched read-only wait cancellation as cancelled", async () => {
    const owner = new BrowserOwner();
    const controller = new AbortController();
    await expect(
      owner.run(controller.signal, async () => {
        owner.markDispatched(false);
        controller.abort();
      }),
    ).rejects.toMatchObject({
      category: "cancelled",
    } satisfies Partial<BrowserError>);
  });

  it("redacts supplied form text from Browser-owned evidence", () => {
    const owner = new BrowserOwner();
    owner.rememberSensitiveText("correct horse battery staple");
    expect(owner.redactText("typed correct horse battery staple")).toBe(
      "typed [redacted]",
    );
  });

  it("sanitizes credentials, query data, and overlong diagnostic URLs", () => {
    const url = sanitizeUrl(
      `https://user:secret@example.test/path?token=${"x".repeat(3_000)}#fragment`,
    );
    expect(url).toBe("https://example.test/path");
  });
});
