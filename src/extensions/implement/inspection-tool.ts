import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import {
  toolCallRenderer,
  toolResultRenderer,
} from "#lib/ui/tool-result-renderer";
import { enumerateCheckoutRuns, loadCheckoutRun } from "./controls.js";
import { ExecGitClient } from "./git.js";
import { UnsupportedActiveRunVersionError } from "./store.js";
import { projectRunSurface, runSummary } from "./run-surface.js";
import {
  InspectResultSchema,
  ListRunsResultSchema,
} from "./inspection-schema.js";

export const ListRunsParams = Type.Object(
  {
    offset: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
        description:
          "Zero-based offset in authorized known runs; defaults to 0.",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 25,
        description:
          "Maximum authorized run summaries to return, 1..25; defaults to 25.",
      }),
    ),
  },
  { additionalProperties: false },
);
export const InspectParams = Type.Object(
  {
    runId: Type.String({
      minLength: 1,
      maxLength: 64,
      pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$",
      description:
        "Known retained run ID in the current checkout, discovered through implement_list_runs.",
    }),
  },
  { additionalProperties: false },
);

export function listImplementRuns(
  checkoutRoot: string,
  input: Static<typeof ListRunsParams>,
): Static<typeof ListRunsResultSchema> {
  if (!Check(ListRunsParams, input)) {
    return {
      ok: false,
      error: { code: "invalid_arguments", message: "Invalid run pagination." },
    };
  }
  const { offset = 0, limit = 25 } = input;
  const enumeration = enumerateCheckoutRuns(checkoutRoot);
  const unsupported = enumeration.runs.find(
    (entry) => entry.kind === "unsupported_active",
  );
  if (unsupported?.kind === "unsupported_active") {
    return {
      ok: false,
      error: { code: "unavailable", message: unsupported.diagnostic },
    };
  }
  // Authorization precedes pagination; historical/unowned IDs are never public.
  const runs = enumeration.runs.flatMap((entry) =>
    entry.kind === "run" ? [runSummary(entry.state)] : [],
  );
  runs.sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) || a.runId.localeCompare(b.runId),
  );
  return {
    ok: true,
    runs: runs.slice(offset, offset + limit),
    truncated: enumeration.truncated,
    ...(offset + limit < runs.length ? { nextOffset: offset + limit } : {}),
  };
}

export function inspectImplementRun(
  checkoutRoot: string,
  input: Static<typeof InspectParams>,
): Static<typeof InspectResultSchema> {
  if (!Check(InspectParams, input)) {
    return {
      ok: false,
      error: {
        code: "invalid_arguments",
        message: "A valid known run ID is required.",
      },
    };
  }
  try {
    const state = loadCheckoutRun(checkoutRoot, input.runId);
    return { ok: true, run: projectRunSurface(checkoutRoot, state) };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof UnsupportedActiveRunVersionError
          ? { code: "unavailable", message: error.message }
          : {
              code: "not_found",
              message: "Run is unavailable in the current checkout.",
            },
    };
  }
}

export function registerImplementInspectionTool(pi: ExtensionAPI): void {
  const namespace = {
    name: "implement",
    description:
      "Read-only discovery of checkout-owned runs and durable evidence artifacts; no run or publication controls.",
  };
  const annotations = { readOnlyHint: true, openWorldHint: false };
  const renderer = toolResultRenderer({
    summary(result) {
      const details = result.details as { summary?: string };
      return details?.summary ?? "Implement inspection.";
    },
    partial: () => "Inspecting Implement state…",
    error: () => "Implement inspection unavailable.",
  });
  pi.registerTool({
    name: "implement_list_runs",
    label: "implement_list_runs",
    exposure: "deferred",
    namespace,
    annotations,
    description:
      "List authorized retained Implement runs in the current checkout, newest first. Enumeration is bounded to 1000 owner entries; truncated discloses an incomplete enumeration.",
    parameters: ListRunsParams,
    outputSchema: ListRunsResultSchema,
    async execute(_id, input, _signal, _update, ctx) {
      try {
        return result(
          ListRunsResultSchema,
          listImplementRuns(await new ExecGitClient(ctx.cwd).root(), input),
        );
      } catch {
        return result(ListRunsResultSchema, {
          ok: false,
          error: {
            code: "unavailable",
            message: "Checkout run discovery is unavailable.",
          },
        });
      }
    },
    renderCall: toolCallRenderer({
      name: "implement_list_runs",
      detail: () => "retained runs",
      pending: "Listing Implement runs…",
    }),
    renderResult: renderer,
  });
  pi.registerTool({
    name: "implement_inspect",
    label: "implement_inspect",
    exposure: "deferred",
    namespace,
    annotations,
    description:
      "Inspect one known current-checkout Implement run. Returns bounded state, reported/legacy verification and durable run-owned artifact descriptors. Discover artifacts here before reading retained files; this operation never controls a run or mutates artifacts.",
    parameters: InspectParams,
    outputSchema: InspectResultSchema,
    async execute(_id, input, _signal, _update, ctx) {
      try {
        return result(
          InspectResultSchema,
          inspectImplementRun(await new ExecGitClient(ctx.cwd).root(), input),
        );
      } catch {
        return result(InspectResultSchema, {
          ok: false,
          error: {
            code: "unavailable",
            message: "Checkout inspection is unavailable.",
          },
        });
      }
    },
    renderCall: toolCallRenderer({
      name: "implement_inspect",
      detail: (input: Static<typeof InspectParams>) => input.runId,
      pending: "Inspecting Implement run…",
    }),
    renderResult: renderer,
  });
}

function result(
  schema: typeof InspectResultSchema | typeof ListRunsResultSchema,
  payload:
    | Static<typeof InspectResultSchema>
    | Static<typeof ListRunsResultSchema>,
) {
  if (!Check(schema, payload)) {
    throw new Error("Invalid Implement inspection result.");
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: !payload.ok,
    details: {
      summary: payload.ok
        ? "run" in payload
          ? `Implement run ${payload.run.runId} · ${payload.run.phase}.`
          : `Implement · ${payload.runs.length} retained runs${payload.truncated ? " · enumeration truncated" : ""}.`
        : "Implement inspection unavailable.",
    },
  };
}
