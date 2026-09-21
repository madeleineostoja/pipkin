import {
  buildContextEntries,
  buildSessionContext,
  compact,
  convertToLlm,
  getLatestCompactionEntry,
  sessionEntryToContextMessages,
  type CompactionEntry,
  type ExtensionContext,
  type ExtensionEvent,
  type SessionBeforeCompactEvent,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import type { ModelPreset } from "#lib/config";
import { parseModelRef } from "#lib/model-ref";
import {
  CodexAdapterError,
  createCodexOAuthAdapter,
  type CaptureInput,
} from "./codex-oauth-adapter.ts";
import { projectPersistedPruning } from "./elision.ts";

const NATIVE_KIND = "pipkin-native-compaction";

type ModelSelectEvent = Extract<ExtensionEvent, { type: "model_select" }>;
type NativeAdapter = ReturnType<typeof createCodexOAuthAdapter>;
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
    const active = latestNative(event.branchEntries);
    if (active.kind === "candidate") {
      this.warn(
        ctx,
        "native-invalid",
        "Context: native checkpoint is invalid; select the original compatible Codex model to recover.",
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
        "Context: native checkpoint could not be safely replayed; the original request was left unchanged.",
      );
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
        "Context: this branch has an unrecognized native checkpoint. Select its original compatible Codex model/account to recover.",
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
    if (event.signal.aborted) {
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
      if (
        event.signal.aborted ||
        !result.summary.trim() ||
        !result.firstKeptEntryId ||
        !Number.isFinite(result.tokensBefore)
      ) {
        return undefined;
      }
      return { compaction: result };
    } catch {
      if (!event.signal.aborted) {
        this.warn(
          ctx,
          "low-failure",
          "Context: low model compaction failed; using Pi's current model compaction.",
        );
      }
      return undefined;
    }
  }

  private async nativeCompaction(
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
    existing?: CompactionEntry,
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
        currentContext(event.branchEntries, ctx, this.options.tools?.()),
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
        const creation = await this.captureCreationItems(
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
          creation,
        );
        if (!replayed) {
          throw new CodexAdapterError("validation", "checkpoint replay failed");
        }
        Object.assign(current, replayed);
      }
      const replacedItems = await this.newBoundaryItems(
        event,
        model,
        resolvedAuth,
        ctx,
      );
      const checkpoint = await this.adapter.compact({
        identity,
        model,
        auth: resolvedAuth,
        payload: current,
        replacedItems,
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
    entry: CompactionEntry,
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
    const creation = await this.captureCreationItems(
      entry,
      entries,
      model,
      resolvedAuth,
      ctx,
      ctx.signal,
    );
    return this.adapter.replay(
      payload,
      expected,
      entry.details,
      identity,
      creation,
    );
  }

  private async newBoundaryItems(
    event: SessionBeforeCompactEvent,
    model: Model<"openai-codex-responses">,
    auth: CaptureInput["auth"],
    ctx: ExtensionContext,
  ): Promise<Json[]> {
    const entries = buildContextEntries(event.branchEntries);
    const start = entries.findIndex(
      (entry) => entry.id === event.preparation.firstKeptEntryId,
    );
    if (start < 0) {
      throw new Error("missing compaction boundary");
    }
    return this.itemsFromContext(
      model,
      auth,
      contextForSegment(
        [
          markerEntry(event.preparation.firstKeptEntryId),
          ...entries.slice(start),
        ],
        event.branchEntries,
        ctx,
        this.options.tools?.(),
      ),
      ctx,
      event.signal,
    );
  }

  private async captureItems(
    entry: CompactionEntry,
    entries: SessionEntry[],
    model: Model<"openai-codex-responses">,
    auth: CaptureInput["auth"],
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
  ): Promise<Json[]> {
    return this.itemsFromContext(
      model,
      auth,
      checkpointSegment(entry, entries, entries, ctx, this.options.tools?.()),
      ctx,
      signal,
    );
  }

  private async captureCreationItems(
    entry: CompactionEntry,
    entries: SessionEntry[],
    model: Model<"openai-codex-responses">,
    auth: CaptureInput["auth"],
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
  ): Promise<Json[]> {
    const index = entries.findIndex((item) => item.id === entry.id);
    if (index < 0) {
      throw new Error("native checkpoint is not on the active branch");
    }
    return this.itemsFromContext(
      model,
      auth,
      checkpointSegment(
        entry,
        entries,
        entries.slice(0, index + 1),
        ctx,
        this.options.tools?.(),
      ),
      ctx,
      signal,
    );
  }

  private async itemsFromContext(
    model: Model<"openai-codex-responses">,
    auth: CaptureInput["auth"],
    context: Context,
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
  ): Promise<Json[]> {
    const payload = await this.capture(model, auth, context, ctx, signal);
    if (!Array.isArray(payload.input) || !payload.input.every(isJson)) {
      throw new Error("invalid Codex canonical input");
    }
    return payload.input;
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
  // The compatibility facade deliberately omits baseUrl. Its provider-auth
  // result preserves the resolved override used to construct Pi requests.
  const getProviderAuth = (
    ctx.modelRegistry as typeof ctx.modelRegistry & {
      getProviderAuth?: (provider: string) => Promise<
        | {
            auth: { baseUrl?: string };
          }
        | undefined
      >;
    }
  ).getProviderAuth;
  const providerAuth = getProviderAuth
    ? await getProviderAuth.call(ctx.modelRegistry, model.provider)
    : undefined;
  return {
    ok: true,
    apiKey: requestAuth.apiKey,
    headers: requestAuth.headers,
    baseUrl: providerAuth?.auth.baseUrl,
  };
}

function registryStream(ctx: ExtensionContext) {
  return (model: Model<Api>, context: Context, options = {}) =>
    ctx.modelRegistry.streamSimple(model, context, options);
}

function currentContext(
  entries: SessionEntry[],
  ctx: ExtensionContext,
  tools: Context["tools"],
): Context {
  return contextWithSystemFallback(
    convertToLlm(
      projectPersistedPruning(entries, buildSessionContext(entries).messages),
    ),
    ctx,
    tools,
  );
}

function checkpointSegment(
  entry: CompactionEntry,
  entries: SessionEntry[],
  pruningEntries: SessionEntry[],
  ctx: ExtensionContext,
  tools: Context["tools"],
): Context {
  // Project the branch at the checkpoint itself. Persisted pruning decisions
  // from later entries still apply, but later turns are never replay targets.
  const contextEntries = buildContextEntries(entries, entry.id);
  const start = contextEntries.findIndex((item) => item.id === entry.id);
  if (start < 0) {
    throw new Error("native checkpoint is not in the projected branch");
  }
  return contextForSegment(
    contextEntries.slice(start),
    pruningEntries,
    ctx,
    tools,
  );
}

function contextForSegment(
  entries: SessionEntry[],
  pruningEntries: SessionEntry[],
  ctx: ExtensionContext,
  tools: Context["tools"],
): Context {
  return contextWithSystemFallback(
    convertToLlm(
      projectPersistedPruning(
        pruningEntries,
        entries.flatMap(sessionEntryToContextMessages),
      ),
    ),
    ctx,
    tools,
  );
}

function contextWithSystemFallback(
  messages: Context["messages"],
  ctx: ExtensionContext,
  tools: Context["tools"],
): Context {
  return messages[0]?.role === "system"
    ? { messages }
    : { systemPrompt: ctx.getSystemPrompt(), messages, tools };
}

function markerEntry(firstKeptEntryId: string): CompactionEntry {
  return {
    type: "compaction",
    id: "pipkin-native-marker",
    parentId: null,
    timestamp: new Date(0).toISOString(),
    summary:
      "[Context compacted by OpenAI Codex. The authoritative prior context is an opaque provider checkpoint and is not portable to another model or provider.]",
    firstKeptEntryId,
    tokensBefore: 0,
  };
}

function matchesLineage(
  entry: CompactionEntry,
  entries: SessionEntry[],
): boolean {
  const details = createCodexOAuthAdapter().validate(entry.details);
  return (
    !!details &&
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
  | { kind: "valid"; entry: CompactionEntry } {
  const entry = getLatestCompactionEntry(entries);
  if (!entry || !isNativeCandidate(entry.details)) {
    return { kind: "none" };
  }
  return validateNative(entry.details)
    ? { kind: "valid", entry }
    : { kind: "candidate", entry };
}

function validateNative(details: unknown): boolean {
  return createCodexOAuthAdapter().validate(details) !== undefined;
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
    case "timeout":
      return "request timed out";
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

function isJson(value: unknown): value is Json {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJson);
  }
  return isJsonObject(value) && Object.values(value).every(isJson);
}
