import type {
  ContextEvent,
  BoundaryState,
  BoundaryResult,
  ExtensionContext,
  SessionEntry,
  ProjectedSessionEntry,
} from "@earendil-works/pi-coding-agent";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { isDeepStrictEqual } from "node:util";
import { transcriptReference } from "./retained-output.ts";
import { classifyBashOutput } from "./bash-classifier.ts";
import { extractFilePath, normalizePath } from "./paths.ts";
import {
  PRUNING_TYPE,
  type ElisionReason,
  type EpochKind,
  type PruningMilestone,
  type PruningState,
  isPruningMilestone,
} from "./policy.ts";

type AgentMessage = ContextEvent["messages"][number];
type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;
type ToolCallInfo = { name: string; input: unknown };
type ReadInterval = { path: string; start: number; end: number };
type ReadRelation = { path: string; keptUserTurn: number };
type Source = {
  id: string;
  reference: string;
  consumed: boolean;
  staleUsers: number;
  originalContent: boolean;
};
type Candidate = {
  index: number;
  id: string;
  netSavings: number;
  reason: ElisionReason;
  stub: string;
};

const STALE_USER_ENTRIES = 4;
const STALE_RESULT_TOKENS = 256;
const KNOWN_COLD_SAVINGS = 8_000;
const WARM_SAVINGS = 32_000;
const WARM_DAMAGE_RATIO = 1.5;
const WARM_USER_ENTRIES = 8;
const TAIL_DAMAGE = 2_000;

export function formatStub(
  toolName: string,
  reference: string,
  reason: ElisionReason,
  details: { path?: string; keptUserTurn?: number; command?: string },
): string {
  let explanation = "stale after later user requests";
  if (reason === "superseded-read") {
    explanation = `superseded by a later edit or write of ${details.path}`;
  } else if (reason === "duplicate-read") {
    explanation = `duplicated by a later read of ${details.path} at user entry ${details.keptUserTurn}`;
  } else if (reason === "covered-read") {
    explanation = `covered by a later read of ${details.path} at user entry ${details.keptUserTurn}`;
  } else if (reason === "after-consumption-bash") {
    const command = details.command
      ? ` for ${formatCommand(details.command)}`
      : "";
    explanation = `low-risk bash output consumed by an assistant${command}`;
  }
  return `[${toolName} result elided: ${explanation}. Call read_output({reference:"${reference}"}) to retrieve.]`;
}

function formatCommand(command: string): string {
  const escaped = command.replace(/\s+/g, " ").trim();
  return escaped.length > 120 ? `${escaped.slice(0, 119)}…` : escaped;
}

export function pruneAtBoundary(
  state: PruningState,
  event: BoundaryState,
  ctx: ExtensionContext,
): BoundaryResult | undefined {
  const entries = ctx.sessionManager.getBranch();
  restorePolicy(state, entries, ctx);
  if (state.pending) {
    const pending = state.pending;
    const start = pending.leafId
      ? entries.findIndex((entry) => entry.id === pending.leafId) + 1
      : 0;
    const accepted = entries
      .slice(start)
      .some(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === PRUNING_TYPE &&
          isDeepStrictEqual(entry.data, pending.milestone),
      );
    state.pending = undefined;
    if (!accepted) {
      warnAppendFailure(state, ctx);
    }
  }

  // The boundary preview includes preceding extensions' ordered drafts. Never
  // reconstruct a target from raw content or undo someone else's omission.
  const baseline = event.context.contextEntries.flatMap(
    ({ sourceEntry, messages }) =>
      messages.map((message) => {
        // Raw read-interval metadata describes the original output, not another
        // owner's replacement. Replacements may still become ordinary stale output.
        if (
          isToolResult(message) &&
          message.toolName === "read" &&
          sourceEntry.type === "message" &&
          sourceEntry.message.role === "toolResult" &&
          !isDeepStrictEqual(message.content, sourceEntry.message.content)
        ) {
          return { ...message, details: undefined };
        }
        return message;
      }),
  );
  const exposure = exposureAfterEach(event.context.contextEntries);
  const sources = new Map<number, Source>();
  let index = 0;
  for (const item of event.context.contextEntries) {
    for (const message of item.messages) {
      if (
        isToolResult(message) &&
        item.sourceEntry.type === "message" &&
        item.sourceEntry.message.role === "toolResult"
      ) {
        sources.set(index, {
          id: item.sourceEntry.id,
          reference: transcriptReference(item.sourceEntry),
          ...exposure.get(item.sourceEntry.id)!,
          originalContent: isDeepStrictEqual(
            message.content,
            item.sourceEntry.message.content,
          ),
        });
      }
      index++;
    }
  }
  const checkpoint = entries
    .slice()
    .reverse()
    .find((entry) => entry.type === "compaction");
  const opaque =
    checkpoint &&
    isRecord(checkpoint.details) &&
    checkpoint.details.kind === "pipkin-native-compaction";
  const checkpointIndex = opaque ? entries.indexOf(checkpoint) : -1;
  // The opaque replay segment is exact authority, not readable history we can
  // rewrite. Prune only later output rather than invalidating our own replay.
  const candidates = buildCandidates(baseline, ctx.cwd, sources).filter(
    (candidate) =>
      checkpointIndex < 0 ||
      entries.findIndex((entry) => entry.id === candidate.id) > checkpointIndex,
  );
  const epoch = selectEpoch(candidates, baseline, entries, ctx, state);
  if (!epoch) {
    return undefined;
  }
  const reasons: PruningMilestone["reasons"] = {};
  for (const candidate of epoch.candidates) {
    const reason = candidate.reason;
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  const milestone: PruningMilestone = {
    kind: epoch.kind,
    count: epoch.candidates.length,
    estimatedTokensSaved: sumSavings(epoch.candidates),
    reasons,
  };
  state.pending = { leafId: ctx.sessionManager.getLeafId(), milestone };
  return {
    entries: [
      ...event.entries,
      ...epoch.candidates.map((candidate) => ({
        type: "context_edit" as const,
        targetId: candidate.id,
        replacement: {
          content: [{ type: "text" as const, text: candidate.stub }],
        },
      })),
      { type: "custom", customType: PRUNING_TYPE, data: milestone },
    ],
  };
}

export function restorePolicy(
  state: PruningState,
  entries: SessionEntry[],
  ctx: ExtensionContext,
): void {
  state.warmEpochEntryId = undefined;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== PRUNING_TYPE) {
      continue;
    }
    if (!isPruningMilestone(entry.data)) {
      if (!state.reportedInvalidEntry) {
        state.reportedInvalidEntry = true;
        ctx.ui.notify(
          "Context: ignoring an invalid persisted pruning milestone",
          "warning",
        );
      }
    } else if (entry.data.kind === "warm") {
      state.warmEpochEntryId = entry.id;
    }
  }
}

export function warnAppendFailure(
  state: PruningState,
  ctx: ExtensionContext,
): void {
  if (!state.reportedAppendFailure) {
    state.reportedAppendFailure = true;
    ctx.ui.notify("Context: could not persist pruning edits", "warning");
  }
}

export function coldMarkerId(entries: SessionEntry[]): string | undefined {
  return entries
    .slice()
    .reverse()
    .find(
      (entry) => entry.type === "compaction" || entry.type === "model_change",
    )?.id;
}

function buildCandidates(
  messages: AgentMessage[],
  cwd: string,
  sources: ReadonlyMap<number, Source>,
): Candidate[] {
  const toolCalls = collectToolCalls(messages);
  const mutations = collectMutations(messages, toolCalls, cwd);
  const reads = collectReads(messages, toolCalls, cwd);
  const duplicateReads = relationMap(reads, mutations, true);
  const coveredReads = relationMap(reads, mutations, false);
  const candidates: Candidate[] = [];
  const seenToolCallIds = new Set<string>();

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!isToolResult(message) || seenToolCallIds.has(message.toolCallId)) {
      continue;
    }
    seenToolCallIds.add(message.toolCallId);
    const source = sources.get(index);
    if (message.isError || !source?.consumed || isPruningStub(message)) {
      continue;
    }
    const toolCall = toolCalls.get(message.toolCallId);
    const path = source.originalContent
      ? readPath(message, toolCall, cwd)
      : undefined;
    const superseded = path && hasLaterMutation(mutations.get(path), index);
    const duplicate = duplicateReads.get(message.toolCallId);
    const covered = coveredReads.get(message.toolCallId);
    const command = bashCommand(toolCall);
    const lowRiskBash =
      message.toolName === "bash" &&
      classifyBashOutput(message.content, estimateTokens(message), 0).lowRisk;

    let reason: ElisionReason | undefined;
    let details: { path?: string; keptUserTurn?: number; command?: string } =
      {};
    if (superseded && path) {
      reason = "superseded-read";
      details = { path };
    } else if (duplicate) {
      reason = "duplicate-read";
      details = duplicate;
    } else if (covered) {
      reason = "covered-read";
      details = covered;
    } else if (lowRiskBash) {
      reason = "after-consumption-bash";
      details = command ? { command } : {};
    } else if (
      source.staleUsers >= STALE_USER_ENTRIES &&
      estimateTokens(message) >= STALE_RESULT_TOKENS
    ) {
      reason = "standard-stale";
    }
    if (!reason) {
      continue;
    }

    const stub = formatStub(
      message.toolName ?? "tool",
      source.reference,
      reason,
      details,
    );
    const replacement = {
      ...message,
      content: [{ type: "text" as const, text: stub }],
    };
    const netSavings = estimateTokens(message) - estimateTokens(replacement);
    if (!Number.isSafeInteger(netSavings) || netSavings <= 0) {
      continue;
    }
    candidates.push({
      index,
      id: source.id,
      netSavings,
      reason,
      stub,
    });
  }
  return candidates.sort(
    (left, right) =>
      left.index - right.index || left.id.localeCompare(right.id),
  );
}

function collectToolCalls(messages: AgentMessage[]): Map<string, ToolCallInfo> {
  const calls = new Map<string, ToolCallInfo>();
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    for (const content of message.content) {
      if (content.type === "toolCall") {
        calls.set(content.id, { name: content.name, input: content.arguments });
      }
    }
  }
  return calls;
}

function collectMutations(
  messages: AgentMessage[],
  calls: ReadonlyMap<string, ToolCallInfo>,
  cwd: string,
): Map<string, number[]> {
  const mutations = new Map<string, number[]>();
  messages.forEach((message, index) => {
    if (
      !isToolResult(message) ||
      message.isError ||
      (message.toolName !== "edit" && message.toolName !== "write")
    ) {
      return;
    }
    const path = normalizePath(
      extractFilePath(message.toolName, calls.get(message.toolCallId)?.input),
      cwd,
    );
    if (path) {
      const positions = mutations.get(path) ?? [];
      positions.push(index);
      mutations.set(path, positions);
    }
  });
  return mutations;
}

type ReadEntry = ReadInterval & {
  index: number;
  id: string;
  keptUserTurn: number;
};

function collectReads(
  messages: AgentMessage[],
  calls: ReadonlyMap<string, ToolCallInfo>,
  cwd: string,
): ReadEntry[] {
  const userTurns = userEntriesUpTo(messages);
  const reads: ReadEntry[] = [];
  messages.forEach((message, index) => {
    if (
      !isToolResult(message) ||
      message.isError ||
      message.toolName !== "read"
    ) {
      return;
    }
    const interval = readInterval(message, calls.get(message.toolCallId), cwd);
    if (interval) {
      reads.push({
        ...interval,
        index,
        id: message.toolCallId,
        keptUserTurn: userTurns[index],
      });
    }
  });
  return reads;
}

function relationMap(
  reads: readonly ReadEntry[],
  mutations: ReadonlyMap<string, number[]>,
  exact: boolean,
): Map<string, ReadRelation> {
  const relations = new Map<string, ReadRelation>();
  for (let earlierIndex = 0; earlierIndex < reads.length; earlierIndex++) {
    const earlier = reads[earlierIndex];
    for (
      let laterIndex = earlierIndex + 1;
      laterIndex < reads.length;
      laterIndex++
    ) {
      const later = reads[laterIndex];
      if (
        earlier.path !== later.path ||
        hasMutationBetween(
          mutations.get(earlier.path),
          earlier.index,
          later.index,
        )
      ) {
        continue;
      }
      const matches = exact
        ? later.start === earlier.start && later.end === earlier.end
        : later.start <= earlier.start && later.end >= earlier.end;
      if (matches) {
        relations.set(earlier.id, {
          path: earlier.path,
          keptUserTurn: later.keptUserTurn,
        });
        break;
      }
    }
  }
  return relations;
}

function readPath(
  message: ToolResultMessage,
  call: ToolCallInfo | undefined,
  cwd: string,
): string | undefined {
  if (message.toolName !== "read") {
    return undefined;
  }
  return normalizePath(extractFilePath("read", call?.input), cwd) ?? undefined;
}

function readInterval(
  message: ToolResultMessage,
  call: ToolCallInfo | undefined,
  cwd: string,
): ReadInterval | undefined {
  const path = readPath(message, call, cwd);
  if (
    !path ||
    !isRecord(call?.input) ||
    message.content.length !== 1 ||
    message.content[0]?.type !== "text"
  ) {
    return undefined;
  }
  const offset = call.input.offset === undefined ? 1 : call.input.offset;
  const limit = call.input.limit;
  if (
    !Number.isInteger(offset) ||
    (offset as number) < 1 ||
    (limit !== undefined && (!Number.isInteger(limit) || (limit as number) < 1))
  ) {
    return undefined;
  }
  const requestedLimit = limit as number | undefined;
  const truncation = isRecord(
    (message as unknown as { details?: unknown }).details,
  )
    ? (message as unknown as { details: Record<string, unknown> }).details
        .truncation
    : undefined;
  if (
    !isTruncation(truncation) ||
    truncation.outputLines === 0 ||
    truncation.lastLinePartial ||
    truncation.firstLineExceedsLimit ||
    (requestedLimit !== undefined && truncation.outputLines > requestedLimit)
  ) {
    return undefined;
  }
  return {
    path,
    start: offset as number,
    end: (offset as number) + truncation.outputLines - 1,
  };
}

function isTruncation(value: unknown): value is {
  content: string;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  lastLinePartial: boolean;
  firstLineExceedsLimit: boolean;
  maxLines: number;
  maxBytes: number;
} {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "content",
      "totalLines",
      "totalBytes",
      "outputLines",
      "outputBytes",
      "truncated",
      "truncatedBy",
      "lastLinePartial",
      "firstLineExceedsLimit",
      "maxLines",
      "maxBytes",
    ]) ||
    typeof value.content !== "string" ||
    !nonnegativeInteger(value.totalLines) ||
    !nonnegativeInteger(value.totalBytes) ||
    !nonnegativeInteger(value.outputLines) ||
    !nonnegativeInteger(value.outputBytes) ||
    !positiveInteger(value.maxLines) ||
    !positiveInteger(value.maxBytes) ||
    typeof value.truncated !== "boolean" ||
    (value.truncatedBy !== "lines" &&
      value.truncatedBy !== "bytes" &&
      value.truncatedBy !== null) ||
    typeof value.lastLinePartial !== "boolean" ||
    typeof value.firstLineExceedsLimit !== "boolean" ||
    value.outputLines > value.totalLines ||
    value.outputBytes > value.totalBytes ||
    value.outputLines > value.maxLines ||
    value.outputBytes > value.maxBytes ||
    (value.truncatedBy === "bytes" && value.totalBytes <= value.maxBytes)
  ) {
    return false;
  }
  if (!value.truncated) {
    return (
      value.truncatedBy === null &&
      !value.lastLinePartial &&
      !value.firstLineExceedsLimit &&
      value.outputLines === value.totalLines &&
      value.outputBytes === value.totalBytes
    );
  }
  if (value.truncatedBy === null || value.lastLinePartial) {
    return false;
  }
  return value.firstLineExceedsLimit
    ? value.truncatedBy === "bytes" &&
        value.outputLines === 0 &&
        value.outputBytes === 0
    : value.truncatedBy === "lines"
      ? value.outputLines === value.maxLines &&
        value.totalLines > value.outputLines
      : value.outputBytes <= value.maxBytes &&
        value.totalLines > value.outputLines;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function hasLaterMutation(
  positions: readonly number[] | undefined,
  index: number,
): boolean {
  return positions?.some((position) => position > index) ?? false;
}

function hasMutationBetween(
  positions: readonly number[] | undefined,
  start: number,
  end: number,
): boolean {
  return (
    positions?.some((position) => position > start && position < end) ?? false
  );
}

function bashCommand(call: ToolCallInfo | undefined): string | undefined {
  return isRecord(call?.input) && typeof call.input.command === "string"
    ? call.input.command
    : undefined;
}

function userEntriesUpTo(messages: AgentMessage[]): number[] {
  const result = Array<number>(messages.length).fill(0);
  let count = 0;
  messages.forEach((message, index) => {
    if (message.role === "user") {
      count++;
    }
    result[index] = count;
  });
  return result;
}

function exposureAfterEach(entries: readonly ProjectedSessionEntry[]) {
  const edits = new Map<string, number>();
  const after: Array<{ consumed: boolean; staleUsers: number }> = [];
  let consumed = false;
  let staleUsers = 0;
  for (let index = entries.length - 1; index >= 0; index--) {
    const { sourceEntry, messages } = entries[index];
    if (
      sourceEntry.type === "context_edit" &&
      !edits.has(sourceEntry.targetId)
    ) {
      edits.set(sourceEntry.targetId, index);
    }
    after[index] = { consumed, staleUsers };
    if (
      messages.some(
        (message) =>
          message.role === "assistant" &&
          (message.stopReason === "stop" ||
            message.stopReason === "length" ||
            message.stopReason === "toolUse"),
      )
    ) {
      consumed = true;
    }
    staleUsers += messages.filter((message) => message.role === "user").length;
  }
  // A replacement is fresh content at its edit, not at the old source position.
  // Old assistants/users therefore establish neither consumption nor staleness.
  return new Map(
    entries.map(
      ({ sourceEntry }, index) =>
        [sourceEntry.id, after[edits.get(sourceEntry.id) ?? index]] as const,
    ),
  );
}

function selectEpoch(
  candidates: Candidate[],
  baseline: AgentMessage[],
  entries: SessionEntry[],
  ctx: ExtensionContext,
  state: PruningState,
): { kind: EpochKind; candidates: Candidate[] } | undefined {
  const suffixes = candidates.map((_, start) => candidates.slice(start));
  if (
    coldMarkerId(entries) !== state.warmedMarkerId &&
    isKnownCold(entries, ctx)
  ) {
    const suffix = suffixes.find(
      (members) => sumSavings(members) >= KNOWN_COLD_SAVINGS,
    );
    if (suffix) {
      return { kind: "known-cold", candidates: suffix };
    }
  }
  if (
    usersSinceWarmEpoch(entries, state.warmEpochEntryId) >= WARM_USER_ENTRIES
  ) {
    const suffix = suffixes.find((members) => {
      const savings = sumSavings(members);
      return (
        savings >= WARM_SAVINGS &&
        suffixDamage(baseline, members) / savings <= WARM_DAMAGE_RATIO
      );
    });
    if (suffix) {
      return { kind: "warm", candidates: suffix };
    }
  }
  const suffix = suffixes.find(
    (members) => suffixDamage(baseline, members) <= TAIL_DAMAGE,
  );
  return suffix ? { kind: "tail", candidates: suffix } : undefined;
}

function sumSavings(candidates: readonly Candidate[]): number {
  return candidates.reduce((sum, candidate) => sum + candidate.netSavings, 0);
}

function suffixDamage(
  messages: readonly AgentMessage[],
  candidates: readonly Candidate[],
): number {
  const index = candidates[0]?.index;
  return index === undefined
    ? 0
    : messages
        .slice(index)
        .reduce((sum, message) => sum + estimateTokens(message), 0);
}

function isKnownCold(
  entries: readonly unknown[],
  ctx: ExtensionContext,
): boolean {
  if (isAfterCompaction(entries)) {
    return true;
  }

  const model = ctx.model as { provider?: string; id?: string } | undefined;
  if (!model?.provider || !model.id) {
    return false;
  }
  let modelChangeIndex = -1;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (isRecord(entry) && entry.type === "model_change") {
      modelChangeIndex = index;
      break;
    }
  }
  if (modelChangeIndex < 1) {
    return false;
  }
  const change = entries[modelChangeIndex] as Record<string, unknown>;
  if (change.provider !== model.provider || change.modelId !== model.id) {
    return false;
  }
  const previousModelChange = entries
    .slice(0, modelChangeIndex)
    .reverse()
    .find((entry) => isRecord(entry) && entry.type === "model_change");
  if (
    !previousModelChange ||
    ((previousModelChange as Record<string, unknown>).provider ===
      model.provider &&
      (previousModelChange as Record<string, unknown>).modelId === model.id)
  ) {
    return false;
  }
  return !entries.slice(modelChangeIndex + 1).some((entry) => {
    if (!isRecord(entry)) {
      return false;
    }
    return (
      entry.type === "compaction" ||
      entry.type === "usage" ||
      (entry.type === "message" &&
        isRecord(entry.message) &&
        entry.message.role === "assistant")
    );
  });
}

function isAfterCompaction(entries: readonly unknown[]): boolean {
  let compactionIndex = -1;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (isRecord(entry) && entry.type === "compaction") {
      compactionIndex = index;
      break;
    }
  }
  if (compactionIndex < 0) {
    return false;
  }
  return !entries.slice(compactionIndex + 1).some((entry) => {
    return (
      isRecord(entry) &&
      (entry.type === "usage" ||
        (entry.type === "message" &&
          isRecord(entry.message) &&
          entry.message.role === "assistant"))
    );
  });
}

function usersSinceWarmEpoch(
  entries: readonly unknown[],
  warmEpochEntryId: string | undefined,
): number {
  const start = warmEpochEntryId
    ? entries.findIndex(
        (entry) => isRecord(entry) && entry.id === warmEpochEntryId,
      ) + 1
    : 0;
  return entries
    .slice(start)
    .filter(
      (entry) =>
        isRecord(entry) &&
        entry.type === "message" &&
        isRecord(entry.message) &&
        entry.message.role === "user",
    ).length;
}

function isPruningStub(message: ToolResultMessage): boolean {
  return (
    message.content.length === 1 &&
    message.content[0]?.type === "text" &&
    /^\[.* result elided: .*Call read_output\(\{reference:"transcript:v1:/s.test(
      message.content[0].text,
    )
  );
}

function isToolResult(message: AgentMessage): message is ToolResultMessage {
  return message.role === "toolResult";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
