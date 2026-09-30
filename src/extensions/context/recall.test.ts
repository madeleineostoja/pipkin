import {
  SessionManager,
  createEventBus,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { registerOutputTools } from "./recall.ts";
import { transcriptReference } from "./retained-output.ts";
import { selectOutput } from "./output-selection.ts";
function tools<T extends { id: string }>(entries: T[]) {
  const registered = new Map<string, any>();
  registerOutputTools({
    events: createEventBus(),
    registerTool: (tool: any) => registered.set(tool.name, tool),
  } as never);
  const read = registered.get("read_output");
  const ctx = { sessionManager: { getBranch: () => entries } };
  return {
    read,
    run: (
      selector?: unknown,
      reference = transcriptReference(entries[0] ?? { id: "entry" }),
    ) =>
      read.execute("read", { reference, selector }, undefined, undefined, ctx),
  };
}
const image = {
  type: "image" as const,
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=",
  mimeType: "image/png",
};
describe("read_output", () => {
  it("forwards original failed transcript text/images in direct and structured content with branch authorization", async () => {
    const entries = [
      {
        id: "entry",
        type: "message",
        message: {
          role: "toolResult",
          toolName: "read",
          toolCallId: "call",
          isError: true,
          content: [{ type: "text", text: "Original" }, image],
        },
      },
    ];
    const f = tools(entries);
    const result = await f.run();
    expect(result.structuredContent).toMatchObject({
      ok: true,
      source: { isError: true },
      content: entries[0]!.message.content,
    });
    expect(result.content).toEqual(result.structuredContent.content);
    expect(Value.Check(f.read.outputSchema, result.structuredContent)).toBe(
      true,
    );
    expect((await f.run({ lines: "1" })).structuredContent.error.code).toBe(
      "invalid_arguments",
    );
    expect((await tools([]).run()).structuredContent.error.code).toBe(
      "not_found",
    );
    expect(
      (await f.run(undefined, "../../secret")).structuredContent.error.code,
    ).toBe("not_found");
  });
  it("retrieves original evidence after native replacement and compaction remove it from the model view", async () => {
    const manager = SessionManager.inMemory("/work");
    const id = manager.appendMessage({
      role: "toolResult",
      toolName: "read",
      toolCallId: "source",
      content: [{ type: "text", text: "Original evidence" }, image],
      isError: false,
      timestamp: 1,
    });
    const reference = transcriptReference(manager.getEntry(id)!);
    manager.appendContextEdit(id, {
      content: [{ type: "text", text: `Elided; read_output(${reference})` }],
    });
    const tail = manager.appendMessage({
      role: "user",
      content: "later",
      timestamp: 2,
    });
    manager.appendCompaction("opaque checkpoint marker", tail, 100, {
      kind: "pipkin-native-compaction",
    });
    expect(
      JSON.stringify(manager.buildSessionProjection().messages),
    ).not.toContain("Original evidence");
    const recalled = await tools(manager.getBranch()).run(undefined, reference);
    expect(recalled.content).toEqual([
      { type: "text", text: "Original evidence" },
      image,
    ]);
    expect(recalled.structuredContent.ok).toBe(true);
  });

  it("does not resolve a colliding entry ID to unrelated transcript evidence", async () => {
    const entry = {
      id: "0123abcd",
      type: "message",
      message: {
        role: "toolResult",
        toolName: "read",
        toolCallId: "call",
        content: [{ type: "text", text: "source" }],
      },
    };
    const reference = transcriptReference(entry);
    const unrelated = {
      ...entry,
      message: { ...entry.message, toolCallId: "other" },
    };
    const f = tools([unrelated]);
    const denied = await f.run(undefined, reference);
    expect(denied.structuredContent).toMatchObject({
      ok: false,
      error: { code: "not_found" },
      content: [],
    });
    expect(Value.Check(f.read.outputSchema, denied.structuredContent)).toBe(
      true,
    );
    // A copied raw entry, with a different object-key order, remains inherited.
    expect(
      (
        await tools([
          { message: entry.message, type: entry.type, id: entry.id },
        ]).run(undefined, reference)
      ).structuredContent.ok,
    ).toBe(true);
  });
  it("selects immutable lines/tail/literal matches with omissions; no-match succeeds", () => {
    const content = [
      {
        type: "text" as const,
        text: Array.from({ length: 100 }, (_, i) => `${i + 1} MATCH`).join(
          "\n",
        ),
      },
    ];
    expect(selectOutput(content, { lines: "2-3" }).content).toEqual([
      { type: "text", text: "2 MATCH\n3 MATCH" },
    ]);
    expect(selectOutput(content, { tailLines: 1 }).content[0]).toEqual({
      type: "text",
      text: "100 MATCH",
    });
    const result = selectOutput(content, { find: " match " });
    expect(result.selection).toMatchObject({
      totalMatches: 100,
      selectedMatches: 10,
      omittedMatches: 90,
    });
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("13 | 13 MATCH"),
    });
    expect(
      selectOutput(content, { find: "absent" }).selection.totalMatches,
    ).toBe(0);
    for (const selector of [
      { lines: "0" },
      { lines: "2-1" },
      { lines: "101" },
      { tailLines: 201 },
      { find: " " },
      { find: "😀".repeat(65) },
    ]) {
      expect(() => selectOutput(content, selector)).toThrow();
    }
    expect(() =>
      selectOutput([{ type: "text", text: "" }], { lines: "1" }),
    ).toThrow("empty");
  });
});
