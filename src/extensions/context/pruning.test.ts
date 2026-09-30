import {
  SessionManager,
  type BoundaryState,
  type SessionBoundaryDraft,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { EPOCH_TYPE, PRUNING_TYPE, type PruningMilestone } from "./policy.ts";
import { createPruningFlow } from "./pruning.ts";

function runtime(manager: SessionManager) {
  const notify = vi.fn();
  const flow = createPruningFlow();
  const ctx = { cwd: "/work", sessionManager: manager, ui: { notify } };
  flow.sessionStart(ctx as never);
  const boundary = (
    entries: SessionBoundaryDraft[] = [],
    preview = manager.buildSessionProjection(),
  ) =>
    flow.boundary(
      {
        entries,
        context: { contextEntries: preview.entries },
      } as BoundaryState,
      ctx as never,
    );
  return { boundary, notify };
}
function stale(manager: SessionManager, size = 4_000, userCount = 4) {
  const source = {
    role: "toolResult" as const,
    toolName: "web_fetch",
    toolCallId: "source",
    content: [{ type: "text" as const, text: "x".repeat(size) }],
    isError: false,
    timestamp: 1,
    usage: fauxAssistantMessage("").usage,
  };
  const id = manager.appendMessage(source);
  manager.appendMessage(fauxAssistantMessage("consumed"));
  for (let i = 0; i < userCount; i++) {
    manager.appendMessage({
      role: "user",
      content: `request ${i}`,
      timestamp: i + 2,
    });
  }
  return { id, source };
}
function accept(manager: SessionManager, drafts: SessionBoundaryDraft[]) {
  for (const draft of drafts) {
    if (draft.type === "context_edit") {
      manager.appendContextEdit(draft.targetId, draft.replacement);
    } else if (draft.type === "custom") {
      manager.appendCustomEntry(draft.customType, draft.data);
    } else {
      throw new Error("unexpected draft");
    }
  }
}

describe("canonical pruning authority", () => {
  it("returns only ordered native drafts; accepted edits preserve raw evidence and usage without repeating", () => {
    const manager = SessionManager.inMemory("/work");
    const { id, source } = stale(manager);
    const { boundary } = runtime(manager);
    const drafts = boundary()!.entries!;
    expect(drafts).toMatchObject([
      {
        type: "context_edit",
        targetId: id,
        replacement: {
          content: [
            {
              type: "text",
              text: expect.stringContaining(
                'read_output({reference:"transcript:v1:',
              ),
            },
          ],
        },
      },
      {
        type: "custom",
        customType: PRUNING_TYPE,
        data: { kind: "tail", count: 1, reasons: { "standard-stale": 1 } },
      },
    ]);
    expect(manager.buildSessionProjection().messages[0]).toEqual(source);
    accept(manager, drafts);
    const projected = manager.buildSessionProjection().messages[0];
    expect(projected).toMatchObject({
      usage: source.usage,
      toolCallId: source.toolCallId,
    });
    expect(manager.getEntry(id)).toMatchObject({ message: source });
    expect(boundary()).toBeUndefined();
    expect(runtime(manager).boundary()).toBeUndefined();
  });

  it("keeps originals after rejected drafts and gives one bounded warning without latching policy", () => {
    const manager = SessionManager.inMemory("/work");
    const { source } = stale(manager);
    const { boundary, notify } = runtime(manager);
    expect(boundary()?.entries).toHaveLength(2);
    // The native boundary rejected the batch: nothing was accepted into history.
    expect(boundary()?.entries).toHaveLength(2);
    expect(boundary()?.entries).toHaveLength(2);
    expect(manager.buildSessionProjection().messages[0]).toEqual(source);
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      "Context: could not persist pruning edits",
      "warning",
    );
  });

  it("evaluates preceding boundary edits and omissions without resurrecting raw content", () => {
    const manager = SessionManager.inMemory("/work");
    const { id } = stale(manager);
    const preceding: SessionBoundaryDraft = {
      type: "context_edit",
      targetId: id,
      replacement: {
        content: [{ type: "text", text: "other owner's short replacement" }],
      },
    };
    const preview = SessionManager.inMemory("/work", undefined, [
      manager.getHeader()!,
      ...manager.getBranch(),
    ]);
    preview.appendContextEdit(id, preceding.replacement);
    expect(
      runtime(manager).boundary([preceding], preview.buildSessionProjection()),
    ).toBeUndefined();
    manager.appendContextEdit(id, null);
    expect(runtime(manager).boundary()).toBeUndefined();
  });

  it("does not count old assistant/user entries as exposure of a competing replacement", () => {
    const manager = SessionManager.inMemory("/work");
    const { id } = stale(manager);
    const replacement = {
      content: [
        { type: "text" as const, text: "replacement evidence ".repeat(200) },
      ],
    };
    const draft: SessionBoundaryDraft = {
      type: "context_edit",
      targetId: id,
      replacement,
    };
    const preview = SessionManager.inMemory("/work", undefined, [
      manager.getHeader()!,
      ...manager.getBranch(),
    ]);
    preview.appendContextEdit(id, replacement);
    expect(
      runtime(manager).boundary([draft], preview.buildSessionProjection()),
    ).toBeUndefined();
    manager.appendContextEdit(id, replacement);
    manager.appendMessage(fauxAssistantMessage("consumed replacement"));
    expect(runtime(manager).boundary()).toBeUndefined();
    for (let i = 0; i < 4; i++) {
      manager.appendMessage({
        role: "user",
        content: `new request ${i}`,
        timestamp: i + 10,
      });
    }
    expect(runtime(manager).boundary()?.entries?.[0]).toMatchObject({
      type: "context_edit",
      targetId: id,
    });
  });

  it("does not invalidate an opaque checkpoint's exact kept-tail replay segment", () => {
    const manager = SessionManager.inMemory("/work");
    const { id } = stale(manager);
    manager.appendCompaction("opaque marker", id, 100, {
      kind: "pipkin-native-compaction",
    });
    manager.appendMessage(fauxAssistantMessage("same-identity continuation"));
    expect(runtime(manager).boundary()).toBeUndefined();
  });

  it("restores warm policy from branch-local milestones across resume and forks, never legacy decisions", () => {
    const manager = SessionManager.inMemory("/work");
    const { id, source } = stale(manager, 150_000, 8);
    const before = manager.getLeafId()!;
    const drafts = runtime(manager).boundary()!.entries!;
    expect((drafts[1] as { data: PruningMilestone }).data.kind).toBe("warm");
    accept(manager, drafts);
    const restored = SessionManager.inMemory("/resume", undefined, [
      manager.getHeader()!,
      ...manager.getBranch(),
    ]);
    restored.appendContextEdit(id, { content: source.content });
    restored.appendMessage(fauxAssistantMessage("consumed restored content"));
    for (let i = 0; i < 4; i++) {
      restored.appendMessage({
        role: "user",
        content: `later ${i}`,
        timestamp: i + 10,
      });
    }
    expect(runtime(restored).boundary()).toBeUndefined();
    restored.branch(before);
    expect(runtime(restored).boundary()?.entries).toHaveLength(2);
    restored.appendCustomEntry(EPOCH_TYPE, {
      kind: "warm",
      decisions: [
        {
          sourceToolCallId: "source",
          reason: "standard-stale",
          stub: '[tool result elided: stale. Call context_recall("source") to retrieve.]',
        },
      ],
    });
    expect(restored.buildSessionProjection().messages[0]).toEqual(source);
    expect(runtime(restored).boundary()?.entries).toHaveLength(2);
  });
});
