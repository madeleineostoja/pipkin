import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentTools,
  getCurrentSystemPrompt,
  normalizeContext,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createManagedSessionHarness } from "#test/managed-session";
import { completeText } from "#lib/complete";
import { buildPrompt } from "./prompt.js";

function result(id: string) {
  return {
    role: "toolResult" as const,
    toolCallId: id,
    toolName: "read",
    content: [{ type: "text" as const, text: "read evidence" }],
    isError: false,
    timestamp: 3,
  };
}

describe("BTW canonical no-tools request", () => {
  it("retains the full question and readable edits/summaries while stripping all parent prompt/loadout authority in the normalized provider request", async () => {
    const manager = SessionManager.inMemory("/work");
    manager.appendMessage({
      role: "system",
      content: "parent authority",
      toolsAdded: [
        {
          name: "write",
          description: "write tool",
          parameters: { type: "object" },
        },
      ],
      timestamp: 1,
    });
    const old = manager.appendMessage({
      role: "user",
      content: "original evidence",
      timestamp: 2,
    });
    const omitted = manager.appendMessage({
      role: "user",
      content: "omitted evidence",
      timestamp: 2,
    });
    manager.appendContextEdit(old, { content: "canonical evidence" });
    manager.appendContextEdit(omitted, null);
    manager.appendMessage({
      role: "system",
      content: "changed parent authority",
      toolsRemoved: [{ name: "write" }],
      toolsAdded: [
        {
          name: "bash",
          description: "bash tool",
          parameters: { type: "object" },
        },
      ],
      timestamp: 3,
    });
    manager.appendCompaction("readable compaction summary", old, 1_000);
    manager.branchWithSummary(manager.getLeafId()!, "readable branch summary");
    manager.appendMessage(
      fauxAssistantMessage(fauxToolCall("bash", {}, { id: "unfinished" })),
    );
    manager.appendMessage(result("orphan"));
    const before = manager.getBranch();
    const question = "full side question 😀 ".repeat(10_000);
    const prompt = buildPrompt(manager, question);
    const harness = await createManagedSessionHarness([
      (context, options) => {
        expect(getCurrentTools(context.messages)).toEqual([]);
        const system = getCurrentSystemPrompt(context.messages);
        expect(system).toContain("no tools available");
        expect(system).not.toContain("parent authority");
        const serialized = JSON.stringify(context.messages);
        expect(serialized).toContain("canonical evidence");
        expect(serialized).toContain("readable branch summary");
        expect(serialized).toContain("readable compaction summary");
        expect(serialized).not.toContain("unfinished");
        expect(serialized).not.toContain("orphan");
        expect(serialized).not.toContain("original evidence");
        expect(serialized).not.toContain("omitted evidence");
        expect(context.messages.at(-1)).toMatchObject({
          content: [{ type: "text", text: question }],
        });
        expect(options?.maxTokens).toBeUndefined();
        return fauxAssistantMessage("answer");
      },
    ]);
    harness.modelRuntime.registerVirtualModel({
      provider: "btw-selector",
      id: "auto",
      name: "BTW virtual fixture",
      route: () => ({ model: harness.model, thinkingLevel: "off" }),
    });
    // Selected virtual models need no selector budgets; dispatch owns defaults.
    const virtual = harness.modelRuntime.getModel("btw-selector", "auto")!;
    expect(virtual).toBeDefined();
    expect(
      await completeText(virtual, prompt.context, {}, harness.modelRuntime),
    ).toMatchObject({ ok: true, text: "answer" });
    expect(harness.faux.state.callCount).toBe(1);
    expect(manager.getBranch()).toEqual(before);
  });

  it("keeps complete ID-matched tool exchanges, omits unfinished/orphan rounds without fabricating results", () => {
    const manager = SessionManager.inMemory("/work");
    manager.appendMessage(
      fauxAssistantMessage([
        fauxToolCall("read", {}, { id: "one" }),
        fauxToolCall("read", {}, { id: "two" }),
      ]),
    );
    manager.appendMessage(result("two"));
    manager.appendMessage(result("one"));
    manager.appendMessage(
      fauxAssistantMessage(fauxToolCall("read", {}, { id: "unfinished" })),
    );
    manager.appendMessage(result("orphan"));
    const messages = buildPrompt(manager, "question").context.messages;
    expect(messages.filter((message) => message.role === "toolResult")).toEqual(
      [result("two"), result("one")],
    );
    expect(JSON.stringify(messages)).not.toContain("unfinished");
    expect(JSON.stringify(messages)).not.toContain("orphan");
  });

  it("supplies readable opaque-checkpoint tail with an explicit limitation, never the marker/artifact", () => {
    const manager = SessionManager.inMemory("/work");
    const tail = manager.appendMessage({
      role: "user",
      content: "readable tail",
      timestamp: 1,
    });
    manager.appendCompaction("opaque marker", tail, 100, {
      kind: "pipkin-native-compaction",
      checkpoint: { artifact: ["opaque secret"] },
    });
    const prompt = buildPrompt(manager, "question");
    const normalized = normalizeContext(prompt.context);
    expect(getCurrentSystemPrompt(normalized.messages)).toContain(
      "unavailable to this side request",
    );
    expect(JSON.stringify(normalized.messages)).toContain("readable tail");
    expect(JSON.stringify(normalized.messages)).not.toContain("opaque marker");
    expect(JSON.stringify(normalized.messages)).not.toContain("opaque secret");
    expect(getCurrentTools(normalized.messages)).toEqual([]);
  });
});
