import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { BrowserError } from "./errors.js";
import { LIMITS } from "./limits.js";
import { isSnapshotRef } from "./target.js";

const targetKinds = [
  "ref",
  "role",
  "text",
  "label",
  "placeholder",
  "test_id",
  "css",
] as const;
const target = Type.Object(
  {
    kind: StringEnum(targetKinds, {
      description:
        "Strict resolution kind: snapshot ref, semantic locator, or explicit CSS fallback.",
    }),
    value: Type.String({
      minLength: 1,
      maxLength: LIMITS.targetChars,
      description:
        "Non-empty snapshot ref from browser_snapshot, semantic locator value, or CSS selector, at most 1,000 characters.",
    }),
    name: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: LIMITS.nameChars,
        description:
          "Accessible name for role targets only, at most 500 characters.",
      }),
    ),
    exact: Type.Optional(
      Type.Boolean({
        description:
          "Exact matching for role, text, label, or placeholder targets only; defaults to false.",
      }),
    ),
  },
  {
    additionalProperties: false,
    description:
      "One unique target in the active page. Refs bind to the live snapshot/document generation; stale or ambiguous targets fail without fallback.",
  },
);
export type Target = Static<typeof target>;
const waitCondition = Type.Union(
  [
    Type.Object(
      {
        kind: Type.Literal("url", {
          description: "Wait for the active page URL.",
        }),
        value: Type.String({
          minLength: 1,
          maxLength: LIMITS.urlChars,
          description:
            "Bounded URL text to match literally; no regex/glob interpretation.",
        }),
        match: Type.Optional(
          StringEnum(["contains", "exact"] as const, {
            description: "URL matching mode; defaults to contains.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal("text", {
          description: "Wait for visible rendered text.",
        }),
        value: Type.String({
          minLength: 1,
          maxLength: LIMITS.targetChars,
          description: "Bounded visible text to match.",
        }),
        exact: Type.Optional(
          Type.Boolean({
            description: "Require exact text matching; defaults to false.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal("target", {
          description: "Wait for a strict target state.",
        }),
        target,
        state: StringEnum(
          ["attached", "visible", "hidden", "detached"] as const,
          { description: "Required target state." },
        ),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal("load_state", {
          description: "Wait for a page load state.",
        }),
        state: StringEnum(["domcontentloaded", "load"] as const, {
          description: "Required page load state; networkidle is unsupported.",
        }),
      },
      { additionalProperties: false },
    ),
  ],
  {
    description:
      "Closed structured wait condition selected by kind; never a fixed sleep.",
  },
);
export type WaitCondition = Static<typeof waitCondition>;
const url = Type.String({
  minLength: 1,
  maxLength: LIMITS.urlChars,
  description:
    "Credential-free HTTP(S) URL, at most 2,000 characters; local development hosts are allowed.",
});
const value = Type.String({
  maxLength: LIMITS.fillChars,
  description: "Form text up to 20,000 characters; Browser never echoes it.",
});
const tabId = Type.String({
  minLength: 1,
  maxLength: LIMITS.tabChars,
  description:
    "Existing opaque tab ID from browser_tabs, at most 128 characters.",
});
const object = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
export const observationParameters = {
  snapshot: object({
    target: Type.Optional(target),
    depth: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 20,
        description: "AI snapshot depth, default 10.",
      }),
    ),
    boxes: Type.Optional(
      Type.Boolean({ description: "Include bounding boxes; default false." }),
    ),
  }),
  screenshot: object({
    capture: Type.Optional(
      Type.Union(
        [
          object({
            kind: Type.Literal("viewport", {
              description: "Capture the viewport (default).",
            }),
          }),
          object({
            kind: Type.Literal("page", {
              description:
                "Capture the full rendered page within image bounds.",
            }),
          }),
          object({
            kind: Type.Literal("target", {
              description: "Capture one strict element.",
            }),
            target,
          }),
        ],
        {
          description:
            "Screenshot scope; defaults to viewport. Page and target captures remain byte/dimension bounded.",
        },
      ),
    ),
  }),
  text: object({ target: Type.Optional(target) }),
  element: object({
    target,
    styleProperties: Type.Optional(
      Type.Array(
        Type.String({
          minLength: 1,
          maxLength: LIMITS.cssPropertyChars,
          description: "Hyphenated CSS property or custom property name.",
        }),
        {
          minItems: 1,
          maxItems: LIMITS.cssProperties,
          uniqueItems: true,
          description: "One to 32 unique additional CSS properties to inspect.",
        },
      ),
    ),
  }),
  diagnostics: object({
    categories: Type.Optional(
      Type.Array(
        StringEnum(
          ["console", "page_error", "request_failed", "http_error"] as const,
          { description: "Diagnostic category to return." },
        ),
        {
          minItems: 1,
          maxItems: 4,
          uniqueItems: true,
          description:
            "Unique categories; omitted means all. Reading never clears records or launches Chromium.",
        },
      ),
    ),
  }),
  tabs: object({}),
};
export const actionParameters = {
  navigate: object({ url }),
  history: object({
    action: StringEnum(["back", "forward", "reload"] as const, {
      description:
        "Navigate history or reload; wait for domcontentloaded without an implicit snapshot.",
    }),
  }),
  click: object({ target }),
  hover: object({ target }),
  set_checked: object({
    target,
    checked: Type.Boolean({
      description:
        "Desired checked state; preserves Playwright actionability without force.",
    }),
  }),
  fill: object({ target, value }),
  type: object({ target, value }),
  press: object({
    key: Type.String({
      minLength: 1,
      maxLength: LIMITS.keyChars,
      description: "Playwright key string, at most 100 characters.",
    }),
    target: Type.Optional(target),
  }),
  select: object({
    target,
    values: Type.Array(
      Type.String({
        maxLength: LIMITS.selectValueChars,
        description:
          "Existing option value, at most 500 characters; not echoed.",
      }),
      {
        minItems: 1,
        maxItems: LIMITS.selectValues,
        description: "One to 20 existing option values to select.",
      },
    ),
  }),
  scroll: object({
    deltaX: Type.Integer({
      minimum: -LIMITS.scrollDelta,
      maximum: LIMITS.scrollDelta,
      description:
        "Horizontal delta in CSS pixels; ±10,000, not both deltas zero.",
    }),
    deltaY: Type.Integer({
      minimum: -LIMITS.scrollDelta,
      maximum: LIMITS.scrollDelta,
      description:
        "Vertical delta in CSS pixels; ±10,000, not both deltas zero.",
    }),
    target: Type.Optional(target),
  }),
  wait: object({
    condition: waitCondition,
    timeoutMs: Type.Optional(
      Type.Integer({
        minimum: LIMITS.waitMinMs,
        maximum: LIMITS.waitMaxMs,
        description:
          "Read-only wait deadline, 100..120,000 ms; defaults to 10,000. Timeout is an error.",
      }),
    ),
  }),
  viewport: object({
    width: Type.Integer({
      minimum: LIMITS.viewport.minWidth,
      maximum: LIMITS.viewport.maxWidth,
      description: "Viewport width, 320..2,560 CSS pixels.",
    }),
    height: Type.Integer({
      minimum: LIMITS.viewport.minHeight,
      maximum: LIMITS.viewport.maxHeight,
      description: "Viewport height, 240..1,600 CSS pixels.",
    }),
  }),
  open_tab: object({ url: Type.Optional(url) }),
  switch_tab: object({ tabId }),
  close_tab: object({ tabId }),
};
export type Observation = keyof typeof observationParameters;
export type Action = keyof typeof actionParameters;
export type BrowserObserveInput = {
  mode: Observation;
  target?: Target;
  depth?: number;
  boxes?: boolean;
  fullPage?: boolean;
  styleProperties?: string[];
  categories?: string[];
};
export type BrowserActInput = {
  action:
    | Exclude<Action, "history" | "set_checked" | "viewport">
    | "back"
    | "forward"
    | "reload"
    | "check"
    | "uncheck"
    | "set_viewport";
  url?: string;
  target?: Target;
  value?: string;
  key?: string;
  values?: string[];
  deltaX?: number;
  deltaY?: number;
  condition?: WaitCondition;
  timeoutMs?: number;
  width?: number;
  height?: number;
  tabId?: string;
};
function controlSafe(value: string): boolean {
  return Array.from(value).every((character) => {
    const code = character.codePointAt(0)!;
    return code >= 32 && code !== 127;
  });
}
export function normalizeTarget(value: unknown): Target {
  if (
    !Check(target, value) ||
    !value.value.trim() ||
    !controlSafe(value.value) ||
    (value.name !== undefined &&
      (!value.name.trim() || !controlSafe(value.name)))
  ) {
    throw new BrowserError("target", "Browser target is invalid.");
  }
  if (
    (value.name !== undefined && value.kind !== "role") ||
    (value.exact !== undefined &&
      !["role", "text", "label", "placeholder"].includes(value.kind)) ||
    (value.kind === "ref" && !isSnapshotRef(value.value))
  ) {
    throw new BrowserError(
      "target",
      "Browser target has unsupported field combinations.",
    );
  }
  return { ...value };
}
export function normalizeObserve(
  mode: Observation,
  value: unknown,
): BrowserObserveInput {
  if (!Check(observationParameters[mode], value)) {
    throw new BrowserError(
      "target",
      "Browser observation has an invalid schema.",
    );
  }
  const input = value as BrowserObserveInput & {
    capture?: { kind: "viewport" | "page" | "target"; target?: Target };
  };
  const targetValue =
    mode === "screenshot" ? input.capture?.target : input.target;
  if (
    input.styleProperties?.some(
      (name) => !/^(?:--[a-zA-Z][\w-]*|[a-z][a-z0-9-]*)$/u.test(name),
    )
  ) {
    throw new BrowserError(
      "target",
      "Style properties must be unique valid CSS property names.",
    );
  }
  return {
    mode,
    target:
      targetValue === undefined ? undefined : normalizeTarget(targetValue),
    depth: input.depth,
    boxes: input.boxes,
    fullPage: input.capture?.kind === "page",
    styleProperties: input.styleProperties,
    categories: input.categories,
  };
}
export function normalizeAct(action: Action, value: unknown): BrowserActInput {
  if (!Check(actionParameters[action], value)) {
    throw new BrowserError("target", "Browser action has an invalid schema.");
  }
  const input = value as BrowserActInput & { checked?: boolean };
  if (input.url !== undefined) {
    validateUrl(input.url);
  }
  if (
    (input.tabId !== undefined &&
      (!input.tabId.trim() || !controlSafe(input.tabId))) ||
    (input.key !== undefined && (!input.key.trim() || !controlSafe(input.key)))
  ) {
    throw new BrowserError("target", "Browser tab ID or key is invalid.");
  }
  if (action === "scroll" && input.deltaX === 0 && input.deltaY === 0) {
    throw new BrowserError(
      "target",
      "Scroll requires at least one non-zero delta.",
    );
  }
  let condition = input.condition;
  if (condition?.kind === "target") {
    condition = { ...condition, target: normalizeTarget(condition.target) };
  }
  if (
    (condition?.kind === "text" || condition?.kind === "url") &&
    (!condition.value.trim() || !controlSafe(condition.value))
  ) {
    throw new BrowserError(
      "target",
      "Browser wait requires bounded non-empty control-safe text.",
    );
  }
  const { checked: _checked, ...fields } = input;
  return {
    ...fields,
    action:
      action === "history"
        ? input.action
        : action === "set_checked"
          ? input.checked
            ? "check"
            : "uncheck"
          : action === "viewport"
            ? "set_viewport"
            : action,
    target:
      input.target === undefined ? undefined : normalizeTarget(input.target),
    condition,
  };
}
export function validateUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BrowserError("target", "Browser URL is invalid.");
  }
  if (
    !value.trim() ||
    !controlSafe(value) ||
    value.length > LIMITS.urlChars ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password
  ) {
    throw new BrowserError(
      "target",
      "Browser navigation accepts bounded credential-free HTTP(S) URLs only.",
    );
  }
  return url;
}
