import { describe, expect, it } from "vitest";
import { renderBrowserActResult } from "./result-renderer.js";
import { actionSummary } from "./presentation.js";

describe("Browser action presentation", () => {
  it("renders a direct target and outcome without text-entry values", () => {
    const theme = { fg: (_color: string, text: string) => text } as never;
    const rendered = renderBrowserActResult(
      {
        content: [{ type: "text", text: "Filled." }],
        details: {
          action: "fill",
          target: "role:Password",
          outcome: "Filled",
          value: undefined,
        },
      },
      { expanded: false, isPartial: false },
      theme,
      {},
    )
      .render(200)
      .join("\n");

    expect(rendered).toContain("fill · role:Password · Filled");
    expect(rendered).not.toContain("correct horse battery staple");
  });

  it("summarizes each safe structured wait condition", () => {
    expect(
      actionSummary({
        action: "wait",
        condition: {
          kind: "target",
          target: { kind: "role", value: "button" },
          state: "visible",
        },
      }),
    ).toBe("target:role:button · visible");
    expect(
      actionSummary({
        action: "wait",
        condition: { kind: "text", value: "Ready" },
      }),
    ).toBe("text:Ready");
    expect(
      actionSummary({
        action: "wait",
        condition: {
          kind: "url",
          value: "https://example.test/ready?token=secret",
        },
      }),
    ).toBe("url:https://example.test/ready");
  });
});
