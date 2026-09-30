import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  Presentation,
  ErrorSchema,
  PageParams,
  PageFields,
  RetentionFields,
  boundedPreview,
  metadataPreview,
  type Retention,
} from "#context/retained-output";
import {
  toolCallRenderer,
  toolResultRenderer,
} from "#lib/ui/tool-result-renderer";
import {
  ProcessRuntime,
  type ProcessSnapshot,
  type ProcessWaitOutcome,
} from "./runtime.js";
const namespace = {
  name: "execution",
  description:
    "Run commands, manage session processes, and retrieve immutable authorized output.",
};
const StartParams = Type.Object(
  {
    command: Type.String({
      description: "Foreground non-interactive shell command to manage.",
    }),
    description: Type.String({
      description:
        "Safe single-line description normalized to 1..120 Unicode code points.",
    }),
  },
  { additionalProperties: false },
);
const OperationParams = {
  id: Type.String({
    description: "Session-owned process ID from process_start or process_list.",
  }),
  presentation: Type.Optional(Presentation),
};
const InspectParams = Type.Object(OperationParams, {
  additionalProperties: false,
});
const WaitParams = Type.Object(
  {
    ...OperationParams,
    timeoutSeconds: Type.Optional(
      Type.Number({
        description:
          "Optional positive finite wait deadline in seconds, maximum 2147483.647. Omitted waits until settlement or caller cancellation; never kills the process.",
      }),
    ),
  },
  { additionalProperties: false },
);
const ProcessSchema = Type.Object(
  {
    id: Type.String(),
    description: Type.String(),
    state: Type.Union(
      ["running", "completed", "failed", "stopped"].map((state) =>
        Type.Literal(state),
      ),
    ),
    startedAt: Type.String(),
    endedAt: Type.Optional(Type.String()),
    command: Type.Optional(Type.String()),
    cwd: Type.Optional(Type.String()),
    commandTruncated: Type.Optional(Type.Boolean()),
    cwdTruncated: Type.Optional(Type.Boolean()),
    exitCode: Type.Union([Type.Integer(), Type.Null()]),
    signal: Type.Union([Type.String(), Type.Null()]),
    outputComplete: Type.Boolean(),
    droppedBytes: Type.Integer(),
  },
  { additionalProperties: false },
);
const ResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    error: Type.Optional(ErrorSchema),
    process: Type.Optional(ProcessSchema),
    waitOutcome: Type.Optional(
      Type.Union(
        ["snapshot", "terminal", "timed_out", "cancelled"].map((outcome) =>
          Type.Literal(outcome),
        ),
      ),
    ),
    output: Type.Optional(Type.String()),
    truncated: Type.Optional(Type.Boolean()),
    retention: Type.Optional(RetentionFields.retention),
    outputRef: RetentionFields.outputRef,
  },
  { additionalProperties: false },
);
const ListSchema = Type.Object(
  {
    ok: Type.Boolean(),
    error: Type.Optional(ErrorSchema),
    processes: Type.Array(
      Type.Object(
        {
          id: Type.String(),
          description: Type.String(),
          state: Type.String(),
          startedAt: Type.String(),
          endedAt: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
    ...PageFields,
  },
  { additionalProperties: false },
);
function project(snapshot: ProcessSnapshot) {
  const command = metadataPreview(snapshot.command),
    cwd = metadataPreview(snapshot.cwd);
  return {
    id: snapshot.id,
    description: snapshot.description,
    state: snapshot.status,
    startedAt: snapshot.startedAt,
    ...(snapshot.endedAt ? { endedAt: snapshot.endedAt } : {}),
    command: command.text,
    cwd: cwd.text,
    commandTruncated: command.truncated,
    cwdTruncated: cwd.truncated,
    exitCode: snapshot.exitCode,
    signal: snapshot.signal,
    outputComplete: snapshot.outputComplete,
    droppedBytes: snapshot.droppedBytes,
  };
}
export const renderProcessResult = toolResultRenderer({
  summary: (result) => {
    const details = result.details as
      | { process?: { id: string; state: string }; count?: number }
      | undefined;
    return details?.process
      ? `${details.process.id} · ${details.process.state}`
      : `${details?.count ?? 0} session processes`;
  },
  error: () => "Process operation failed; inspect diagnostics.",
});
function failure(error: unknown) {
  const message =
    error instanceof Error ? error.message : "Process operation unavailable.";
  const payload = {
    ok: false,
    error: {
      code: /not found|unknown or evicted/.test(message)
        ? "not_found"
        : /unavailable|not active|shutting down|inactive/.test(message)
          ? "unavailable"
          : "invalid_arguments",
      message: /not found|unknown or evicted/.test(message)
        ? "Process not found."
        : boundedPreview(metadataPreview(message).text, 512).text,
    },
  };
  return {
    content: [{ type: "text" as const, text: payload.error.message }],
    structuredContent: payload,
    details: undefined,
    isError: true,
  };
}
function snapshotResult(
  result: {
    snapshot: ProcessSnapshot;
    output: string;
    selector: {
      outputTruncated: boolean;
      sourceLines: number;
      requestedLines?: number;
    };
    retention: Retention;
    waitOutcome?: ProcessWaitOutcome;
    error?: { code: string; message: string };
  },
  presentation?: "output" | "status",
) {
  const process = project(result.snapshot);
  const state = process.state;
  const error =
    result.retention.retention === "failed"
      ? result.retention.error
      : result.error
        ? result.error
        : result.waitOutcome === "cancelled"
          ? {
              code: "cancelled",
              message: "Wait cancelled; process was not stopped.",
            }
          : state === "failed"
            ? {
                code: "execution_failed",
                message: `Process failed (exit ${process.exitCode ?? "unknown"}).`,
              }
            : state === "stopped"
              ? {
                  code: "stopped",
                  message:
                    "Process intentionally stopped; not a successful verification.",
                }
              : undefined;
  const output = presentation === "status" && !error ? "" : result.output;
  const payload = {
    ok: !error,
    ...(error ? { error } : {}),
    process,
    waitOutcome:
      result.waitOutcome ?? (state === "running" ? "snapshot" : "terminal"),
    output,
    truncated:
      result.selector.outputTruncated ||
      process.droppedBytes > 0 ||
      result.selector.sourceLines >
        (result.selector.requestedLines ?? result.selector.sourceLines),
    ...result.retention,
  };
  return {
    content: [
      {
        type: "text" as const,
        text: [JSON.stringify({ ...payload, output: undefined }), output]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
    structuredContent: payload,
    details: {
      process: { id: process.id, state },
      waitOutcome: payload.waitOutcome,
    },
    isError: !payload.ok,
  };
}
export function registerProcessTools(
  pi: ExtensionAPI,
  runtime: () => ProcessRuntime,
): void {
  pi.registerTool({
    name: "process_start",
    label: "process_start",
    exposure: "deferred",
    namespace,
    description:
      "Accept a session-owned foreground non-interactive command. Acceptance is not completion; recover lost handles with process_list. Terminal evidence is captured even without waiting.",
    parameters: StartParams,
    outputSchema: ResultSchema,
    renderCall: toolCallRenderer({
      name: "process_start",
      pending: "Starting process…",
    }),
    renderResult: renderProcessResult,
    async execute(toolCallId, params, signal, _update, ctx) {
      try {
        const snapshot = await runtime().start({
          ...params,
          cwd: ctx.cwd,
          ctx,
          signal,
          toolCallId,
        });
        const process = project(snapshot);
        const payload = { ok: true, process };
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          structuredContent: payload,
          details: { process: { id: process.id, state: process.state } },
        };
      } catch (error) {
        return failure(error);
      }
    },
  });
  pi.registerTool({
    name: "process_list",
    label: "process_list",
    exposure: "deferred",
    namespace,
    annotations: { readOnlyHint: true, openWorldHint: false },
    description:
      "List this session's authorized process metadata, newest first. No commands or output; OS processes are not resumed after restart.",
    parameters: PageParams,
    outputSchema: ListSchema,
    renderCall: toolCallRenderer({
      name: "process_list",
      pending: "Listing processes…",
    }),
    renderResult: renderProcessResult,
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const offset = params.offset ?? 0,
          limit = params.limit ?? 25;
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 25
        ) {
          throw new Error("Invalid pagination");
        }
        const snapshots = [...runtime().authorizedSnapshots(ctx)].sort(
          (a, b) =>
            b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id),
        );
        const payload = {
          ok: true,
          processes: snapshots
            .slice(offset, offset + limit)
            .map((snapshot) => ({
              id: snapshot.id,
              description: snapshot.description,
              state: snapshot.status,
              startedAt: snapshot.startedAt,
              ...(snapshot.endedAt ? { endedAt: snapshot.endedAt } : {}),
            })),
          count: snapshots.length,
          ...(offset + limit < snapshots.length
            ? { nextOffset: offset + limit }
            : {}),
          truncated: false,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          structuredContent: payload,
          details: { count: payload.processes.length },
        };
      } catch (error) {
        const result = failure(error);
        return {
          ...result,
          structuredContent: {
            ...result.structuredContent,
            processes: [],
            count: 0,
            truncated: false,
          },
        };
      }
    },
  });
  for (const operation of ["inspect", "wait", "stop"] as const) {
    const name = `process_${operation}`;
    pi.registerTool({
      name,
      label: name,
      exposure: "deferred",
      namespace,
      description:
        operation === "inspect"
          ? "Immediately snapshot process state and bounded output; read_output reads the immutable full retained tail."
          : operation === "wait"
            ? "Wait for terminal settlement, a deadline, or caller cancellation. Timeout/cancellation does not kill the process."
            : "Stop using graceful escalation and report terminal cleanup only once achieved. Intentional stop is not successful verification.",
      parameters: operation === "wait" ? WaitParams : InspectParams,
      outputSchema: ResultSchema,
      renderCall: toolCallRenderer({ name, pending: "Inspecting process…" }),
      renderResult: renderProcessResult,
      async execute(_id, params, signal, _update, ctx) {
        try {
          runtime().assertOwned(params.id, ctx);
          const result =
            operation === "stop"
              ? await runtime().stop(params.id)
              : await runtime().result(
                  params.id,
                  operation === "wait",
                  "timeoutSeconds" in params &&
                    typeof params.timeoutSeconds === "number"
                    ? params.timeoutSeconds
                    : undefined,
                  signal,
                );
          return snapshotResult(result, params.presentation);
        } catch (error) {
          return failure(error);
        }
      },
    });
  }
}
