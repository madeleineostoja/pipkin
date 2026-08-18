import { describe, expect, it } from "vitest";
import { BrowserError, browserError } from "./errors.js";

describe("Browser error precedence", () => {
  it("does not downgrade a dispatched action failure to a retryable error", () => {
    const error = browserError(new Error("Timeout 30000ms exceeded"), {
      dispatched: true,
      mutation: true,
    });
    expect(error).toMatchObject({ category: "uncertain_outcome" });
    expect(error.details.cause).toContain("Timeout");
  });

  it("keeps pre-dispatch target failures stable", () => {
    const error = browserError(
      new BrowserError("target", "Browser tab was not found."),
      { dispatched: false, mutation: true },
    );
    expect(error).toMatchObject({ category: "target" });
  });

  it("reports the installed Playwright version for missing executables", () => {
    const error = browserError(new Error("Executable doesn't exist"));
    expect(error).toMatchObject({ category: "installation" });
    expect(error.message).toContain("1.62.1");
  });
});
