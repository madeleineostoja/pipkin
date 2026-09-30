import { StringDecoder } from "node:string_decoder";
import { Type } from "typebox";
import {
  createBashToolDefinition,
  truncateTail,
  type ExtensionAPI,
  type AgentToolUpdateCallback,
} from "@earendil-works/pi-coding-agent";
import {
  reserveOutput,
  metadataPreview,
  boundedPreview,
  BashResultSchema,
  Presentation,
  type Execution,
} from "#context/retained-output";
import {
  toolCallRenderer,
  toolResultRenderer,
} from "#lib/ui/tool-result-renderer";
import type { SandboxBashRuntime } from "./bash.ts";

function executionSummary(value: unknown): string {
  const details = value as
    | { execution?: Execution; retention?: string }
    | undefined;
  if (!details?.execution) {
    return "Bash execution unavailable.";
  }
  const execution = details.execution;
  return `${execution.state} · ${execution.exitCode === null ? (execution.signal ?? "exit unknown") : `exit ${execution.exitCode}`} · retention ${details.retention ?? "unknown"}`;
}

export function createRetainedBashDefinition(
  host: ExtensionAPI["events"],
  cwd: string,
  runtime: SandboxBashRuntime,
) {
  return {
    name: "bash",
    label: "bash",
    exposure: "direct" as const,
    namespace: {
      name: "execution",
      description:
        "Run commands, manage session processes, and retrieve immutable authorized output.",
    },
    description:
      "Execute a shell command and wait for its result, with an optional timeout in seconds. Use process_start for managed execution that returns immediately. Output is returned by default; status suppresses only successful logs. Bounded immutable output is retained independently of enclosing scripts; output_list/read_output recover it without rerunning commands.",
    parameters: Type.Object(
      {
        command: Type.String({
          description:
            "Shell command executed in the current working directory.",
        }),
        timeout: Type.Optional(
          Type.Number({
            description:
              "Optional positive finite command timeout in seconds, maximum 2147483.647.",
          }),
        ),
        presentation: Type.Optional(Presentation),
      },
      { additionalProperties: false },
    ),
    outputSchema: BashResultSchema,
    renderCall: toolCallRenderer({
      name: "bash",
      detail: (args: { command?: string }) =>
        typeof args.command === "string"
          ? boundedPreview(metadataPreview(args.command).text, 120).text
          : "",
      pending: "Executing command…",
    }),
    renderResult: toolResultRenderer({
      summary: (result) => executionSummary(result.details),
      error: (result) => executionSummary(result.details),
      partial: () => "Executing command…",
    }),
    async execute(
      toolCallId: string,
      params: {
        command: string;
        timeout?: number;
        presentation?: "output" | "status";
      },
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      ctx: Parameters<
        ReturnType<typeof createBashToolDefinition>["execute"]
      >[4],
    ) {
      if (
        !params.command.trim() ||
        (params.timeout !== undefined &&
          (!Number.isFinite(params.timeout) ||
            params.timeout <= 0 ||
            params.timeout * 1000 > 2147483647)) ||
        (params.presentation !== undefined &&
          params.presentation !== "output" &&
          params.presentation !== "status")
      ) {
        throw new Error("Invalid Bash arguments");
      }
      if (!ctx) {
        throw new Error("Bash requires an active Context scope");
      }
      const capture = reserveOutput(host, ctx, {
        sourceTool: "bash",
        callId: toolCallId,
        command: params.command,
        cwd: ctx.cwd,
      });
      const startedAt = new Date().toISOString();
      let text = "";
      let droppedBytes = 0;
      const decoder = new StringDecoder("utf8");
      let exitCode: number | null = null;
      let terminationSignal: string | null = null;
      let outputComplete = false;
      let failure: string | undefined;
      let executionObserved = false;
      let state: Execution["state"] = "completed";
      const append = (chunk: string) => {
        text += chunk;
        const bytes = Buffer.byteLength(text);
        if (bytes > 1024 * 1024) {
          const buffer = Buffer.from(text);
          let start = buffer.length - 1024 * 1024;
          while ((buffer[start]! & 0xc0) === 0x80) {
            start++;
          }
          droppedBytes += start;
          text = buffer.subarray(start).toString("utf8");
        }
      };
      const native = createBashToolDefinition(cwd, {
        operations: {
          async exec(command, directory, options) {
            executionObserved = true;
            try {
              const result = await runtime.operations.exec(command, directory, {
                ...options,
                onData: (data) => {
                  append(decoder.write(data));
                  options.onData(data);
                },
              });
              exitCode = result.exitCode;
              terminationSignal = result.signal;
              outputComplete = result.outputComplete;
              if (exitCode !== 0 || result.signal !== null) {
                state = "failed";
                failure = `Command exited with code ${exitCode ?? "unknown"}`;
              }
              return result;
            } catch (error) {
              const known = error as {
                exitCode?: number | null;
                signal?: string | null;
                outputComplete?: boolean;
              };
              exitCode = known?.exitCode ?? null;
              terminationSignal = known?.signal ?? null;
              outputComplete = known?.outputComplete ?? false;
              const message =
                error instanceof Error ? error.message : "Execution failed";
              state = message.startsWith("timeout:")
                ? "timed_out"
                : message.startsWith("aborted")
                  ? "cancelled"
                  : "failed";
              failure =
                state === "timed_out"
                  ? "Command timed out."
                  : state === "cancelled"
                    ? "Command cancelled."
                    : message;
              throw error;
            }
          },
        },
      });
      try {
        await native.execute(
          toolCallId,
          params,
          signal,
          params.presentation === "status" ? undefined : onUpdate,
          ctx,
        );
      } catch (error) {
        if (!executionObserved) {
          capture.release();
          throw error;
        }
        failure ??=
          error instanceof Error
            ? error.message
            : "Execution presentation unavailable.";
      }
      append(decoder.end());
      const projection = truncateTail(text);
      const execution: Execution = {
        state,
        exitCode,
        signal: terminationSignal,
        startedAt,
        endedAt: new Date().toISOString(),
      };
      const truncated = projection.truncated || droppedBytes > 0;
      const retention = await capture.commit({
        execution,
        text: projection.content,
        truncated,
        outputComplete,
        droppedBytes:
          droppedBytes +
          Buffer.byteLength(text) -
          Buffer.byteLength(projection.content),
      });
      const error =
        retention.retention === "failed"
          ? retention.error
          : failure
            ? {
                code:
                  state === "completed"
                    ? "unavailable"
                    : state === "failed"
                      ? "execution_failed"
                      : state,
                message: failure,
              }
            : undefined;
      const output =
        params.presentation === "status" &&
        state === "completed" &&
        !failure &&
        retention.retention === "retained"
          ? ""
          : projection.content;
      const payload = {
        ok: !error,
        ...(error ? { error } : {}),
        execution,
        output,
        truncated,
        ...retention,
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
        details: { execution, retention: retention.retention, truncated },
        isError: !payload.ok,
      };
    },
  };
}
