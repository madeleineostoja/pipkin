import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  reserveOutput,
  entryFingerprint,
  type CaptureHandle,
  type Retention,
  type CaptureData,
  type OutputHost,
} from "#context/retained-output";
import { StringDecoder } from "node:string_decoder";
import {
  startSandboxManagedExecution,
  sandboxCleanupExecution,
  type SandboxExecutionLease,
} from "#sandbox/bash";

const MAX_ACTIVE = 8;
const MAX_RECORDS = 32;
const MAX_WAITERS = 16;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_PROJECTION_LINES = 200;
const MAX_PROJECTION_BYTES = 18 * 1024;
const MAX_WAIT_TIMEOUT_SECONDS = 2_147_483_647 / 1000;
const DEFAULT_TAIL_LINES = 80;

type Stream = "stdout" | "stderr";

export type ProcessStatus = "running" | "completed" | "failed" | "stopped";
export type ProcessWaitOutcome =
  | "snapshot"
  | "terminal"
  | "timed_out"
  | "cancelled";

export type ProcessSnapshot = Readonly<{
  id: string;
  status: ProcessStatus;
  description: string;
  command: string;
  cwd: string;
  pid: number;
  exitCode: number | null;
  signal: string | null;
  startedAt: string;
  endedAt?: string;
  retainedBytes: number;
  droppedBytes: number;
  outputComplete: boolean;
}>;

export type ProcessSubscription = (
  snapshot: ProcessSnapshot | undefined,
) => void;
export type ProcessProjection = Readonly<{
  output: string;
  selector: Readonly<{
    type: "tail";
    requestedLines: number;
    sourceLines: number;
    outputTruncated: boolean;
  }>;
}>;
export type ProcessInspectionOutput = Readonly<{
  output: string;
  firstRetainedLine: number;
  prefixLines: number;
}>;

type OutputPart = { stream: Stream; text: string; bytes: number };
type RecordState = {
  snapshot: ProcessSnapshot;
  output: OutputPart[];
  firstRetainedLine: number;
};
type Waiter = {
  finish: (outcome: ProcessWaitOutcome) => void;
};
type ProcessRecord = RecordState & {
  lease: SandboxExecutionLease;
  stdout: StringDecoder;
  stderr: StringDecoder;
  waiters: Set<Waiter>;
  capture: CaptureHandle;
  retention?: Retention;
  settlement: Promise<void>;
  finalization?: Promise<void>;
  cleanupError?: { code: string; message: string };
  completionFailed?: boolean;
  released?: boolean;
};
type LogicalLine = { stream: Stream; text: string; number: number };

function copy(snapshot: ProcessSnapshot): ProcessSnapshot {
  return { ...snapshot };
}

export function normalizeProcessDescription(description: string): string {
  const normalized = Array.from(description, (character) =>
    /\p{C}/u.test(character) ? " " : character,
  )
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  if ([...normalized].length < 1 || [...normalized].length > 120) {
    throw new Error(
      "process_start: description must normalize to 1–120 Unicode code points",
    );
  }
  return normalized;
}

function terminal(status: ProcessStatus): boolean {
  return status !== "running";
}

function sanitiseLine(text: string): string {
  return Array.from(text, (character) =>
    character === "\t" || !/\p{C}/u.test(character) ? character : "�",
  ).join("");
}

function truncateUtf8(text: string, maxBytes: number): string {
  let bytes = 0;
  let result = "";
  for (const character of text) {
    const length = Buffer.byteLength(character);
    if (bytes + length > maxBytes) {
      return `${result}…`;
    }
    bytes += length;
    result += character;
  }
  return result;
}

function suffixAtUtf8Boundary(text: string, maxBytes: number): string {
  let bytes = 0;
  let start = text.length;
  for (const character of Array.from(text).reverse()) {
    const length = Buffer.byteLength(character);
    if (bytes + length > maxBytes) {
      break;
    }
    bytes += length;
    start -= character.length;
  }
  return text.slice(start);
}

function trimPartPrefix(part: OutputPart, bytes: number): number {
  if (bytes <= 0) {
    return 0;
  }
  if (bytes >= part.bytes) {
    const removed = part.bytes;
    part.text = "";
    part.bytes = 0;
    return removed;
  }
  const retained = suffixAtUtf8Boundary(part.text, part.bytes - bytes);
  const removed = part.bytes - Buffer.byteLength(retained);
  part.text = retained;
  part.bytes -= removed;
  return removed;
}

export class ProcessRuntime {
  #records = new Map<string, ProcessRecord>();
  #reservations = 0;
  #nextId = 1;
  #disposed = false;
  #staging = new Set<AbortController>();
  #stagingSettlements = new Set<Promise<void>>();
  #subscribers = new Set<(snapshots: readonly ProcessSnapshot[]) => void>();
  #recordSubscribers = new Map<string, Set<ProcessSubscription>>();

  constructor(
    private readonly host: object,
    private readonly bashActive: () => boolean,
  ) {}

  snapshots(): readonly ProcessSnapshot[] {
    return [...this.#records.values()].map((record) => copy(record.snapshot));
  }

  subscribe(
    listener: (snapshots: readonly ProcessSnapshot[]) => void,
  ): () => void {
    if (this.#disposed) {
      return () => undefined;
    }
    this.#subscribers.add(listener);
    return () => this.#subscribers.delete(listener);
  }

  subscribeRecord(id: string, listener: ProcessSubscription): () => void {
    if (this.#disposed) {
      return () => undefined;
    }
    const listeners = this.#recordSubscribers.get(id) ?? new Set();
    listeners.add(listener);
    this.#recordSubscribers.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.#recordSubscribers.delete(id);
      }
    };
  }

  async start(input: {
    command: string;
    description: string;
    cwd: string;
    ctx: ExtensionContext;
    signal: AbortSignal | undefined;
    toolCallId?: string;
  }): Promise<ProcessSnapshot> {
    if (this.#disposed) {
      throw new Error("Processes: session is shutting down.");
    }
    if (!this.bashActive()) {
      throw new Error("process_start: bash is inactive");
    }
    if (!input.command.trim()) {
      throw new Error("process_start: command must not be empty");
    }
    const description = normalizeProcessDescription(input.description);
    if (this.#reservations + this.activeCount() >= MAX_ACTIVE) {
      throw new Error("process_start: maximum of 8 active processes reached");
    }
    this.#reservations += 1;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (input.signal?.aborted) {
      controller.abort();
    } else {
      input.signal?.addEventListener("abort", abort, { once: true });
    }
    this.#staging.add(controller);
    let finishStaging: () => void = () => undefined;
    const stagingSettlement = new Promise<void>(
      (resolve) => (finishStaging = resolve),
    );
    this.#stagingSettlements.add(stagingSettlement);
    const id = `process-${this.#nextId++}`;
    let capture: CaptureHandle | undefined;
    try {
      capture = reserveOutput(this.host as OutputHost, input.ctx, {
        sourceTool: "process_start",
        callId: input.toolCallId ?? id,
        jobId: id,
        command: input.command,
        cwd: input.cwd,
        description,
      });
      const stdout = new StringDecoder("utf8");
      const stderr = new StringDecoder("utf8");
      const staging: RecordState = {
        snapshot: {
          id,
          status: "running",
          description,
          command: input.command,
          cwd: input.cwd,
          pid: 0,
          exitCode: null,
          signal: null,
          startedAt: new Date().toISOString(),
          retainedBytes: 0,
          droppedBytes: 0,
          outputComplete: true,
        },
        output: [],
        firstRetainedLine: 1,
      };
      let observed: RecordState = staging;
      const lease = await startSandboxManagedExecution(this.host as never, {
        toolCallId: input.toolCallId ?? id,
        command: input.command,
        cwd: input.cwd,
        ctx: input.ctx,
        signal: controller.signal,
        onOutput: ({ stream, data }) =>
          this.append(
            observed,
            stream,
            (stream === "stdout" ? stdout : stderr).write(data),
          ),
      });
      const record: ProcessRecord = {
        ...staging,
        lease,
        stdout,
        stderr,
        waiters: new Set(),
        capture,
        settlement: Promise.resolve(),
      };
      observed = record;
      record.snapshot = { ...record.snapshot, pid: lease.pid };
      await Promise.all(
        [...this.#records.values()]
          .filter((record) => terminal(record.snapshot.status))
          .map((record) => record.finalization),
      );
      if (this.#disposed) {
        await this.settle(record, await lease.stop());
        throw new Error("Processes: session is shutting down.");
      }
      this.evictForSuccessfulLaunch();
      this.#reservations -= 1;
      this.#records.set(id, record);
      record.settlement = lease.completion.then(
        (result) => this.settle(record, result),
        (error: unknown) => {
          record.completionFailed = true;
          this.cleanupFailed(record, error);
        },
      );
      await Promise.resolve();
      this.emit(record);
      return copy(record.snapshot);
    } catch (error) {
      capture?.release();
      this.#reservations -= 1;
      throw error;
    } finally {
      input.signal?.removeEventListener("abort", abort);
      this.#staging.delete(controller);
      this.#stagingSettlements.delete(stagingSettlement);
      finishStaging();
    }
  }

  snapshot(id: string): ProcessSnapshot {
    return copy(this.require(id).snapshot);
  }

  async result(
    id: string,
    wait: boolean,
    timeoutSeconds: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{
    snapshot: ProcessSnapshot;
    waitOutcome: ProcessWaitOutcome;
    output: string;
    selector: ProcessProjection["selector"];
    retention: Retention;
    error?: { code: string; message: string };
  }> {
    this.validateResult(wait, timeoutSeconds);
    const record = this.require(id);
    let waitOutcome: ProcessWaitOutcome = "snapshot";
    if (wait) {
      waitOutcome = signal?.aborted
        ? "cancelled"
        : terminal(record.snapshot.status)
          ? "terminal"
          : record.completionFailed
            ? "snapshot"
            : await this.wait(record, timeoutSeconds, signal);
    }
    if (terminal(record.snapshot.status)) {
      await record.finalization;
    }
    const projection = this.project(record);
    const snapshot = copy(record.snapshot);
    const retention = await this.captureSnapshot(record);
    return {
      snapshot,
      waitOutcome,
      ...projection,
      retention,
      ...(record.cleanupError ? { error: record.cleanupError } : {}),
    };
  }

  async inspectionOutput(id: string): Promise<ProcessInspectionOutput> {
    return this.inspectOutput(this.require(id));
  }

  async stop(id: string): Promise<{
    snapshot: ProcessSnapshot;
    output: string;
    selector: ProcessProjection["selector"];
    retention: Retention;
    error?: { code: string; message: string };
    waitOutcome: ProcessWaitOutcome;
  }> {
    const record = this.require(id);
    let error: { code: string; message: string } | undefined;
    if (!terminal(record.snapshot.status)) {
      try {
        await this.settle(record, await record.lease.stop());
      } catch (failure) {
        this.cleanupFailed(record, failure);
        error = record.cleanupError;
      }
    }
    const snapshot = copy(record.snapshot);
    const projection = this.project(record);
    const retention = await this.captureSnapshot(record);
    return {
      snapshot,
      ...projection,
      retention,
      ...(error ? { error } : {}),
      waitOutcome:
        error || snapshot.status === "running" ? "snapshot" : "terminal",
    };
  }

  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    for (const controller of this.#staging) {
      controller.abort();
    }
    await Promise.allSettled(this.#stagingSettlements);
    const results = await Promise.allSettled(
      [...this.#records.values()].map(async (record) => {
        try {
          if (terminal(record.snapshot.status)) {
            await record.finalization;
          } else {
            try {
              // Sandbox owns bounded termination. A rejected stop does not
              // imply that its completion promise will ever settle.
              await this.settle(record, await record.lease.stop());
            } catch (error) {
              this.cleanupFailed(record, error);
              record.retention = await record.capture.commit(
                this.captureData(record),
              );
              throw new Error(record.cleanupError!.message);
            }
          }
        } finally {
          record.released = true;
          record.capture.release();
          for (const waiter of record.waiters) {
            waiter.finish("cancelled");
          }
          record.waiters.clear();
        }
      }),
    );
    this.#records.clear();
    this.#subscribers.clear();
    this.#recordSubscribers.clear();
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length) {
      throw new AggregateError(
        failures.map((result) => result.reason),
        "Processes: process cleanup unavailable during shutdown.",
      );
    }
  }

  authorizedSnapshots(ctx: ExtensionContext): readonly ProcessSnapshot[] {
    return [...this.#records.values()]
      .filter((record) => this.owns(record, ctx))
      .map((record) => copy(record.snapshot));
  }

  assertOwned(id: string, ctx: ExtensionContext): void {
    const record = this.#records.get(id);
    if (!record || !this.owns(record, ctx)) {
      throw new Error("Processes: not found");
    }
  }

  private owns(record: ProcessRecord, ctx: ExtensionContext): boolean {
    const origin = record.capture.origin;
    if (origin.sessionId !== ctx.sessionManager.getSessionId()) {
      return false;
    }
    return origin.anchor === null
      ? ctx.sessionManager.getEntries().length === 0
      : ctx.sessionManager
          .getBranch()
          .some(
            (entry) =>
              entry.id === origin.anchor &&
              entryFingerprint(entry) === origin.anchorFingerprint,
          );
  }

  private captureData(record: ProcessRecord): CaptureData {
    const snapshot = record.snapshot;
    return {
      execution: {
        state: snapshot.status,
        exitCode: snapshot.exitCode,
        signal: snapshot.signal,
        startedAt: snapshot.startedAt,
        ...(snapshot.endedAt ? { endedAt: snapshot.endedAt } : {}),
      },
      text: record.output.map((part) => part.text).join(""),
      truncated: snapshot.droppedBytes > 0,
      outputComplete: snapshot.outputComplete,
      droppedBytes: snapshot.droppedBytes,
    };
  }

  private async captureSnapshot(record: ProcessRecord): Promise<Retention> {
    if (terminal(record.snapshot.status)) {
      await record.finalization;
      return record.retention!;
    }
    return record.capture.snapshot(this.captureData(record));
  }

  private activeCount(): number {
    return [...this.#records.values()].filter(
      (record) => !terminal(record.snapshot.status),
    ).length;
  }

  private require(id: string): ProcessRecord {
    const record = this.#records.get(id);
    if (!record) {
      throw new Error(`Processes: unknown or evicted process ${id}`);
    }
    return record;
  }

  private validateResult(
    wait: boolean,
    timeoutSeconds: number | undefined,
  ): void {
    if (!wait && timeoutSeconds !== undefined) {
      throw new Error("process_inspect: timeoutSeconds requires process_wait");
    }
    if (
      timeoutSeconds !== undefined &&
      (!Number.isFinite(timeoutSeconds) ||
        timeoutSeconds <= 0 ||
        timeoutSeconds > MAX_WAIT_TIMEOUT_SECONDS)
    ) {
      throw new Error("process_wait: invalid timeoutSeconds");
    }
  }

  private evictForSuccessfulLaunch(): void {
    while (this.#records.size >= MAX_RECORDS) {
      const oldest = [...this.#records.values()].find((record) =>
        terminal(record.snapshot.status),
      );
      if (!oldest) {
        throw new Error(
          "process_start: record capacity is occupied by active processes",
        );
      }
      this.#records.delete(oldest.snapshot.id);
      this.emit(undefined, oldest.snapshot.id);
    }
  }

  private append(record: RecordState, stream: Stream, text: string): void {
    if (!text || terminal(record.snapshot.status)) {
      return;
    }
    const part: OutputPart = { stream, text, bytes: Buffer.byteLength(text) };
    record.output.push(part);
    let retained = record.snapshot.retainedBytes + part.bytes;
    let dropped = record.snapshot.droppedBytes;
    while (retained > MAX_OUTPUT_BYTES && record.output.length > 0) {
      const first = record.output[0]!;
      const before = first.text;
      const removed = trimPartPrefix(first, retained - MAX_OUTPUT_BYTES);
      const removedText = before.slice(0, before.length - first.text.length);
      const completedLines = [...removedText].filter(
        (character) => character === "\n",
      ).length;
      const removedWholePart = first.bytes === 0;
      const continuesInRetainedOutput = record.output
        .slice(1)
        .some((part) => part.stream === first.stream);
      record.firstRetainedLine +=
        completedLines +
        (removedWholePart &&
        !before.endsWith("\n") &&
        !continuesInRetainedOutput
          ? 1
          : 0);
      retained -= removed;
      dropped += removed;
      if (removedWholePart) {
        record.output.shift();
      }
    }
    record.snapshot = {
      ...record.snapshot,
      retainedBytes: retained,
      droppedBytes: dropped,
    };
    if (this.#records.has(record.snapshot.id)) {
      this.emit(record as ProcessRecord);
    }
  }

  private settle(
    record: ProcessRecord,
    result: Awaited<SandboxExecutionLease["completion"]>,
  ): Promise<void> {
    if (record.released) {
      return Promise.resolve();
    }
    return (record.finalization ??= this.finalize(record, result));
  }

  private cleanupFailed(record: ProcessRecord, failure: unknown): void {
    if (record.released || terminal(record.snapshot.status)) {
      return;
    }
    const execution = sandboxCleanupExecution(failure);
    const error = {
      code: "unavailable",
      message: truncateUtf8(
        sanitiseLine(
          failure instanceof Error
            ? failure.message
            : "Process cleanup unavailable.",
        ),
        512,
      ),
    };
    if (record.cleanupError?.message !== error.message) {
      this.append(
        record,
        "stderr",
        `\nProcess cleanup unavailable: ${error.message}\n`,
      );
    }
    record.cleanupError = error;
    record.snapshot = {
      ...record.snapshot,
      ...(execution
        ? { exitCode: execution.exitCode, signal: execution.signal }
        : {}),
      outputComplete: false,
    };
    this.emit(record);
    for (const waiter of Array.from(record.waiters)) {
      waiter.finish("snapshot");
    }
  }

  private async finalize(
    record: ProcessRecord,
    result: Awaited<SandboxExecutionLease["completion"]>,
  ): Promise<void> {
    record.cleanupError = undefined;
    this.append(record, "stdout", record.stdout.end());
    this.append(record, "stderr", record.stderr.end());
    const status: ProcessStatus =
      result.termination === "natural"
        ? result.exitCode === 0 && result.signal === null
          ? "completed"
          : "failed"
        : "stopped";
    record.snapshot = {
      ...record.snapshot,
      status,
      exitCode: result.exitCode,
      signal: result.signal,
      outputComplete: result.outputComplete,
      endedAt: new Date().toISOString(),
    };
    record.retention = await record.capture.commit(this.captureData(record));
    this.emit(record);
    for (const waiter of Array.from(record.waiters)) {
      waiter.finish("terminal");
    }
  }

  private wait(
    record: ProcessRecord,
    timeoutSeconds: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ProcessWaitOutcome> {
    if (record.waiters.size >= MAX_WAITERS) {
      return Promise.reject(
        new Error("process_wait: maximum of 16 waiters reached"),
      );
    }
    if (terminal(record.snapshot.status)) {
      return Promise.resolve("terminal");
    }
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      let done = false;
      const waiter: Waiter = {
        finish: (outcome) => {
          if (done) {
            return;
          }
          done = true;
          if (timer) {
            clearTimeout(timer);
          }
          signal?.removeEventListener("abort", abort);
          record.waiters.delete(waiter);
          resolve(outcome);
        },
      };
      const abort = () => waiter.finish("cancelled");
      record.waiters.add(waiter);
      signal?.addEventListener("abort", abort, { once: true });
      if (timeoutSeconds !== undefined) {
        timer = setTimeout(
          () => waiter.finish("timed_out"),
          timeoutSeconds * 1000,
        );
      }
      if (terminal(record.snapshot.status)) {
        waiter.finish("terminal");
      }
    });
  }

  private emit(record: ProcessRecord | undefined, evictedId?: string): void {
    const snapshots = this.snapshots();
    for (const listener of Array.from(this.#subscribers)) {
      try {
        listener(snapshots);
      } catch {}
    }
    const id = evictedId ?? record?.snapshot.id;
    if (!id) {
      return;
    }
    for (const listener of Array.from(this.#recordSubscribers.get(id) ?? [])) {
      try {
        listener(record ? copy(record.snapshot) : undefined);
      } catch {}
    }
  }

  private logicalLines(record: ProcessRecord): LogicalLine[] {
    const lines: Array<LogicalLine & { order: number }> = [];
    const open: Partial<Record<Stream, LogicalLine & { order: number }>> = {};
    let order = 0;
    const flush = (stream: Stream) => {
      const line = open[stream];
      if (line) {
        lines.push(line);
        delete open[stream];
      }
    };
    for (const part of record.output) {
      for (const character of part.text) {
        let line = open[part.stream];
        if (!line) {
          line = {
            stream: part.stream,
            text: "",
            number: record.firstRetainedLine + order,
            order,
          };
          order += 1;
          open[part.stream] = line;
        }
        if (character === "\n") {
          flush(part.stream);
        } else {
          line.text += character;
        }
      }
    }
    for (const stream of ["stdout", "stderr"] as const) {
      flush(stream);
    }
    return lines
      .sort((left, right) => left.order - right.order)
      .map(({ stream, text, number }) => ({ stream, text, number }));
  }

  private inspectOutput(record: ProcessRecord): ProcessInspectionOutput {
    let pathological = false;
    const lines = this.logicalLines(record).map(({ stream, text }) => {
      const output = `[${stream}] ${sanitiseLine(text)}`;
      const clipped = truncateUtf8(output, 4_096);
      pathological ||= clipped !== output;
      return clipped;
    });
    const prefix = [
      ...(record.snapshot.droppedBytes > 0
        ? [
            `Older retained output dropped: ${record.snapshot.droppedBytes} bytes.`,
          ]
        : []),
      ...(!record.snapshot.outputComplete
        ? ["Final output may be incomplete."]
        : []),
      ...(pathological ? ["Pathological output line truncated."] : []),
    ];
    return {
      output: [
        ...prefix,
        ...(lines.length === 0 ? ["No retained output observed."] : lines),
      ].join("\n"),
      firstRetainedLine: record.firstRetainedLine,
      prefixLines: prefix.length,
    };
  }

  private project(record: ProcessRecord): ProcessProjection {
    const lines = this.logicalLines(record);
    const notices = [
      ...(record.snapshot.droppedBytes > 0
        ? [
            `Older retained output dropped: ${record.snapshot.droppedBytes} bytes.`,
          ]
        : []),
      ...(!record.snapshot.outputComplete
        ? ["Final output may be incomplete."]
        : []),
    ];
    const requestedLines = DEFAULT_TAIL_LINES;
    const omittedLines = Math.max(0, lines.length - requestedLines);
    let outputLines = [
      ...(lines.length === 0 ? ["No retained output observed."] : []),
      ...(omittedLines > 0
        ? [
            `${omittedLines} older retained source lines omitted by tail selection.`,
          ]
        : []),
      ...lines
        .slice(-requestedLines)
        .map((line) => `[${line.stream}] ${sanitiseLine(line.text)}`),
    ];
    const fixedOutputLines =
      (lines.length === 0 ? 1 : 0) + (omittedLines > 0 ? 1 : 0);
    let selector: ProcessProjection["selector"] = {
      type: "tail",
      requestedLines,
      sourceLines: lines.length,
      outputTruncated: false,
    };
    let pathological = false;
    outputLines = outputLines.map((line) => {
      const clipped = truncateUtf8(line, 4_096);
      pathological ||= clipped !== line;
      return clipped;
    });
    const fixed = [
      ...notices,
      ...(pathological ? ["Pathological output line truncated."] : []),
      ...outputLines.slice(0, fixedOutputLines),
    ];
    const variable = outputLines.slice(fixedOutputLines);
    const bytesOf = (value: readonly string[]) =>
      Buffer.byteLength(value.join("\n"));
    const truncationNotice = (omitted: number) =>
      `Output projection truncated; ${omitted} rendered lines omitted.`;
    let selected: string[];
    let truncated = false;
    const suffix: string[] = [];
    for (let index = variable.length - 1; index >= 0; index -= 1) {
      const next = [variable[index]!, ...suffix];
      const omitted = variable.length - next.length;
      const result = [
        ...fixed,
        ...(omitted > 0 ? [truncationNotice(omitted)] : []),
        ...next,
      ];
      if (
        result.length <= MAX_PROJECTION_LINES &&
        bytesOf(result) <= MAX_PROJECTION_BYTES
      ) {
        suffix.unshift(variable[index]!);
        continue;
      }
      break;
    }
    truncated = suffix.length < variable.length;
    selected = [
      ...fixed,
      ...(truncated ? [truncationNotice(variable.length - suffix.length)] : []),
      ...suffix,
    ];
    selector = { ...selector, outputTruncated: truncated || pathological };
    return { output: selected.join("\n"), selector };
  }
}
