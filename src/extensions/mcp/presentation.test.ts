import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  renderMcpCall,
  renderMcpResult,
  renderMcpScriptCall,
} from "./presentation.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

function text(component: { render: (width: number) => string[] }): string {
  return component
    .render(200)
    .map((line) => line.trimEnd())
    .join("\n");
}

describe("MCP presentation", () => {
  it("uses Pipkin call identities and pending states", () => {
    expect(
      text(renderMcpCall({ connect: "linear" }, theme, { isPartial: true })),
    ).toBe("mcp connect linear\nConnecting to linear…");
    expect(
      text(renderMcpCall({ server: "notion" }, theme, { isPartial: false })),
    ).toBe("mcp list notion");
    expect(
      text(
        renderMcpCall({ action: "auth-start", server: "figma" }, theme, {
          isPartial: false,
        }),
      ),
    ).toBe("mcp auth-start figma");
    expect(
      text(
        renderMcpScriptCall({ code: "emit('ok')" }, theme, { isPartial: true }),
      ),
    ).toBe("mcpScript\nRunning MCP script…");
  });

  it("summarizes status and successful calls without exposing full content", () => {
    const status = renderMcpResult(
      {
        content: [{ type: "text", text: "complete status inventory" }],
        details: {
          mode: "status",
          connectedCount: 2,
          totalTools: 109,
          servers: [
            { name: "linear" },
            { name: "notion" },
            { name: "off", disabled: true },
          ],
        },
      },
      { expanded: false, isPartial: false },
      theme,
      {},
    );
    const call = renderMcpResult(
      {
        content: [{ type: "text", text: "large external result" }],
        details: { mode: "call", server: "linear", tool: "get_issue" },
      },
      { expanded: false, isPartial: false },
      theme,
      {},
    );

    expect(text(status)).toBe("MCP status · 2/2 connected · 109 tools");
    expect(text(call)).toBe("MCP call · linear/get_issue · complete");
  });

  it("keeps OAuth continuation instructions discoverable", () => {
    const result = {
      content: [
        {
          type: "text",
          text: "Open this URL in your local browser:\n\nhttps://auth.example/long-url\n\nComplete the callback.",
        },
      ],
      details: {
        mode: "auth-start",
        server: "figma",
        authorizationUrl: "https://auth.example/long-url",
      },
    };

    expect(
      text(
        renderMcpResult(
          result,
          { expanded: false, isPartial: false },
          theme,
          {},
        ),
      ),
    ).toBe(
      "MCP authorization started · figma\nExpand for the authorization URL and callback instructions.",
    );
    expect(
      text(
        renderMcpResult(
          result,
          { expanded: true, isPartial: false },
          theme,
          {},
        ),
      ),
    ).toContain("https://auth.example/long-url");
  });

  it("renders adapter domain failures compactly and preserves complete expanded text", () => {
    const result = {
      content: [
        {
          type: "text",
          text: 'Server "figma" requires OAuth authentication.\nRun /mcp-auth figma.',
        },
      ],
      details: {
        mode: "connect",
        error: "auth_required",
        server: "figma",
      },
    };

    const collapsed = renderMcpResult(
      result,
      { expanded: false, isPartial: false },
      theme,
      {},
    );
    const expanded = renderMcpResult(
      result,
      { expanded: true, isPartial: false },
      theme,
      {},
    );

    expect(text(collapsed)).toBe(
      'Server "figma" requires OAuth authentication.',
    );
    expect(text(expanded)).toContain("Run /mcp-auth figma.");
  });
});
