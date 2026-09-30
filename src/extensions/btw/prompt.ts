import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Context, Message, UserMessage } from "@earendil-works/pi-ai";

const SYSTEM_PROMPT =
  "You are answering a side question about the current coding session. " +
  "You have no tools available and cannot read files, run commands, or mutate state. " +
  "Answer concisely from the provided conversation context and your general knowledge.";
const OPAQUE_LIMITATION =
  " Prior history was compacted into an opaque provider checkpoint unavailable to this side request. " +
  "Only the readable canonical summaries and tail supplied here are available; do not claim to reconstruct the missing history.";

export type BtwPrompt = { context: Context };

function questionMessage(question: string): UserMessage {
  return {
    role: "user",
    content: [{ type: "text", text: question }],
    timestamp: Date.now(),
  };
}

function toolCallIds(message: Message): readonly string[] | null | undefined {
  if (message.role !== "assistant") {
    return undefined;
  }
  const calls = message.content.filter((part) => part.type === "toolCall");
  if (!calls.length) {
    return undefined;
  }
  const ids = calls.flatMap((part) =>
    typeof part.id === "string" && part.id ? [part.id] : [],
  );
  return ids.length === calls.length && new Set(ids).size === ids.length
    ? ids
    : null;
}

function sessionGroups(messages: readonly Message[]): readonly Message[][] {
  const groups: Message[][] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === "toolResult") {
      continue;
    }
    const callIds = toolCallIds(message);
    if (callIds === undefined) {
      groups.push([message]);
      continue;
    }
    if (callIds === null) {
      continue;
    }

    const results: Message[] = [];
    while (messages[index + results.length + 1]?.role === "toolResult") {
      results.push(messages[index + results.length + 1]!);
    }
    index += results.length;
    const resultIds = results.map((result) =>
      result.role === "toolResult" ? result.toolCallId : undefined,
    );
    if (
      results.length === callIds.length &&
      new Set(resultIds).size === callIds.length &&
      resultIds.every(
        (id) => typeof id === "string" && id && callIds.includes(id),
      )
    ) {
      groups.push([message, ...results]);
    }
  }
  return groups;
}

export function buildPrompt(
  sessionManager: ExtensionContext["sessionManager"],
  question: string,
): BtwPrompt {
  const projection = sessionManager.buildSessionProjection();
  let opaque = false;
  const readable = projection.entries.flatMap(({ sourceEntry, messages }) => {
    if (
      sourceEntry.type === "compaction" &&
      (sourceEntry.summary.includes(
        "authoritative prior context is an opaque provider checkpoint",
      ) ||
        (typeof sourceEntry.details === "object" &&
          sourceEntry.details !== null &&
          "kind" in sourceEntry.details &&
          sourceEntry.details.kind === "pipkin-native-compaction"))
    ) {
      opaque = true;
      return [];
    }
    return messages;
  });
  // System messages include both prompt sections and tool-loadout deltas.
  // tools:[] alone cannot revoke historical toolsAdded during normalization.
  const conversation = convertToLlm(readable).filter(
    (message) => message.role !== "system",
  );
  return {
    context: {
      systemPrompt: SYSTEM_PROMPT + (opaque ? OPAQUE_LIMITATION : ""),
      messages: [
        ...sessionGroups(conversation).flat(),
        questionMessage(question),
      ],
      tools: [],
    },
  };
}
