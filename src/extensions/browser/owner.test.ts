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
  it("removes a cancelled queued call without blocking the following call", async () => {
    const owner = new BrowserOwner();
    const first = deferred<void>();
    const started: string[] = [];
    const firstCall = owner.run(undefined, async () => {
      started.push("first");
      await first.promise;
    });
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
    first.resolve();
    await firstCall;
    await expect(after).resolves.toBe("complete");
    expect(started).toEqual(["first", "after"]);
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

  it("sanitizes credentials, query data, and overlong diagnostic URLs", () => {
    const url = sanitizeUrl(
      `https://user:secret@example.test/path?token=${"x".repeat(3_000)}#fragment`,
    );
    expect(url).toBe("https://example.test/path");
  });
});
