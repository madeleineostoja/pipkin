import { describe, expect, it } from "vitest";
import { act } from "./act.js";
import { observe } from "./observe.js";
import type { BrowserOwner } from "./owner.js";

function observationOwner(
  page: () => Promise<unknown>,
  canRetryObservation = true,
): BrowserOwner {
  return {
    page,
    contextState: () => ({ generation: 1, stateLost: false }),
    canRetryObservation: () => canRetryObservation,
    activeTab: () => undefined,
    liveTabs: () => [],
    consumeActiveChange: () => undefined,
    consumeStateLossNotice: () => undefined,
    withContext: (error: unknown) => error,
  } as unknown as BrowserOwner;
}

describe("Browser recovery policy", () => {
  it("retries an observation once after proven generation loss", async () => {
    let calls = 0;
    const owner = observationOwner(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("Target page, context or browser has been closed");
      }
      return {};
    });

    await expect(observe(owner, { mode: "tabs" })).resolves.toMatchObject({
      details: { mode: "tabs" },
    });
    expect(calls).toBe(2);
  });

  it("does not retry an observation without proven generation loss", async () => {
    let calls = 0;
    const owner = observationOwner(async () => {
      calls += 1;
      throw new Error("Target page, context or browser has been closed");
    }, false);

    await expect(observe(owner, { mode: "tabs" })).rejects.toMatchObject({
      category: "page_gone",
    });
    expect(calls).toBe(1);
  });

  it("does not replay a dispatched action after failure", async () => {
    let navigations = 0;
    const owner = {
      page: async () => ({
        goto: async () => {
          navigations += 1;
          throw new Error("browser disconnected");
        },
      }),
      consumeActiveChange: () => undefined,
      liveTabs: () => [],
      beginAction: () => {},
      markDispatched: () => {},
      settleAction: async () => {},
      withContext: (error: unknown) => error,
    } as unknown as BrowserOwner;

    await expect(
      act(owner, { action: "navigate", url: "https://example.test" }),
    ).rejects.toMatchObject({ category: "uncertain_outcome" });
    expect(navigations).toBe(1);
  });
});
