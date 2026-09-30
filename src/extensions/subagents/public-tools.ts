import type {
  ExtensionAPI,
  AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import type { ModelPreset } from "#lib/config";
import {
  PageParams,
  metadataPreview,
  validatePage,
} from "#context/retained-output";
import {
  toolCallRenderer,
  toolResultRenderer,
} from "#lib/ui/tool-result-renderer";
import { PUBLIC_BUILTIN_TYPES } from "./agent-profiles.js";
import {
  boundedAgentText,
  boundedAgentProgress,
  type SubagentRuntime,
  type RuntimeSnapshot,
  type PublicSubagentResult,
} from "./runtime.js";
import {
  renderAgentCall,
  renderAgentResult,
  presentationDetails,
} from "./tool-rendering.js";

export const PublicAgentParameters = Type.Object(
  {
    type: StringEnum(PUBLIC_BUILTIN_TYPES, {
      description:
        "Explore: bounded multi-step codebase discovery in separate context, not one targeted lookup or a couple of reads. Review: an independent assessment of a concrete code artifact, not routine small-edit overhead or open-ended discovery.",
    }),
    prompt: Type.String({
      minLength: 1,
      description:
        "Self-contained task contract: question or objective, scope, relevant context and artifact paths, and expected output. The child does not inherit the parent conversation.",
    }),
    description: Type.Optional(
      Type.String({
        description:
          "Short safe human-readable task label; never include secrets.",
      }),
    ),
    model: Type.Optional(
      Type.String({
        description:
          "Optional known exact provider/model ID; omit to use the configured Explore low or Review high preset. Do not guess available models.",
      }),
    ),
    thinking: Type.Optional(
      StringEnum(
        ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const,
        {
          description:
            "Reasoning effort override for this invocation; omit to use the configured role preset.",
        },
      ),
    ),
  },
  { additionalProperties: false },
);
export type PublicAgentParams = Static<typeof PublicAgentParameters>;

const id = Type.String({
  minLength: 1,
  description: "Public session-owned agent ID from agent_start or agent_list.",
});
const progress = Type.Optional(
  Type.Boolean({
    description:
      "Include bounded untrusted partial progress, not a final answer; default false.",
  }),
);
const Inspect = Type.Object(
  { id, includeProgress: progress },
  { additionalProperties: false },
);
const Wait = Type.Object(
  {
    id,
    includeProgress: progress,
    timeoutSeconds: Type.Optional(
      Type.Number({
        exclusiveMinimum: 0,
        maximum: 2147483.647,
        description:
          "Positive finite waiter deadline in seconds; omitted joins cleanup until terminal or cancellation. Never stops the child.",
      }),
    ),
  },
  { additionalProperties: false },
);
const Stop = Type.Object({ id }, { additionalProperties: false });
const Steer = Type.Object(
  {
    id,
    message: Type.String({
      minLength: 1,
      description:
        "Nonempty guidance to queue after the child's current turn, unless Pi handles it.",
    }),
  },
  { additionalProperties: false },
);
const AgentSchema = Type.Object(
  {
    id: Type.String(),
    type: StringEnum(PUBLIC_BUILTIN_TYPES),
    description: Type.String(),
    state: StringEnum([
      "queued",
      "running",
      "stopping",
      "completed",
      "failed",
      "stopped",
    ]),
    startedAt: Type.Optional(Type.String()),
    endedAt: Type.Optional(Type.String()),
    cleanup: StringEnum(["pending", "complete"]),
  },
  { additionalProperties: false },
);
const AgentErrorSchema = Type.Object(
  {
    code: StringEnum([
      "not_found",
      "invalid_arguments",
      "unavailable",
      "cancelled",
      "agent_failed",
      "stopped",
    ] as const),
    message: Type.String(),
  },
  { additionalProperties: false },
);
const ResultFields = {
  result: Type.Optional(
    Type.Object(
      { text: Type.String(), truncated: Type.Boolean() },
      { additionalProperties: false },
    ),
  ),
  progress: Type.Optional(
    Type.Object(
      {
        text: Type.String(),
        truncated: Type.Boolean(),
        partial: Type.Literal(true),
      },
      { additionalProperties: false },
    ),
  ),
  waitOutcome: Type.Optional(
    StringEnum(["terminal", "timed_out", "cancelled"]),
  ),
  delivery: Type.Optional(StringEnum(["queued", "handled"] as const)),
};
const ResultSchema = Type.Union([
  Type.Object(
    { ok: Type.Literal(true), agent: AgentSchema, ...ResultFields },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ok: Type.Literal(false),
      error: AgentErrorSchema,
      agent: Type.Optional(AgentSchema),
      ...ResultFields,
    },
    { additionalProperties: false },
  ),
]);
const ListSchema = Type.Union([
  Type.Object(
    {
      ok: Type.Literal(true),
      agents: Type.Array(AgentSchema),
      nextOffset: Type.Optional(Type.Integer()),
      truncated: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { ok: Type.Literal(false), error: AgentErrorSchema },
    { additionalProperties: false },
  ),
]);
type Agent = Static<typeof AgentSchema>;
type Result = Static<typeof ResultSchema>;
function safeAgent(snapshot: RuntimeSnapshot): Agent {
  return {
    id: snapshot.id,
    type: snapshot.type as Agent["type"],
    description: metadataPreview(snapshot.description).text,
    state:
      snapshot.status === "stopped" && !snapshot.cleanupComplete
        ? "stopping"
        : snapshot.status,
    ...(snapshot.timestamps.startedAt
      ? { startedAt: snapshot.timestamps.startedAt }
      : {}),
    ...(snapshot.cleanupComplete && snapshot.timestamps.completedAt
      ? { endedAt: snapshot.timestamps.completedAt }
      : {}),
    cleanup: snapshot.cleanupComplete ? "complete" : "pending",
  };
}
function response(value: PublicSubagentResult): Result {
  const { snapshot, waitOutcome } = value;
  const cancelled = waitOutcome === "cancelled";
  const failed =
    (snapshot.status === "failed" || snapshot.status === "stopped") &&
    waitOutcome !== "timed_out";
  const data = {
    agent: safeAgent(snapshot),
    ...(waitOutcome !== "snapshot" ? { waitOutcome } : {}),
    ...(snapshot.status === "completed" && snapshot.cleanupComplete
      ? {
          result: boundedAgentText(
            typeof snapshot.result === "string" ? snapshot.result : "",
          ),
        }
      : {}),
    ...(value.progress !== undefined
      ? {
          progress: boundedAgentProgress(value.progress),
        }
      : {}),
  };
  if (cancelled) {
    return {
      ...data,
      ok: false,
      error: {
        code: "cancelled",
        message: "Wait cancelled; child cleanup/state is shown in agent.",
      },
    };
  }
  if (failed) {
    return {
      ...data,
      ok: false,
      error: {
        code: snapshot.status === "stopped" ? "stopped" : "agent_failed",
        message: "Agent did not complete successfully.",
      },
    };
  }
  return { ...data, ok: true };
}
function result(
  data: Result,
  snapshot?: RuntimeSnapshot,
  presentation: "start" | "status" | "steer" = "status",
): AgentToolResult<unknown> {
  return {
    details: snapshot
      ? {
          ...presentationDetails(snapshot, presentation, data.progress?.text),
          ...(data.delivery ? { delivery: data.delivery } : {}),
        }
      : undefined,
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
    isError: !data.ok,
  };
}
function failure(error: unknown): Extract<Result, { ok: false }> {
  const message =
    error instanceof Error ? error.message : "Agent operation unavailable.";
  return {
    ok: false,
    error: {
      code: message.startsWith("Unknown subagent")
        ? "not_found"
        : message.includes("Invalid") || message.includes("empty")
          ? "invalid_arguments"
          : "unavailable",
      message: message.startsWith("Unknown subagent")
        ? "Public agent not found."
        : "Agent operation unavailable; check arguments, model selection and current state.",
    },
  };
}
export function resolveAgentSelection(
  type: PublicAgentParams["type"],
  model: string | undefined,
  thinking: PublicAgentParams["thinking"] | undefined,
  configPath: string,
  presets: Readonly<Partial<Record<"low" | "high", ModelPreset>>>,
): { model?: string; thinking?: PublicAgentParams["thinking"] } {
  if (model !== undefined && thinking !== undefined) {
    return { model, thinking };
  }
  const preset = presets[type === "Explore" ? "low" : "high"];
  if (!preset) {
    throw new Error(
      `Pipkin config ${configPath} is missing a valid ${type === "Explore" ? "low" : "high"} model preset.`,
    );
  }
  return {
    model: model ?? preset.model,
    thinking: thinking ?? preset.thinking,
  };
}
export function registerPublicAgentTools({
  pi,
  runtime,
  configPath,
  modelPresets,
}: {
  pi: ExtensionAPI;
  runtime: SubagentRuntime;
  configPath: string;
  modelPresets: Readonly<Partial<Record<"low" | "high", ModelPreset>>>;
}): void {
  const namespace = {
    name: "agents",
    description:
      "Start and recover session-owned Explore and Review jobs; no private Implement worker access.",
  };
  pi.registerTool({
    name: "agent_start",
    label: "agent_start",
    exposure: "direct",
    namespace,
    description:
      "Delegate repository-preserving codebase discovery or independent artifact review to a fresh-context child, not an implementation worker. The child shares the invoking filesystem, not an isolated worktree, and does not inherit the parent conversation. Returns an ID immediately, not a completed result; retrieve the final answer with agent_wait. Recover accepted work with agent_list even if the initiating script fails.",
    parameters: PublicAgentParameters,
    outputSchema: ResultSchema,
    renderCall: renderAgentCall,
    renderResult: renderAgentResult,
    async execute(_call, params, signal, _update, ctx) {
      if (signal?.aborted) {
        return result({
          ok: false,
          error: {
            code: "cancelled",
            message: "Agent start cancelled before acceptance.",
          },
        });
      }
      try {
        const snapshot = await runtime.runPublicAgent({
          ...params,
          description: params.description ?? `${params.type} task`,
          cwd: ctx.cwd,
          ctx,
          mode: "background",
          ...resolveAgentSelection(
            params.type,
            params.model,
            params.thinking,
            configPath,
            modelPresets,
          ),
        });
        return result(
          { ok: true, agent: safeAgent(snapshot) },
          snapshot,
          "start",
        );
      } catch (error) {
        return result(failure(error));
      }
    },
  });
  pi.registerTool({
    name: "agent_list",
    label: "agent_list",
    exposure: "deferred",
    namespace,
    description:
      "Recover public agents owned by this session, newest first. Never returns prompts, raw output or private workers.",
    parameters: PageParams,
    outputSchema: ListSchema,
    renderCall: toolCallRenderer({
      name: "agent_list",
      pending: "Listing agents…",
    }),
    renderResult: toolResultRenderer({ summary: () => "Public agent roster." }),
    async execute(_call, params) {
      try {
        const offset = params.offset ?? 0,
          limit = params.limit ?? 25;
        validatePage(offset, limit);
        const snapshots = runtime.publicSnapshots();
        const data = {
          ok: true,
          agents: snapshots.slice(offset, offset + limit).map(safeAgent),
          truncated: false,
          ...(offset + limit < snapshots.length
            ? { nextOffset: offset + limit }
            : {}),
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data) }],
          details: undefined,
          structuredContent: data,
        };
      } catch (error) {
        return result(failure(error));
      }
    },
  });
  const register = <T extends typeof Inspect | typeof Wait | typeof Stop>(
    name: string,
    parameters: T,
    description: string,
    operation: "inspect" | "wait" | "stop",
  ) =>
    pi.registerTool({
      name,
      label: name,
      exposure: "deferred",
      namespace,
      description,
      parameters,
      outputSchema: ResultSchema,
      renderCall: toolCallRenderer({ name, pending: "Reading agent state…" }),
      renderResult: renderAgentResult,
      async execute(_call, params, signal) {
        try {
          const options = params as Static<typeof Wait>;
          const value =
            operation === "stop"
              ? await runtime.publicStop(options.id, signal)
              : await runtime.publicResult(
                  options.id,
                  operation === "wait",
                  options.includeProgress ?? false,
                  signal,
                  options.timeoutSeconds,
                );
          return result(response(value), value.snapshot);
        } catch (error) {
          return result(failure(error));
        }
      },
    });
  register(
    "agent_inspect",
    Inspect,
    "Immediately inspect a public agent without waiting. A completed answer is returned only after cleanup; optional progress is partial and untrusted, not a final result.",
    "inspect",
  );
  register(
    "agent_wait",
    Wait,
    "Wait for a public agent's final result and cleanup. Timeout/cancellation affects only this waiter, never the child.",
    "wait",
  );
  register(
    "agent_stop",
    Stop,
    "Cancel an owned public agent and join cleanup. Caller cancellation returns honest still-stopping state; join later with agent_wait.",
    "stop",
  );
  pi.registerTool({
    name: "agent_steer",
    label: "agent_steer",
    exposure: "deferred",
    namespace,
    description:
      "Send guidance to a running public agent. Reports Pi's actual queued or handled delivery, not immediate execution.",
    parameters: Steer,
    outputSchema: ResultSchema,
    renderCall: toolCallRenderer({
      name: "agent_steer",
      pending: "Queueing guidance…",
    }),
    renderResult: renderAgentResult,
    async execute(_call, params) {
      try {
        const value = await runtime.publicSteer(params.id, params.message);
        return result(
          {
            ok: true,
            agent: safeAgent(value.snapshot),
            delivery: value.delivery,
          },
          value.snapshot,
          "steer",
        );
      } catch (error) {
        return result(failure(error));
      }
    },
  });
}
