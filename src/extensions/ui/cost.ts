import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

type ModelLike = {
  provider: string;
  id: string;
  api?: string;
};

type ModelRegistryLike = {
  find(provider: string, modelId: string): ModelLike | undefined;
  isUsingOAuth(model: ModelLike): boolean;
};

type RecordedUsage = {
  usage: Usage;
  provider?: string;
  model?: string;
};

export type FooterCostInfo = {
  totalCost: number;
  hideCost: boolean;
};

function* recordedUsage(
  entries: readonly SessionEntry[],
): Generator<RecordedUsage> {
  for (const entry of entries) {
    if (entry.type === "message") {
      const message = entry.message;
      if (message.role === "assistant") {
        yield {
          usage: message.usage,
          provider: message.provider,
          model: message.responseModel ?? message.model,
        };
      } else if (message.role === "toolResult" && message.usage) {
        // Pi already aggregates nested calls into the top-level tool result.
        yield { usage: message.usage };
      }
    } else if (entry.type === "usage") {
      yield entry;
    } else if (
      (entry.type === "compaction" || entry.type === "branch_summary") &&
      entry.usage
    ) {
      yield { usage: entry.usage };
    }
  }
}

function isSubscriptionModel(
  model: ModelLike | undefined,
  modelRegistry: ModelRegistryLike,
): boolean {
  return model && model.api !== "pi-virtual"
    ? modelRegistry.isUsingOAuth(model)
    : false;
}

export function getAverageCacheHitRate(
  entries: readonly SessionEntry[],
): number | undefined {
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalPromptTokens = 0;

  for (const { usage } of recordedUsage(entries)) {
    totalCacheRead += usage.cacheRead;
    totalCacheWrite += usage.cacheWrite;
    totalPromptTokens += usage.input + usage.cacheRead + usage.cacheWrite;
  }

  if (totalCacheRead === 0 && totalCacheWrite === 0) {
    return undefined;
  }
  return totalPromptTokens > 0
    ? (totalCacheRead / totalPromptTokens) * 100
    : undefined;
}

export function getFooterCostInfo(
  entries: readonly SessionEntry[],
  modelRegistry: ModelRegistryLike,
  currentModel: ModelLike | undefined,
): FooterCostInfo {
  let totalCost = 0;
  let hasBillableUsage = false;
  let hasSubscriptionUsage = false;

  for (const record of recordedUsage(entries)) {
    const model =
      record.provider && record.model
        ? (modelRegistry.find(record.provider, record.model) ?? {
            provider: record.provider,
            id: record.model,
          })
        : undefined;
    if (isSubscriptionModel(model, modelRegistry)) {
      hasSubscriptionUsage = true;
    } else {
      hasBillableUsage = true;
      totalCost += record.usage.cost.total;
    }
  }

  const hideCost =
    !hasBillableUsage &&
    (hasSubscriptionUsage || isSubscriptionModel(currentModel, modelRegistry));

  return { totalCost, hideCost };
}
