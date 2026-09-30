import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ModelRegistry,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { FooterModel } from "./format.js";

export function getFooterModel(
  selected: Model<Api> | undefined,
  entries: readonly SessionEntry[],
  registry: Pick<ModelRegistry, "find">,
): FooterModel {
  if (!selected) {
    return undefined;
  }
  const model: FooterModel = {
    name: selected.name,
    id: selected.id,
    provider: selected.provider,
  };
  if (selected.api !== "pi-virtual") {
    return model;
  }

  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "message" || entry.message.role !== "assistant") {
      continue;
    }
    const response = entry.message;
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      continue;
    }
    const id = response.responseModel ?? response.model;
    const physical = registry.find(response.provider, id);
    return {
      ...model,
      dispatched: {
        id,
        name: physical?.name,
        provider: response.provider,
        thinkingLevel: response.thinkingLevel,
      },
    };
  }
  return model;
}
