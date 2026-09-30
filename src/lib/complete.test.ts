import { describe, expect, it } from "vitest";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createManagedSessionHarness } from "#test/managed-session";
import { completeText } from "./complete.js";

const context = {
  messages: [{ role: "user" as const, content: "synthetic", timestamp: 1 }],
};

describe("completeText", () => {
  it("dispatches a virtual selector with unknown limits through the supported model runtime", async () => {
    const harness = await createManagedSessionHarness([
      fauxAssistantMessage([
        { type: "text", text: "first" },
        { type: "thinking", thinking: "hidden" },
        { type: "text", text: "second" },
      ]),
    ]);
    const registry = new ModelRegistry(harness.modelRuntime);
    registry.registerVirtualModel({
      provider: "pipkin-test-router",
      id: "selected",
      name: "Selected",
      thinkingLevels: ["off"],
      route(request) {
        expect(request.reason).toBe("direct");
        expect(
          request.messages.some((message) => message.role === "user"),
        ).toBe(true);
        return { model: harness.model, thinkingLevel: "off" };
      },
    });
    const selected = registry.find("pipkin-test-router", "selected")!;
    expect(selected.contextWindow).toBe(0);
    await expect(
      completeText(selected, context, undefined, registry),
    ).resolves.toEqual({
      ok: true,
      text: "first\nsecond",
      stopReason: "stop",
    });
    expect(harness.faux.state.callCount).toBe(1);
  });

  it("preserves provider error and cancellation outcomes", async () => {
    const harness = await createManagedSessionHarness([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "provider failed",
      }),
      fauxAssistantMessage("", { stopReason: "aborted" }),
    ]);
    const registry = new ModelRegistry(harness.modelRuntime);
    await expect(
      completeText(harness.model, context, undefined, registry),
    ).resolves.toMatchObject({
      ok: false,
      reason: "error",
      message: "provider failed",
    });
    await expect(
      completeText(harness.model, context, undefined, registry),
    ).resolves.toMatchObject({
      ok: false,
      reason: "aborted",
    });
  });

  it("distinguishes empty output from usable truncated output", async () => {
    const harness = await createManagedSessionHarness([
      fauxAssistantMessage(""),
      fauxAssistantMessage("partial", { stopReason: "length" }),
    ]);
    const registry = new ModelRegistry(harness.modelRuntime);
    await expect(
      completeText(harness.model, context, undefined, registry),
    ).resolves.toEqual({
      ok: false,
      reason: "empty",
      text: "",
    });
    await expect(
      completeText(harness.model, context, undefined, registry),
    ).resolves.toEqual({
      ok: true,
      text: "partial",
      stopReason: "length",
    });
  });
});
