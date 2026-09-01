import { describe, expect, it } from "vitest";
import { translateMcpConfig } from "./config.ts";

describe("translateMcpConfig", () => {
  it("leaves absent and empty server maps disabled", () => {
    expect(translateMcpConfig(undefined)).toBeUndefined();
    expect(translateMcpConfig({})).toBeUndefined();
  });

  it("translates every configured HTTP(S) server into the contained adapter policy", () => {
    expect(
      translateMcpConfig({
        docs: {
          url: "https://mcp.example.test",
          oauth: { clientName: "Approved Client" },
        },
        local: { url: "http://127.0.0.1:7777/mcp" },
      }),
    ).toEqual({
      config: {
        mcpServers: {
          docs: {
            url: "https://mcp.example.test",
            oauth: { clientName: "Approved Client" },
            lifecycle: "lazy",
            protocolVersion: "auto",
            directTools: false,
          },
          local: {
            url: "http://127.0.0.1:7777/mcp",
            lifecycle: "lazy",
            protocolVersion: "auto",
            directTools: false,
          },
        },
        settings: {
          directTools: false,
          scriptMode: true,
          outputGuard: true,
          mcpFooterStatus: "off",
          sampling: false,
          elicitation: false,
        },
      },
    });
  });
});
