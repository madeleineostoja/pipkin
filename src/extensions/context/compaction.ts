import {
  buildSessionProjection,
  compact,
  convertToLlm,
  getLatestCompactionEntry,
  type CompactionEntry,
  type ExtensionContext,
  type ExtensionEvent,
  type SessionBeforeCompactEvent,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  getCurrentTools,
  type Api,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import type { ModelPreset } from "#lib/config";
import { parseModelRef } from "#lib/model-ref";
import {
  CodexAdapterError,
  NATIVE_COMPACTION_MARKER,
  createCodexOAuthAdapter,
  type CaptureInput,
} from "./codex-oauth-adapter.ts";

const NATIVE_KIND = "pipkin-native-compaction";

type ModelSelectEvent = Extract<ExtensionEvent, { type: "model_select" }>;
type NativeAdapter = ReturnType<typeof createCodexOAuthAdapter>;
type NativeEntry = CompactionEntry & {
  details: NonNullable<ReturnType<NativeAdapter["validate"]>>;
};
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
type CompactionHookResult =
  | { compaction: Awaited<ReturnType<typeof compact>> }
  | { cancel: true }
  | undefined;
type NativeCompactionOutcome =
  | { kind: "complete"; compaction: Awaited<ReturnType<typeof compact>> }
  | { kind: "unavailable" }
  | { kind: "cancelled" }
  | { kind: "failed"; reason: string };

export type NativeFailureOutcome = "models-low" | "pi" | "cancelled";

type CoordinatorOptions = {
  low: ModelPreset | undefined;
  lowIssue?: string;
  configPath: string;
  adapter?: NativeAdapter;
  tools?: () => Context["tools"];
  reportNativeFailure?: (reason: string, outcome: NativeFailureOutcome) => void;
};

/** Coordinates Pi's summary algorithm and the provider-specific opaque route. */
export class CompactionCoordinator {
  private readonly adapter: NativeAdapter;
  private readonly warned = new Set<string>();

  constructor(private readonly options: CoordinatorOptions) {
    this.adapter = options.adapter ?? createCodexOAuthAdapter();
  }

  sessionStart(): void {
    this.warned.clear();
  }

  async beforeCompact(
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
  ): Promise<CompactionHookResult> {
    if (event.signal.aborted) {
      return { cancel: true };
    }
    const active = latestNative(event.branchEntries);
    if (active.kind === "candidate") {
      this.warn(
        ctx,
        "native-invalid",
        "Context: native checkpoint metadata is invalid; compaction was cancelled to preserve its opaque context.",
      );
      return { cancel: true };
    }
    if (active.kind === "valid") {
      if (event.customInstructions) {
        this.warn(
          ctx,
          "native-instructed",
          "Context: an opaque Codex checkpoint cannot be compacted with custom instructions. Return to its compatible Codex model to continue.",
        );
        return { cancel: true };
      }
      const native = await this.nativeCompaction(event, ctx, active.entry);
      if (native.kind === "complete") {
        return { compaction: native.compaction };
      }
      if (native.kind === "cancelled") {
        return { cancel: true };
      }
      this.reportNativeFailure(
        ctx,
        native.kind === "failed"
          ? native.reason
          : "compatible Codex OAuth route is unavailable",
        "cancelled",
      );
      return { cancel: true };
    }

    if (!event.customInstructions && ctx.model && isCodexSurface(ctx.model)) {
      const native = await this.nativeCompaction(event, ctx);
      if (native.kind === "complete") {
        return { compaction: native.compaction };
      }
      if (native.kind === "cancelled") {
        return { cancel: true };
      }
      if (native.kind === "failed") {
        const fallback = await this.textualCompaction(event, ctx);
        const outcome =
          fallback && "compaction" in fallback
            ? "models-low"
            : event.signal.aborted
              ? "cancelled"
              : "pi";
        this.reportNativeFailure(ctx, native.reason, outcome);
        return fallback;
      }
    }
    return this.textualCompaction(event, ctx);
  }

  async beforeProviderRequest(
    payload: unknown,
    ctx: ExtensionContext,
  ): Promise<unknown | undefined> {
    const active = latestNative(ctx.sessionManager.getBranch());
    if (active.kind === "none") {
      return undefined;
    }
    if (active.kind === "candidate") {
      this.warn(
        ctx,
        "native-invalid",
        "Context: native checkpoint is invalid and was not sent to the provider.",
      );
      ctx.abort();
      return undefined;
    }
    let result: unknown | undefined;
    try {
      result = await this.replay(active.entry, payload, ctx);
    } catch {
      result = undefined;
    }
    if (!result) {
      this.warn(
        ctx,
        "native-replay",
        "Context: native checkpoint could not be safely replayed; the request was aborted to preserve its context.",
      );
      ctx.abort();
    }
    return result;
  }

  async modelSelect(
    event: ModelSelectEvent,
    ctx: ExtensionContext,
  ): Promise<void> {
    const active = latestNative(ctx.sessionManager.getBranch());
    if (active.kind === "none") {
      return;
    }
    if (active.kind === "candidate") {
      this.warn(
        ctx,
        "native-invalid",
        "Context: this branch has an unrecognized native checkpoint. Its original checkpoint must be restored before safe continuation.",
      );
      return;
    }
    try {
      const auth = await resolveCodexAuth(
        ctx,
        event.model as Model<"openai-codex-responses">,
      );
      const identity =
        auth &&
        this.adapter.supports(
          event.model as Model<"openai-codex-responses">,
          auth,
          ctx.modelRegistry.isUsingOAuth(event.model),
        );
      if (
        identity &&
        this.adapter.isCompatible(active.entry.details, identity)
      ) {
        return;
      }
    } catch {
      // A request-time check still prevents an incompatible checkpoint injection.
    }
    this.warn(
      ctx,
      "native-model",
      "Context: this native checkpoint cannot continue on the selected model/account. Select the original compatible Codex model/account to restore continuation.",
    );
  }

  private async textualCompaction(
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
  ): Promise<CompactionHookResult> {
    if (event.signal.aborted) {
      return { cancel: true };
    }
    const preset = this.options.low;
    if (!preset || this.options.lowIssue) {
      this.warn(
        ctx,
        "low-config",
        `Context: Pipkin config ${this.options.configPath}: low preset ${this.options.lowIssue ?? "is unavailable"}; using Pi's current model compaction.`,
      );
      return undefined;
    }
    const reference = parseModelRef(preset.model);
    const model =
      reference && ctx.modelRegistry.find(reference.provider, reference.id);
    if (!model) {
      this.warn(
        ctx,
        "low-model",
        `Context: low compaction model ${preset.model} is unavailable; using Pi's current model compaction.`,
      );
      return undefined;
    }
    try {
      const result = await compact(
        event.preparation,
        model,
        undefined,
        undefined,
        event.customInstructions,
        event.signal,
        preset.thinking,
        registryStream(ctx),
      );
      if (event.signal.aborted) {
        return { cancel: true };
      }
      if (
        !result.summary.trim() ||
        !result.firstKeptEntryId ||
        !Number.isFinite(result.tokensBefore)
      ) {
        return undefined;
      }
      return { compaction: result };
    } catch {
      if (event.signal.aborted) {
        return { cancel: true };
      }
      this.warn(
        ctx,
        "low-failure",
        "Context: low model compaction failed; using Pi's current model compaction.",
      );
      return undefined;
    }
  }

  private async nativeCompaction(
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
    existing?: NativeEntry,
  ): Promise<NativeCompactionOutcome> {
    if (!ctx.model) {
      return { kind: "unavailable" };
    }
    if (event.signal.aborted) {
      return { kind: "cancelled" };
    }
    const model = ctx.model as Model<"openai-codex-responses">;
    try {
      const resolvedAuth = await resolveCodexAuth(ctx, model);
      if (!resolvedAuth) {
        return { kind: "unavailable" };
      }
      const identity = this.adapter.supports(
        model,
        resolvedAuth,
        ctx.modelRegistry.isUsingOAuth(model),
      );
      if (!identity) {
        return { kind: "unavailable" };
      }
      if (existing && !matchesLineage(existing, event.branchEntries)) {
        throw new CodexAdapterError("validation", "checkpoint lineage changed");
      }
      const current = await this.capture(
        model,
        resolvedAuth,
        currentContext(ctx, this.options.tools?.()),
        ctx,
        event.signal,
      );
      if (existing) {
        const expected = await this.captureItems(
          existing,
          event.branchEntries,
          model,
          resolvedAuth,
          ctx,
          event.signal,
        );
        const replayed = this.adapter.replay(
          current,
          expected,
          existing.details,
          identity,
        );
        if (!replayed) {
          throw new CodexAdapterError("validation", "checkpoint replay failed");
        }
        Object.assign(current, replayed);
      }
      const checkpoint = await this.adapter.compact({
        identity,
        model,
        auth: resolvedAuth,
        payload: current,
        lineage: {
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          leafId: ctx.sessionManager.getLeafId(),
        },
        sessionId: ctx.sessionManager.getSessionId(),
        signal: event.signal,
      });
      return {
        kind: "complete",
        compaction: {
          summary: checkpoint.summary,
          details: checkpoint.details,
          usage: checkpoint.usage,
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
        },
      };
    } catch (error) {
      if (
        event.signal.aborted ||
        (error instanceof CodexAdapterError && error.code === "aborted")
      ) {
        return { kind: "cancelled" };
      }
      return { kind: "failed", reason: nativeFailureReason(error) };
    }
  }

  private async replay(
    entry: NativeEntry,
    payload: unknown,
    ctx: ExtensionContext,
  ): Promise<unknown | undefined> {
    if (!ctx.model || !isJsonObject(payload)) {
      return undefined;
    }
    const model = ctx.model as Model<"openai-codex-responses">;
    const resolvedAuth = await resolveCodexAuth(ctx, model);
    if (!resolvedAuth) {
      return undefined;
    }
    const identity = this.adapter.supports(
      model,
      resolvedAuth,
      ctx.modelRegistry.isUsingOAuth(model),
    );
    if (!identity) {
      return undefined;
    }
    const entries = ctx.sessionManager.getBranch();
    if (!matchesLineage(entry, entries)) {
      return undefined;
    }
    const expected = await this.captureItems(
      entry,
      entries,
      model,
      resolvedAuth,
      ctx,
      ctx.signal,
    );
    return this.adapter.replay(payload, expected, entry.details, identity);
  }

  private async captureItems(
    entry: CompactionEntry,
    entries: SessionEntry[],
    model: Model<"openai-codex-responses">,
    auth: CaptureInput["auth"],
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
  ): Promise<Json[]> {
    const payload = await this.capture(
      model,
      auth,
      checkpointSegment(entry, entries, ctx, this.options.tools?.()),
      ctx,
      signal,
    );
    return payload.input as Json[];
  }

  private capture(
    model: Model<"openai-codex-responses">,
    auth: CaptureInput["auth"],
    context: Context,
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
  ): Promise<JsonObject> {
    return this.adapter.capture({
      model,
      context,
      auth,
      thinking: ctx.thinkingLevel as CaptureInput["thinking"],
      sessionId: ctx.sessionManager.getSessionId(),
      signal,
    });
  }

  private reportNativeFailure(
    ctx: ExtensionContext,
    reason: string,
    outcome: NativeFailureOutcome,
  ): void {
    try {
      if (this.options.reportNativeFailure) {
        this.options.reportNativeFailure(reason, outcome);
        return;
      }
    } catch {
      // Reporting must not change the selected compaction path.
    }
    try {
      ctx.ui.notify(
        `Context: Codex native compaction failed: ${reason}. ${nativeFailureOutcomeText(outcome)}`,
        outcome === "cancelled" ? "error" : "warning",
      );
    } catch {
      // The selected compaction path remains authoritative without a diagnostic.
    }
  }

  private warn(
    ctx: ExtensionContext,
    condition: string,
    message: string,
  ): void {
    if (this.warned.has(condition)) {
      return;
    }
    this.warned.add(condition);
    try {
      ctx.ui.notify(message, "warning");
    } catch {
      // Diagnostics must not change the coordinator's compaction decision.
    }
  }
}

export function createCompactionCoordinator(options: CoordinatorOptions) {
  return new CompactionCoordinator(options);
}

async function resolveCodexAuth(
  ctx: ExtensionContext,
  model: Model<"openai-codex-responses">,
): Promise<CaptureInput["auth"] | undefined> {
  const requestAuth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!requestAuth.ok || !requestAuth.apiKey) {
    return undefined;
  }
  return {
    ok: true,
    apiKey: requestAuth.apiKey,
    headers: requestAuth.headers,
    baseUrl: requestAuth.baseUrl,
  };
}

function registryStream(ctx: ExtensionContext) {
  return (model: Model<Api>, context: Context, options = {}) =>
    ctx.modelRegistry.streamSimple(model, context, options);
}

function currentContext(
  ctx: ExtensionContext,
  tools: Context["tools"],
): Context {
  return contextWithCurrentSystem(
    convertToLlm(ctx.sessionManager.buildSessionProjection().messages),
    ctx,
    tools,
  );
}

function checkpointSegment(
  entry: CompactionEntry,
  entries: SessionEntry[],
  ctx: ExtensionContext,
  tools: Context["tools"],
): Context {
  // Checkpoint-era edits are part of its identity. Later edits must match this
  // exact segment or replay fails closed; later turns stay outside the target.
  const projection = buildSessionProjection(entries, entry.id);
  const start = projection.entries.findIndex(
    (item) => item.sourceEntry.id === entry.id,
  );
  if (start < 0) {
    throw new Error("native checkpoint is not in the projected branch");
  }
  return contextWithCurrentSystem(
    convertToLlm(
      projection.entries.slice(start).flatMap((item) => item.messages),
    ),
    ctx,
    tools,
  );
}

function contextWithCurrentSystem(
  messages: Context["messages"],
  ctx: ExtensionContext,
  tools: Context["tools"],
): Context {
  // Pi's current prompt can be a forced projection not persisted in the branch.
  // Codex collapses system transitions; use the same current prompt/tool state.
  return {
    systemPrompt: ctx.getSystemPrompt(),
    messages: messages.filter((message) => message.role !== "system"),
    tools: tools ?? getCurrentTools(messages),
  };
}

function matchesLineage(entry: NativeEntry, entries: SessionEntry[]): boolean {
  const details = entry.details;
  return (
    details.lineage.firstKeptEntryId === entry.firstKeptEntryId &&
    details.lineage.leafId === entry.parentId &&
    entries.some((item) => item.id === entry.id)
  );
}

function latestNative(
  entries: SessionEntry[],
):
  | { kind: "none" }
  | { kind: "candidate"; entry: CompactionEntry }
  | { kind: "valid"; entry: NativeEntry } {
  const entry = getLatestCompactionEntry(entries);
  if (!entry) {
    return { kind: "none" };
  }
  const candidates = entries.filter(
    (item) =>
      item.type === "compaction" &&
      (item.summary === NATIVE_COMPACTION_MARKER ||
        isNativeCandidate(item.details)),
  );
  if (!candidates.length) {
    return { kind: "none" };
  }
  if (!candidates.includes(entry)) {
    return { kind: "candidate", entry };
  }
  const details = createCodexOAuthAdapter().validate(entry.details);
  return details
    ? { kind: "valid", entry: { ...entry, details } }
    : { kind: "candidate", entry };
}

function isNativeCandidate(value: unknown): value is { kind: string } {
  return isJsonObject(value) && value.kind === NATIVE_KIND;
}

function nativeFailureOutcomeText(outcome: NativeFailureOutcome): string {
  switch (outcome) {
    case "models-low":
      return "Using the models.low textual fallback.";
    case "pi":
      return "Falling back to Pi's active-model compaction.";
    case "cancelled":
      return "Compaction was cancelled.";
  }
}

function nativeFailureReason(error: unknown): string {
  if (!(error instanceof CodexAdapterError)) {
    return "internal adapter failure";
  }
  switch (error.code) {
    case "aborted":
      return "request aborted";
    case "auth":
      return "authentication failed";
    case "capture":
      return "provider payload capture failed";
    case "transport":
      return "transport failed";
    case "http": {
      const status = /\(([1-5]\d{2})\)$/.exec(error.message)?.[1];
      return status ? `request failed (${status})` : "request failed";
    }
    case "protocol":
      return "provider response was invalid";
    case "validation":
      return "checkpoint validation failed";
  }
}

function isCodexSurface(model: Model<Api>): boolean {
  return (
    model.provider === "openai-codex" && model.api === "openai-codex-responses"
  );
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
