import { describe, expect, it } from "vitest";
import { renderCompactionFailureEntry } from "./compaction-failure-renderer.ts";

const theme = {
  bg: (color: string, text: string) => `[bg:${color}]${text}`,
  fg: (color: string, text: string) => `[fg:${color}]${text}`,
  bold: (text: string) => `[bold]${text}`,
};

function render(data: unknown): string | undefined {
  return renderCompactionFailureEntry(
    { data } as never,
    { expanded: false },
    theme as never,
  )
    ?.render(100)
    .map((line) => line.trimEnd())
    .join("\n");
}

describe("compaction failure entry renderer", () => {
  it("renders a native compaction failure as chat-visible error output", () => {
    const warning = render({
      reason: "request failed (500)",
      outcome: "models-low",
    });
    expect(warning).toContain("[bg:toolPendingBg]");
    expect(warning).toContain(
      "[fg:toolTitle][bold]Context compaction [fg:accent]· OpenAI Codex",
    );
    expect(warning).toContain("[fg:warning]");
    expect(warning).toContain(
      "Native compaction failed: request failed (500). Using the models.low textual fallback.",
    );

    const error = render({
      reason: "authentication failed",
      outcome: "cancelled",
    });
    expect(error).toContain("[bg:toolErrorBg]");
    expect(error).toContain("[fg:error]");
    expect(error).toContain("Compaction was cancelled.");

    const piFallback = render({
      reason: "internal adapter failure",
      outcome: "pi",
    });
    expect(piFallback).toContain("[fg:warning]");
    expect(piFallback).toContain("Falling back to Pi's active-model");
    expect(piFallback).toContain("compaction.");

    const terminal = render({
      terminal: true,
      trigger: "overflow",
      aborted: false,
      willRetry: true,
      fromExtension: true,
    });
    expect(terminal).toContain("[bg:toolErrorBg]");
    expect(terminal).toContain("· overflow · extension summary");
    expect(terminal).toContain("Compaction failed; no checkpoint was saved.");
    expect(terminal).toContain("would have retried");
    expect(terminal).toContain("after successful compaction.");
  });

  it("declines malformed, unsafe, and oversized durable entries", () => {
    expect(render({ message: "wrong shape" })).toBeUndefined();
    expect(render({ reason: "missing outcome" })).toBeUndefined();
    expect(
      render({ reason: "unsafe\nreason", outcome: "models-low" }),
    ).toBeUndefined();
    expect(
      render({ reason: "x".repeat(121), outcome: "models-low" }),
    ).toBeUndefined();
    expect(
      render({
        terminal: true,
        trigger: "unknown",
        aborted: false,
        willRetry: false,
        fromExtension: false,
      }),
    ).toBeUndefined();
  });
});
