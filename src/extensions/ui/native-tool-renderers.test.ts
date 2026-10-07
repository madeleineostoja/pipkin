import type {
  CodemodeToolDetails,
  Theme,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveNativeToolRenderers } from "./native-tool-renderers.js";
import { CodemodeProgress } from "./codemode-progress.js";

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
  afterEach(() => vi.useRealTimers());

  it("ticks one overall codemode timer without requiring nested-call progress", () => {
    vi.useFakeTimers();
    const progress = new CodemodeProgress();
    const native = { renderCall: () => new Text("Native script", 0, 0) };
    const renderer = resolveNativeToolRenderers(
      "codemode",
      () => native,
      progress,
    )!;
    const args = { code: "await tools.edit({});" };
    const ctx = context({ args, isPartial: true, executionStarted: false });
    expect(text(renderer.renderCall!(args, theme, ctx))).not.toContain("0s");
    progress.start(ctx.toolCallId);
    ctx.executionStarted = true;
    expect(text(renderer.renderCall!(args, theme, ctx))).toContain(
      "codemode · 0s",
    );
    vi.advanceTimersByTime(3000);
    expect(ctx.invalidate).toHaveBeenCalledTimes(3);
    expect(text(renderer.renderCall!(args, theme, ctx))).toContain(
      "codemode · 3s",
    );
    ctx.expanded = true;
    expect(text(renderer.renderCall!(args, theme, ctx))).toBe(
      "Elapsed 3s\nNative script",
    );
    progress.finish(ctx.toolCallId);
    ctx.isPartial = false;
    expect(text(renderer.renderCall!(args, theme, ctx))).toBe("Native script");
    expect(vi.getTimerCount()).toBe(0);
    // Completed exports do not acquire a live timer even with a partial render context.
    expect(
      text(
        renderer.renderCall!(
          args,
          theme,
          context({ expanded: true, isPartial: true }),
        ),
      ),
    ).toBe("Native script");
  });

  it("clears clocks and redraw callbacks on session replacement or shutdown", () => {
    vi.useFakeTimers();
    const progress = new CodemodeProgress();
    const invalidate = vi.fn();
    progress.start("a");
    progress.start("b");
    progress.elapsed("a", invalidate);
    progress.finish("b");
    expect(vi.getTimerCount()).toBe(1);
    progress.clear();
    progress.clear();
    vi.advanceTimersByTime(3000);
    expect(invalidate).not.toHaveBeenCalled();
    expect(progress.elapsed("a", invalidate)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows only bounded edit paths, tolerating truncated native argument previews", () => {
    const result = {
      content: [],
      details: {
        calls: [
          {
            id: "1",
            name: "edit",
            args: JSON.stringify({
              path: "src/a.ts",
              edits: [{ oldText: "secret", newText: "secret" }],
            }),
            status: "ok",
          },
          {
            id: "2",
            name: "edit",
            args: '{"path":"src/b.ts","edits":…',
            status: "running",
          },
          {
            id: "3",
            name: "edit",
            args: JSON.stringify({
              path: `src/\u001b[2Junsafe\n${"a".repeat(200)}`,
            }),
            status: "running",
          },
        ],
      },
    };
    const compact = resultText("codemode", result, { isPartial: true });
    expect(compact).toContain("✓ edit src/a.ts");
    expect(compact).toContain("… edit src/unsafe ");
    expect(compact).not.toContain("secret");
    expect(compact).not.toContain("\u001b");
    expect(compact).not.toContain("a".repeat(120));
    expect(compact).toContain("… edit src/b.ts");
  });

  it("identifies file and managed-work calls without exposing their payloads", () => {
    const inputs: [string, Record<string, unknown>][] = [
      ["read", { path: "src/read.ts", offset: 10 }],
      ["write", { path: "src/write.ts", content: "private content" }],
      [
        "lsp_references",
        {
          file: "src/use.ts",
          position: { line: 10, symbol: "private symbol" },
        },
      ],
      [
        "agent_start",
        {
          type: "Explore",
          prompt: "private prompt",
          description: "Inspect approvals",
        },
      ],
      [
        "process_start",
        { command: "private command", description: "Run checks" },
      ],
      ["agent_steer", { id: "explore-1", message: "private guidance" }],
      ["process_wait", { id: "process-2" }],
    ];
    const result = {
      content: [],
      details: {
        calls: inputs.map(([name, args], index) => ({
          id: `${index}`,
          name,
          args: JSON.stringify(args),
          status: "running",
        })),
      },
    };
    const original = structuredClone(result);
    const compact = resultText("codemode", result, { isPartial: true });
    for (const identity of [
      "read src/read.ts",
      "write src/write.ts",
      "lsp_references src/use.ts",
      "agent_start Inspect approvals",
      "process_start Run checks",
      "agent_steer explore-1",
      "process_wait process-2",
    ]) {
      expect(compact).toContain(`… ${identity}`);
    }
    expect(compact).not.toContain("private");
    expect(result).toEqual(original);
  });

  it("shows succinct Pipkin destinations and IDs, redacting URL credentials and query data", () => {
    const inputs: [string, Record<string, unknown>][] = [
      [
        "web_fetch",
        { url: "https://user:private@example.com/docs?token=private#private" },
      ],
      ["browser_open_tab", { url: "https://example.org/page?private#private" }],
      ["browser_switch_tab", { tabId: "tab-2" }],
      [
        "browser_fill",
        {
          target: { kind: "ref", value: "b1-d1-s1-e2" },
          value: "private form value",
        },
      ],
      ["browser_history", { action: "back" }],
      ["implement_inspect", { runId: "feature-work" }],
      [
        "papercut_record",
        { key: "setup-friction", incident: "private incident" },
      ],
      ["web_fetch", { url: "javascript:private" }],
    ];
    const compact = resultText(
      "codemode",
      {
        content: [],
        details: {
          calls: inputs.map(([name, args], index) => ({
            id: `${index}`,
            name,
            args: JSON.stringify(args),
            status: "running",
          })),
        },
      },
      { isPartial: true },
    );
    for (const identity of [
      "web_fetch https://example.com/docs",
      "browser_open_tab https://example.org/page",
      "browser_switch_tab tab-2",
      "browser_fill b1-d1-s1-e2",
      "browser_history back",
      "implement_inspect feature-work",
      "papercut_record setup-friction",
    ]) {
      expect(compact).toContain(`… ${identity}`);
    }
    expect(compact).not.toContain("private");
    expect(compact).not.toContain("user:");
  });

  it("retains complete leading identities in truncated previews without guessing missing fields", () => {
    const inputs = [
      ["write", '{"path":"src/a.ts","content":"cut off…'],
      ["lsp_definition", '{"file":"src/use.ts","position":…'],
      ["agent_start", '{"type":"Review","prompt":"cut off…'],
      ["process_start", '{"command":"cut off…'],
      ["read", '{"path":"src/incomplete…'],
      [
        "read",
        `${JSON.stringify({ path: 'src/quoted"file.ts' }).slice(0, -1)},"extra":…`,
      ],
      [
        "bash",
        '{"command":"private command","description":"not an allowed detail"}',
      ],
      ["unknown", '{"path":"not an allowed detail"}'],
    ];
    const compact = resultText(
      "codemode",
      {
        content: [],
        details: {
          calls: inputs.map(([name, args], index) => ({
            id: `${index}`,
            name,
            args,
            status: "running",
          })),
        },
      },
      { isPartial: true },
    );
    expect(compact).toContain("… write src/a.ts");
    expect(compact).toContain("… lsp_definition src/use.ts");
    expect(compact).toContain("… agent_start Review");
    expect(compact).toContain(
      '… process_start\n… read\n… read src/quoted"file.ts\n… bash\n… unknown',
    );
    expect(compact).not.toContain("cut off");
    expect(compact).not.toContain("incomplete");
    expect(compact).not.toContain("private");
    expect(compact).not.toContain("not an allowed detail");
  });

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

  it("delegates expanded native views without changing results or reusing incompatible compact components", () => {
    for (const name of ["codemode", "tool_search", "mcp__docs__query"]) {
      const native = {
        renderCall: vi.fn(() => new Text("Native call details", 0, 0)),
        renderResult: vi.fn(() => new Text("Native result details", 0, 0)),
      };
      const renderer = resolveNativeToolRenderers(name, () => native)!;
      const args = { code: "text('script');", query: "query" };
      const result = {
        content: [{ type: "text" as const, text: "Original output" }],
        details: { calls: [], loaded: [] },
      };
      const ctx = context({ args, lastComponent: new Text("Compact", 0, 0) });
      const compactCall = text(renderer.renderCall!(args, theme, ctx));
      renderer.renderResult!(result, ctx, theme, ctx);
      expect(compactCall).not.toContain("Native call details");
      expect(native.renderCall).not.toHaveBeenCalled();
      expect(native.renderResult).not.toHaveBeenCalled();

      ctx.expanded = true;
      expect(text(renderer.renderCall!(args, theme, ctx))).toBe(
        "Native call details",
      );
      expect(text(renderer.renderResult!(result, ctx, theme, ctx))).toBe(
        "Native result details",
      );
      expect(native.renderCall).toHaveBeenCalledExactlyOnceWith(
        args,
        theme,
        expect.objectContaining({ expanded: true, lastComponent: undefined }),
      );
      expect(native.renderResult).toHaveBeenCalledExactlyOnceWith(
        result,
        ctx,
        theme,
        expect.objectContaining({ lastComponent: undefined }),
      );

      ctx.expanded = false;
      expect(text(renderer.renderCall!(args, theme, ctx))).toBe(compactCall);
      expect(
        text(renderer.renderResult!(result, ctx, theme, ctx)),
      ).not.toContain("Native result details");
      expect(native.renderCall).toHaveBeenCalledTimes(1);
      expect(native.renderResult).toHaveBeenCalledTimes(1);
    }
  });

  it("includes native call details in expanded exports when their headers were never expanded", () => {
    const native = {
      renderCall: vi.fn(() => new Text("Native script/arguments", 0, 0)),
      renderResult: vi.fn(() => new Text("Native output", 0, 0)),
    };
    const renderer = resolveNativeToolRenderers("codemode", () => native)!;
    const args = { code: "text('exported');" };
    const ctx = context({ args, isPartial: true });
    expect(text(renderer.renderCall!(args, theme, ctx))).toBe("codemode");
    const result = { content: [], details: { calls: [] } };
    const options = { expanded: true, isPartial: false };
    expect(text(renderer.renderResult!(result, options, theme, ctx))).toBe(
      "Native script/arguments\nNative output",
    );
    expect(native.renderCall).toHaveBeenCalledWith(
      args,
      theme,
      expect.objectContaining({ expanded: true }),
    );
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

  it("keeps a live pending label until progress arrives without putting it in completed or exported headers", () => {
    const renderer = renderers("codemode");
    const args = { code: "text('hidden script');" };
    const ctx = context({
      args,
      isPartial: true,
      executionStarted: false,
      argsComplete: false,
    });
    expect(text(renderer.renderCall!(args, theme, ctx))).toBe(
      "codemode\nPreparing script…",
    );
    ctx.executionStarted = true;
    ctx.argsComplete = true;
    expect(text(renderer.renderCall!(args, theme, ctx))).toBe(
      "codemode\nRunning script…",
    );
    const progress = renderer.renderResult!(
      { content: [], details: { calls: [] } },
      ctx,
      theme,
      ctx,
    );
    expect(text(progress)).toContain("Running script…");
    expect(text(renderer.renderCall!(args, theme, ctx))).toBe("codemode");
    ctx.isPartial = false;
    expect(text(renderer.renderCall!(args, theme, ctx))).toBe("codemode");
    const exported = context({ args, isPartial: true });
    expect(text(renderer.renderCall!(args, theme, exported))).toBe("codemode");
  });

  it("uses neutral colors for routine progress and reserves warning/error colors for failed work", () => {
    const details: CodemodeToolDetails = {
      calls: [
        {
          id: "call-1/1",
          name: "edit",
          args: '{"path":"src/index.ts"}',
          status: "running",
        },
      ],
    };
    const result = { content: [], details };
    const ctx = context({ isPartial: true });
    const styledTheme = {
      ...theme,
      fg: (color: string, value: string) => `[${color}]${value}`,
    } as Theme;
    const renderer = renderers("codemode");
    const running = text(renderer.renderResult!(result, ctx, styledTheme, ctx));
    expect(running).toContain("[toolOutput]Running script…");
    expect(running).toContain("[toolOutput]… edit");
    expect(running).not.toContain("[warning]");
    details.calls[0].status = "ok";
    const succeededCall = text(
      renderer.renderResult!(result, ctx, styledTheme, ctx),
    );
    expect(succeededCall).toContain("[success]✓ edit[toolOutput] src/index.ts");
    details.calls[0].status = "error";
    const failedCall = text(
      renderer.renderResult!(result, ctx, styledTheme, ctx),
    );
    expect(failedCall).toContain("[warning]Running script…");
    expect(failedCall).toContain("[error]✗ edit[toolOutput] src/index.ts");
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
        {
          id: "call-1/4",
          name: "tool_search",
          args: "{}",
          status: "cancelled",
        },
      ],
    };
    const result = { content: [], details };
    const running = resultText("codemode", result, { isPartial: true });
    expect(running).toContain("Running script…");
    expect(running).toContain(
      "4 calls · 1 succeeded · 1 running · 1 failed · 1 cancelled",
    );
    expect(running).toContain("✓ read");
    expect(running).toContain("✗ write");
    expect(running).toContain("… bash");
    expect(running).toContain("⊘ tool_search");
    expect(running).not.toContain('"path":"a"');
    expect(running).not.toContain("Write denied.");
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
    expect(completed).toContain("1 failed · 2 cancelled");
    expect(completed).toContain("✓ read");
    expect(completed).toContain("✗ write");
    expect(completed).toContain("⊘ bash");
    expect(completed).not.toContain("… bash");
    expect(completed).not.toContain("Script failed.");
  });

  it("bounds the compact call roster without hiding aggregate failures", () => {
    const details: CodemodeToolDetails = {
      calls: Array.from({ length: 9 }, (_, index) => ({
        id: `call-1/${index}`,
        name: `tool-${index}`,
        args: '{"path":"private-arguments"}',
        status: index === 0 ? "error" : "ok",
        ...(index === 0 ? { error: "Detailed failure." } : {}),
      })),
    };
    const result = {
      content: [{ type: "text" as const, text: "Printed output." }],
      details,
    };
    const args = { code: "text('private-script');" };
    const compact = resultText("codemode", result, { args });
    expect(compact).toContain("9 calls · 8 succeeded · 1 failed");
    expect(compact).toContain("1 earlier call hidden — expand to inspect.");
    expect(compact).not.toContain("tool-0");
    expect(compact).toContain("✓ tool-1");
    expect(compact).toContain("✓ tool-8");
    expect(compact).not.toContain("private-arguments");
    expect(compact).not.toContain("private-script");
    expect(compact).not.toContain("Printed output.");
  });

  it("preserves compact failure summaries and raw output when no native renderer is available", () => {
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
    expect(collapsed).toContain("✓ models.classify");
    expect(collapsed).toContain("✗ write");
    expect(collapsed).not.toContain('"question":"classify"');
    expect(collapsed).toContain("Full output: /tmp/full-script.txt");
    expect(collapsed).not.toContain("partial script output");
    const expanded = resultText("codemode", result, {
      isError: true,
      expanded: true,
      args: { code },
    });
    expect(expanded).toContain(code);
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
