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

  it("redacts text-entry causes after dispatch", () => {
    const error = browserError(new Error("typing secret value failed"), {
      dispatched: true,
      mutation: true,
      redactCause: true,
    });
    expect(error).toMatchObject({ category: "uncertain_outcome" });
    expect(error.details.cause).not.toContain("secret value");
  });

  it("keeps pre-dispatch target failures stable", () => {
    const error = browserError(
      new BrowserError("target", "Browser tab was not found."),
      { dispatched: false, mutation: true },
    );
    expect(error).toMatchObject({ category: "target" });
  });

  it("classifies a launch closure before generic page loss", () => {
    expect(
      browserError(
        new Error(
          "browserType.launch: Target page, context or browser has been closed",
        ),
      ),
    ).toMatchObject({
      category: "launch",
    });
  });

  it("reports the installed Playwright version for missing executables", () => {
    const error = browserError(new Error("Executable doesn't exist"));
    expect(error).toMatchObject({ category: "installation" });
    expect(error.message).toContain("1.62.1");
  });
});
