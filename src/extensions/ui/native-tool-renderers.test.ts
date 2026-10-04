import type {
  CodemodeToolDetails,
  Theme,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { resolveNativeToolRenderers } from "./native-tool-renderers.js";

type ToolRenderContext = Parameters<
  NonNullable<ToolRenderers["renderCall"]>
>[2];

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

function context(
  overrides: Partial<ToolRenderContext> = {},
): ToolRenderContext {
  return {
    args: {},
    toolCallId: "call-1",
    invalidate: vi.fn(),
    lastComponent: undefined,
    state: {},
    cwd: "/tmp",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: true,
    isError: false,
    ...overrides,
  };
}

function renderers(name: string): ToolRenderers {
  return resolveNativeToolRenderers(name, () => undefined)!;
}

function text(component: Component): string {
  return component
    .render(4000)
    .map((line) => line.trimEnd())
    .join("\n");
}

function resultText(
  name: string,
  result: { content: { type: "text"; text: string }[]; details?: unknown },
  overrides: Partial<ToolRenderContext> = {},
): string {
  const ctx = context(overrides);
  return text(
    renderers(name).renderResult!(
      { ...result, details: result.details },
      ctx,
      theme,
      ctx,
    ),
  );
}

describe("native tool presentation", () => {
  it("overrides selected native renderers while delegating feature-owned and other native tools", () => {
    const existing = { renderCall: vi.fn(), renderResult: vi.fn() };
    const next = vi.fn(() => existing);
    for (const name of ["codemode", "tool_search", "mcp__docs__query"]) {
      expect(resolveNativeToolRenderers(name, next)).not.toBe(existing);
    }
    expect(next).not.toHaveBeenCalled();
    for (const name of [
      "bash",
      "read",
      "agent_start",
      "web_fetch",
      "unknown",
    ]) {
      expect(resolveNativeToolRenderers(name, next)).toBe(existing);
    }
  });

  it("renders an unregistered MCP call compactly without losing expanded arguments or output", () => {
    const name = "mcp__docs__query";
    const query = "long query ".repeat(40);
    const args = { query };
    const call = renderers(name).renderCall!;
    const collapsedCall = text(call(args, theme, context()));
    const expandedCall = text(call(args, theme, context({ expanded: true })));
    expect(collapsedCall).toContain("docs/query");
    expect(collapsedCall.length).toBeLessThan(200);
    expect(expandedCall).toBe(collapsedCall);

    const result = {
      content: [
        { type: "text" as const, text: "first response ".repeat(60) },
        {
          type: "text" as const,
          text: "second block\nresource: file:///result",
        },
      ],
      details: { fullOutputPath: "/tmp/full-mcp.txt" },
    };
    const original = structuredClone(result);
    expect(resultText(name, result).length).toBeLessThan(300);
    expect(resultText(name, result)).toContain(
      "Full output: /tmp/full-mcp.txt",
    );
    const expanded = resultText(name, result, { expanded: true, args });
    expect(expanded).toContain(query);
    expect(expanded).toContain(result.content[0].text.trimEnd());
    expect(expanded).toContain(result.content[1].text);
    expect(result).toEqual(original);
  });

  it("keeps MCP errors and input rejections visible even without renderer metadata", () => {
    const result = {
      content: [
        {
          type: "text" as const,
          text: "Authentication required.\nSign in through /mcp.",
        },
      ],
    };
    expect(resultText("mcp__docs__query", result, { isError: true })).toContain(
      "Authentication required.",
    );
    expect(
      resultText("mcp__docs__query", result, { isError: true, expanded: true }),
    ).toContain("Sign in through /mcp.");
    expect(
      resultText("codemode", result, { isError: true, expanded: true }),
    ).toContain(result.content[0].text);
  });

  it("shows codemode progress and caught nested failures without claiming the script failed", () => {
    const details: CodemodeToolDetails = {
      calls: [
        { id: "call-1/1", name: "read", args: '{"path":"a"}', status: "ok" },
        {
          id: "call-1/2",
          name: "write",
          args: "{}",
          status: "error",
          error: "Write denied.",
        },
        { id: "call-1/3", name: "bash", args: "{}", status: "running" },
      ],
    };
    const result = { content: [], details };
    const running = resultText("codemode", result, { isPartial: true });
    expect(running).toContain("Running script…");
    expect(running).toContain("3 calls · 1 succeeded · 1 running · 1 failed");
    result.details.calls[2].status = "cancelled";
    const completed = resultText("codemode", {
      ...result,
      content: [
        {
          type: "text",
          text: "Script completed\nWall time 2.1 seconds\nOutput:\n",
        },
      ],
    });
    expect(completed).toContain("Script completed. · 2s");
    expect(completed).toContain("1 failed · 1 cancelled");
    expect(completed).not.toContain("Script failed.");
  });

  it("preserves failed codemode output, nested diagnostics, costs, recovery paths, and the expanded script", () => {
    const code =
      "await tools.write({ path: 'a', content: 'b' });\nthrow new Error('later failure');";
    expect(
      text(renderers("codemode").renderCall!({ code }, theme, context())),
    ).not.toContain(code);
    expect(
      text(
        renderers("codemode").renderCall!(
          { code },
          theme,
          context({ expanded: true }),
        ),
      ),
    ).not.toContain(code);
    const result = {
      content: [
        {
          type: "text" as const,
          text: "Script failed\nWall time 0.5 seconds\nOutput:\n",
        },
        { type: "text" as const, text: "partial script output" },
        { type: "text" as const, text: "Script error:\nlater failure" },
      ],
      details: {
        fullOutputPath: "/tmp/full-script.txt",
        calls: [
          {
            id: "call-1/1",
            name: "models.classify",
            args: '{"question":"classify"}',
            status: "ok",
            durationMs: 50,
            cost: 0.001,
          },
          {
            id: "call-1/2",
            name: "write",
            args: '{"path":"a"}',
            status: "error",
            error: "Write denied.\nRead-only repository.",
            durationMs: 1000,
          },
        ],
      },
    };
    const original = structuredClone(result);
    const collapsed = resultText("codemode", result, { isError: true });
    expect(collapsed).toContain("Script failed.");
    expect(collapsed).toContain("1 failed");
    expect(collapsed).toContain("Full output: /tmp/full-script.txt");
    expect(collapsed).not.toContain("partial script output");
    const expanded = resultText("codemode", result, {
      isError: true,
      expanded: true,
      args: { code },
    });
    expect(expanded).toContain(code);
    expect(expanded).toContain("models.classify · ok · 50ms · $0.0010");
    expect(expanded).toContain('Arguments: {"path":"a"}');
    expect(expanded).toContain("Write denied.\nRead-only repository.");
    expect(expanded).toContain("partial script output");
    expect(expanded).toContain("Script error:\nlater failure");
    expect(expanded).not.toContain("Wall time 0.5 seconds");
    expect(result).toEqual(original);
  });

  it("reports discovery outcomes and retains the loaded tool inventory on expansion", () => {
    const result = {
      content: [
        {
          type: "text" as const,
          text: "Loaded 2 tools. Available from your next call:\n- one: first\n- two: second",
        },
      ],
      details: { loaded: ["one", "two"] },
    };
    expect(resultText("tool_search", result)).toBe("Loaded 2 tools.");
    expect(resultText("tool_search", result, { expanded: true })).toContain(
      result.content[0].text,
    );
    expect(
      resultText("tool_search", { content: [], details: { loaded: [] } }),
    ).toBe("No matching tools found.");
    expect(
      resultText(
        "tool_search",
        { content: [{ type: "text", text: "query must not be empty" }] },
        { isError: true },
      ),
    ).toContain("query must not be empty");
  });
});
