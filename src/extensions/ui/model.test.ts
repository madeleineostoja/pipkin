import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createManagedSessionHarness } from "#test/managed-session";
import { getFooterModel } from "./model.js";

async function virtualHarness() {
  const harness = await createManagedSessionHarness([
    fauxAssistantMessage("Hello"),
  ]);
  harness.modelRuntime.registerVirtualModel({
    provider: "router",
    id: "auto",
    name: "Auto",
    thinkingLevels: ["high"],
    route: () => ({ model: harness.model, thinkingLevel: "off" }),
  });
  const selected = harness.modelRuntime.getModel("router", "auto")!;
  const registry = new ModelRegistry(harness.modelRuntime);
  return { ...harness, selected, registry };
}

describe("footer model identity", () => {
  it("keeps virtual selection separate from the actual runtime dispatch and limits", async () => {
    const harness = await virtualHarness();
    const { session } = await harness.createSession();
    try {
      await session.setModel(harness.selected);
      session.setThinkingLevel("high");
      expect(getFooterModel(harness.selected, [], harness.registry)).toEqual({
        name: "Auto",
        id: "auto",
        provider: "router",
      });
      expect(session.getContextUsage()).toBeUndefined();
      await session.prompt("Hello");
      expect(session.model).toBe(harness.selected);
      expect(
        getFooterModel(
          session.model,
          session.sessionManager.getBranch(),
          harness.registry,
        ),
      ).toEqual({
        name: "Auto",
        id: "auto",
        provider: "router",
        dispatched: {
          name: harness.model.name,
          id: harness.model.id,
          provider: harness.model.provider,
          thinkingLevel: "off",
        },
      });
      expect(session.getContextUsage()?.contextWindow).toBe(
        harness.model.contextWindow,
      );
      expect(
        getFooterModel(
          harness.model,
          session.sessionManager.getBranch(),
          harness.registry,
        ),
      ).not.toHaveProperty("dispatched");
    } finally {
      session.dispose();
    }
  });

  it("uses the reported response identity and ignores later failed routing attempts", async () => {
    const harness = await virtualHarness();
    const { session } = await harness.createSession();
    try {
      await session.setModel(harness.selected);
      await session.prompt("Hello");
      const last = session.sessionManager.getBranch().at(-1)!;
      if (last.type !== "message" || last.message.role !== "assistant") {
        throw new Error("Expected response");
      }
      session.sessionManager.appendMessage({
        ...last.message,
        responseModel: "physical-reported",
        thinkingLevel: "medium",
      });
      session.sessionManager.appendMessage({
        ...last.message,
        provider: "router",
        model: "auto",
        api: "pi-virtual",
        stopReason: "error",
      });
      expect(
        getFooterModel(
          harness.selected,
          session.sessionManager.getBranch(),
          harness.registry,
        )?.dispatched,
      ).toEqual({
        id: "physical-reported",
        name: undefined,
        provider: harness.model.provider,
        thinkingLevel: "medium",
      });
    } finally {
      session.dispose();
    }
  });
});
