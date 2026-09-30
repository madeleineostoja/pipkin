import { describe, expect, it } from "vitest";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
  SessionManager,
  type SessionEntry,
  type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { getAverageCacheHitRate, getFooterCostInfo } from "./cost.js";

function usage(
  args: Partial<Omit<Usage, "cost">> & { cost?: Partial<Usage["cost"]> } = {},
): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    ...args,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      ...args.cost,
    },
  };
}

function assistantEntry(
  args: {
    provider?: string;
    model?: string;
    responseModel?: string;
    usage?: Usage;
  } = {},
): SessionMessageEntry & { message: AssistantMessage } {
  const session = SessionManager.inMemory();
  session.appendMessage({
    role: "assistant",
    provider: args.provider ?? "openai",
    model: args.model ?? "gpt-test",
    responseModel: args.responseModel,
    api: "openai-responses",
    content: [],
    stopReason: "stop",
    timestamp: 0,
    usage: args.usage ?? usage(),
  });
  return session.getBranch()[0] as SessionMessageEntry & {
    message: AssistantMessage;
  };
}

function registry(subscriptionProviders: string[] = []) {
  return {
    find(provider: string, id: string) {
      return {
        provider,
        id,
        cost: { input: 100, output: 100, cacheRead: 100, cacheWrite: 100 },
      };
    },
    isUsingOAuth(model: { provider?: string }) {
      return subscriptionProviders.includes(model.provider ?? "");
    },
  };
}

function mixedBranch(): SessionEntry[] {
  const session = SessionManager.inMemory();
  const assistant = assistantEntry({
    usage: usage({
      input: 90,
      cacheRead: 10,
      output: 30,
      reasoning: 20,
      cost: { total: 0.1 },
    }),
  });
  session.appendMessage(assistant.message);
  session.appendMessage({
    role: "toolResult",
    toolCallId: "call",
    toolName: "codemode",
    content: [],
    isError: false,
    timestamp: 0,
    usage: usage({ input: 20, cacheRead: 80, cost: { total: 0.2 } }),
    details: { usage: { ...usage({ input: 9000, cost: { total: 99 } }) } },
    nestedCalls: {
      complete: true,
      calls: [
        {
          id: "call/1",
          name: "model_tool",
          status: "ok",
          arguments: { usage: { input: 9000 } },
        },
      ],
    },
  });
  session.appendCompaction(
    "summary",
    null,
    1000,
    { usage: usage({ cost: { total: 99 } }) },
    false,
    usage({ input: 50, cacheRead: 30, cacheWrite: 20, cost: { total: 0.3 } }),
  );
  session.branchWithSummary(
    session.getLeafId(),
    "branch summary",
    undefined,
    false,
    usage({ input: 100, cost: { total: 0.4 } }),
  );
  session.appendUsage(
    "cache_warm",
    "openai",
    "gpt-test",
    usage({ cacheRead: 100, cost: { total: 0.5 } }),
  );
  session.appendUsage(
    "future_category",
    "openai",
    "gpt-test",
    usage({ cacheWrite: 100, cost: { total: 0.6 } }),
  );
  return session.getBranch();
}

describe("recorded branch accounting", () => {
  it("includes all native usage categories once, ignoring renderer and nested-call data", () => {
    const branch = mixedBranch();
    expect(getFooterCostInfo(branch, registry(), undefined)).toEqual({
      totalCost: 2.1,
      hideCost: false,
    });
    // 220 cache-read / 600 prompt tokens, including warm/summary/tool usage.
    expect(getAverageCacheHitRate(branch)).toBeCloseTo((220 / 600) * 100);
  });

  it("uses actual total costs even when components or catalog prices disagree", () => {
    const branch = [
      assistantEntry({
        usage: usage({
          input: 1000,
          output: 1000,
          cost: { input: 999, total: 0.07 },
        }),
      }),
    ];
    expect(getFooterCostInfo(branch, registry(), undefined).totalCost).toBe(
      0.07,
    );
    expect(
      getFooterCostInfo(
        [assistantEntry({ usage: usage({ input: 1000 }) })],
        registry(),
        undefined,
      ).totalCost,
    ).toBe(0);
  });

  it("does not require a resolved response model to use its recorded cost", () => {
    expect(
      getFooterCostInfo(
        [
          assistantEntry({
            responseModel: "unknown",
            usage: usage({ cost: { total: 0.07 } }),
          }),
        ],
        { find: () => undefined, isUsingOAuth: () => false },
        undefined,
      ),
    ).toEqual({ totalCost: 0.07, hideCost: false });
  });

  it("keeps cost and cache scope on the supplied branch, including compacted history", () => {
    const session = SessionManager.inMemory();
    session.appendUsage(
      "cache_warm",
      "openai",
      "gpt-test",
      usage({ input: 90, cacheRead: 10, cost: { total: 0.1 } }),
    );
    const fork = session.getLeafId()!;
    session.appendUsage(
      "cache_warm",
      "openai",
      "gpt-test",
      usage({ cacheRead: 1000, cost: { total: 99 } }),
    );
    session.branch(fork);
    session.appendCompaction("summary", null, 1000);
    expect(
      getFooterCostInfo(session.getBranch(), registry(), undefined).totalCost,
    ).toBe(0.1);
    expect(getAverageCacheHitRate(session.getBranch())).toBe(10);
  });

  it("excludes model-attributed subscription usage without hiding billable costs after a switch", () => {
    const session = SessionManager.inMemory();
    session.appendUsage(
      "cache_warm",
      "anthropic",
      "claude-test",
      usage({ cacheRead: 100, cost: { total: 0.5 } }),
    );
    const branch = [
      assistantEntry({ usage: usage({ cost: { total: 0.03 } }) }),
      assistantEntry({
        provider: "anthropic",
        usage: usage({ cost: { total: 0.5 } }),
      }),
      ...session.getBranch(),
    ];
    expect(
      getFooterCostInfo(branch, registry(["anthropic"]), {
        provider: "anthropic",
        id: "claude-test",
      }),
    ).toEqual({ totalCost: 0.03, hideCost: false });
    expect(getAverageCacheHitRate(branch)).toBe(100);
  });

  it("hides cost for subscription-only usage and before first physical subscription usage", () => {
    const model = { provider: "anthropic", id: "claude-test" };
    const models = registry(["anthropic"]);
    expect(
      getFooterCostInfo(
        [assistantEntry({ provider: "anthropic" })],
        models,
        model,
      ),
    ).toEqual({ totalCost: 0, hideCost: true });
    expect(getFooterCostInfo([], models, model).hideCost).toBe(true);
    expect(
      getFooterCostInfo([], models, { ...model, api: "pi-virtual" }).hideCost,
    ).toBe(false);
  });
});

describe("getAverageCacheHitRate", () => {
  it("stays token-weighted rather than averaging request percentages", () => {
    expect(
      getAverageCacheHitRate([
        assistantEntry({ usage: usage({ input: 90, cacheRead: 10 }) }),
        assistantEntry({ usage: usage({ cacheRead: 900, cacheWrite: 100 }) }),
      ]),
    ).toBeCloseTo((910 / 1100) * 100);
  });

  it("omits the metric without cache activity and includes cache writes in the denominator", () => {
    expect(getAverageCacheHitRate([])).toBeUndefined();
    expect(
      getAverageCacheHitRate([
        assistantEntry({ usage: usage({ input: 100, output: 50 }) }),
      ]),
    ).toBeUndefined();
    expect(
      getAverageCacheHitRate([
        assistantEntry({ usage: usage({ cacheWrite: 10 }) }),
      ]),
    ).toBe(0);
    expect(
      getAverageCacheHitRate([
        assistantEntry({
          usage: usage({
            input: 50,
            cacheRead: 30,
            cacheWrite: 20,
            output: 100,
            reasoning: 90,
          }),
        }),
      ]),
    ).toBe(30);
  });
});
