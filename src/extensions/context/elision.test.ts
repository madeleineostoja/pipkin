import {
  SessionManager,
  createReadToolDefinition,
  truncateHead,
  estimateTokens,
  type BoundaryState,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createPruningFlow } from "./pruning.ts";
import { PRUNING_TYPE, type PruningMilestone } from "./policy.ts";

function result(id: string, text = "x".repeat(4_000), name = "web_fetch") {
  return {
    role: "toolResult" as const,
    toolCallId: id,
    toolName: name,
    content: [{ type: "text" as const, text }],
    isError: false,
    timestamp: 1,
  };
}
function users(manager: SessionManager, count: number) {
  for (let i = 0; i < count; i++) {
    manager.appendMessage({
      role: "user",
      content: `request ${i}`,
      timestamp: 2,
    });
  }
}
function fixture() {
  const manager = SessionManager.inMemory("/work");
  const flow = createPruningFlow();
  const ctx = {
    cwd: "/work",
    sessionManager: manager,
    model: { provider: "test", id: "model" },
    ui: { notify: () => {} },
  };
  const boundary = () => {
    const projection = manager.buildSessionProjection();
    return (
      flow.boundary(
        {
          entries: [],
          continue: false,
          outcome: "completed",
          context: {
            contextEntries: projection.entries,
            contextMessages: projection.messages,
            llmMessages: [],
            pendingMessages: [],
            canContinue: false,
          },
        } satisfies BoundaryState,
        ctx as never,
      )?.entries ?? []
    );
  };
  return { manager, flow, ctx, boundary };
}
function milestone(drafts: ReturnType<ReturnType<typeof fixture>["boundary"]>) {
  const entry = drafts.find(
    (entry) => entry.type === "custom" && entry.customType === PRUNING_TYPE,
  );
  return entry?.type === "custom"
    ? (entry.data as PruningMilestone)
    : undefined;
}

describe("native pruning eligibility", () => {
  it("keeps first exposure, errors and unsuccessful assistant attempts full", () => {
    const { manager, boundary } = fixture();
    manager.appendMessage(
      fauxAssistantMessage(fauxToolCall("bash", {}, { id: "fresh" }), {
        stopReason: "toolUse",
      }),
    );
    manager.appendMessage(result("fresh", "passed\n".repeat(200), "bash"));
    expect(boundary()).toEqual([]);
    manager.appendMessage(fauxAssistantMessage("", { stopReason: "error" }));
    users(manager, 4);
    expect(boundary()).toEqual([]);
    manager.appendMessage(fauxAssistantMessage("consumed"));
    manager.appendMessage({
      ...result("failure", "failure ".repeat(400)),
      isError: true,
    });
    manager.appendMessage(fauxAssistantMessage("saw failure"));
    users(manager, 4);
    expect(milestone(boundary())?.reasons).toEqual({
      "after-consumption-bash": 1,
    });
  });

  it("requires four later users and 256 tokens for ordinary stale Web Fetch output without changing the source", () => {
    const { manager, boundary } = fixture();
    const source = result("large");
    manager.appendMessage(source);
    manager.appendMessage(result("small", "short"));
    manager.appendMessage(fauxAssistantMessage("consumed"));
    users(manager, 3);
    expect(boundary()).toEqual([]);
    users(manager, 1);
    const drafts = boundary();
    expect(milestone(drafts)?.reasons).toEqual({ "standard-stale": 1 });
    const edit = drafts[0];
    if (edit?.type !== "context_edit" || !edit.replacement) {
      throw new Error("missing edit");
    }
    expect(edit.replacement.content).toEqual([
      {
        type: "text",
        text: expect.stringContaining('read_output({reference:"transcript:v1:'),
      },
    ]);
    expect(source.content[0].text).toHaveLength(4_000);
    expect(
      manager.getBranch().find((entry) => entry.id === edit.targetId),
    ).toMatchObject({
      type: "message",
      message: source,
    });
  });

  it("uses successful superseding edits and verified returned intervals for duplicate/covered reads", async () => {
    const read = createReadToolDefinition("/work", {
      operations: {
        access: async () => {},
        readFile: async () => Buffer.from("line content\n".repeat(150)),
      },
    });
    const metadata = (count: number) => ({
      truncation: {
        ...truncateHead(
          Array.from({ length: count }, () => "line content").join("\n"),
        ),
      },
    });
    for (const reason of [
      "superseded-read",
      "duplicate-read",
      "covered-read",
    ] as const) {
      const { manager, boundary } = fixture();
      const args = { path: "a.ts", offset: 1, limit: 100 };
      const early = await read.execute(
        "early",
        args,
        undefined,
        undefined,
        {} as never,
      );
      manager.appendMessage(
        fauxAssistantMessage(fauxToolCall("read", args, { id: "early" })),
      );
      manager.appendMessage({
        ...result("early", "", "read"),
        content: early.content,
        details: metadata(100),
      });
      const name = reason === "superseded-read" ? "edit" : "read";
      const laterArgs = {
        ...args,
        limit: reason === "covered-read" ? 150 : 100,
      };
      manager.appendMessage(
        fauxAssistantMessage(fauxToolCall(name, laterArgs, { id: "later" })),
      );
      const late = await read.execute(
        "later",
        laterArgs,
        undefined,
        undefined,
        {} as never,
      );
      manager.appendMessage({
        ...result("later", "", name),
        content: late.content,
        details: metadata(laterArgs.limit),
      });
      manager.appendMessage(fauxAssistantMessage("consumed"));
      expect(milestone(boundary())?.reasons).toEqual({ [reason]: 1 });
    }
  });
  it("recognizes duplicate intervals in a genuinely native truncated read result", async () => {
    const { manager, boundary } = fixture();
    manager.appendModelChange("other", "other");
    const read = createReadToolDefinition("/work", {
      operations: {
        access: async () => {},
        readFile: async () =>
          Buffer.from(
            "line content with several descriptive words\n".repeat(2_001),
          ),
      },
    });
    const output = await read.execute(
      "read",
      { path: "a.ts" },
      undefined,
      undefined,
      {} as never,
    );
    for (const id of ["early", "later"]) {
      manager.appendMessage(
        fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" }, { id })),
      );
      manager.appendMessage({
        ...result(id, "", "read"),
        content: output.content,
        details: output.details as never,
      });
    }
    manager.appendMessage(fauxAssistantMessage("consumed"));
    manager.appendModelChange("test", "model");
    expect(milestone(boundary())?.reasons).toEqual({ "duplicate-read": 1 });
  });
});

describe("cache damage safeguards at supported boundaries", () => {
  it("uses a real cold window only before a warming request, with at least 8000 savings", () => {
    for (const warmed of [false, true]) {
      const { manager, flow, ctx, boundary } = fixture();
      manager.appendModelChange("other", "other");
      manager.appendMessage(result("source", "x".repeat(40_000)));
      manager.appendMessage(fauxAssistantMessage("consumed"));
      users(manager, 4);
      manager.appendModelChange("test", "model");
      if (warmed) {
        flow.requestStart(ctx as never);
      }
      const data = milestone(boundary());
      expect(data?.kind).toBe(warmed ? undefined : "known-cold");
      if (data) {
        expect(data.estimatedTokensSaved).toBeGreaterThanOrEqual(8_000);
      }
    }
    const { manager, boundary } = fixture();
    manager.appendModelChange("other", "other");
    manager.appendMessage(result("source", "x".repeat(20_000)));
    manager.appendMessage(fauxAssistantMessage("consumed"));
    users(manager, 4);
    manager.appendModelChange("test", "model");
    expect(boundary()).toEqual([]);
  });

  it("keeps the warm eight-user/32000-savings and 1.5 damage-ratio safeguards", () => {
    const { manager, boundary } = fixture();
    const source = result("source", "x".repeat(150_000));
    manager.appendMessage(source);
    manager.appendMessage(fauxAssistantMessage("consumed"));
    users(manager, 7);
    expect(boundary()).toEqual([]);
    users(manager, 1);
    const drafts = boundary();
    const data = milestone(drafts)!;
    expect(data.kind).toBe("warm");
    expect(data.estimatedTokensSaved).toBeGreaterThanOrEqual(32_000);
    const edit = drafts[0];
    if (edit?.type !== "context_edit" || !edit.replacement) {
      throw new Error("missing edit");
    }
    expect(data.estimatedTokensSaved).toBe(
      estimateTokens(source) -
        estimateTokens({
          ...source,
          content: edit.replacement.content,
        } as never),
    );
    manager.appendMessage({
      role: "user",
      content: "tail".repeat(40_000),
      timestamp: 3,
    });
    expect(boundary()).toEqual([]);

    const smaller = fixture();
    smaller.manager.appendMessage(result("source", "x".repeat(40_000)));
    smaller.manager.appendMessage(fauxAssistantMessage("consumed"));
    users(smaller.manager, 8);
    expect(smaller.boundary()).toEqual([]);
  });

  it("limits changed-tail damage to 2000 tokens even for consumed low-risk Bash", () => {
    const { manager, boundary } = fixture();
    manager.appendMessage(result("source", "passed\n".repeat(200), "bash"));
    manager.appendMessage(fauxAssistantMessage("consumed"));
    expect(milestone(boundary())?.kind).toBe("tail");
    manager.appendMessage({
      role: "user",
      content: "x".repeat(8_000),
      timestamp: 2,
    });
    expect(boundary()).toEqual([]);
  });
});
