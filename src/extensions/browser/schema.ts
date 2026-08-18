import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
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
const actions = [
  "navigate",
  "back",
  "forward",
  "reload",
  "click",
  "hover",
  "check",
  "uncheck",
  "fill",
  "type",
  "press",
  "select",
  "scroll",
  "wait",
  "set_viewport",
  "open_tab",
  "switch_tab",
  "close_tab",
] as const;
const targetValue = Type.String({
  minLength: 1,
  maxLength: LIMITS.targetChars,
  description:
    "Non-empty snapshot ref, semantic locator value, or CSS selector, at most 1,000 characters.",
});
const target = Type.Object(
  {
    kind: StringEnum(targetKinds, {
      description:
        "Resolution kind: snapshot ref, semantic locator, or explicit CSS fallback.",
    }),
    value: targetValue,
    name: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: LIMITS.nameChars,
        description:
          "Accessible name for role targets, at most 500 characters.",
      }),
    ),
    exact: Type.Optional(
      Type.Boolean({
        description:
          "Exact matching for role, text, label, or placeholder targets.",
      }),
    ),
  },
  {
    additionalProperties: false,
    description:
      "One strict target in the active rendered page; kind-specific field compatibility is validated before use.",
  },
);

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
          description: "Bounded URL text to match.",
        }),
        match: Type.Optional(
          StringEnum(["contains", "exact"] as const, {
            description:
              "URL matching mode; contains is the default and regex or glob patterns are unsupported.",
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
            description:
              "Whether visible text must match exactly; defaults to false.",
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
          description: "Required page load state.",
        }),
      },
      { additionalProperties: false },
    ),
  ],
  {
    description:
      "Closed structured wait condition with fields selected by kind.",
  },
);

const observeRequest = Type.Union(
  [
    Type.Object(
      {
        mode: Type.Literal("snapshot", {
          description: "Capture an AI accessibility snapshot.",
        }),
        target: Type.Optional(target),
        depth: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 20,
            description: "AI snapshot depth, defaulting to 10.",
          }),
        ),
        boxes: Type.Optional(
          Type.Boolean({
            description: "Include bounding boxes in the AI snapshot.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        mode: Type.Literal("screenshot", {
          description: "Capture the viewport or full rendered page.",
        }),
        fullPage: Type.Optional(
          Type.Boolean({
            description:
              "Capture the full page instead of the viewport; defaults to false.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        mode: Type.Literal("screenshot", {
          description: "Capture one strict target.",
        }),
        target,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        mode: Type.Literal("text", {
          description: "Read rendered inner text.",
        }),
        target: Type.Optional(target),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        mode: Type.Literal("element", {
          description: "Inspect one strict element.",
        }),
        target,
        styleProperties: Type.Optional(
          Type.Array(
            Type.String({
              minLength: 1,
              maxLength: LIMITS.cssPropertyChars,
              description:
                "Hyphenated CSS property or custom property to include.",
            }),
            {
              minItems: 1,
              maxItems: LIMITS.cssProperties,
              uniqueItems: true,
              description:
                "Additional unique CSS properties for element inspection.",
            },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        mode: Type.Literal("diagnostics", {
          description: "Read retained browser diagnostics.",
        }),
        categories: Type.Optional(
          Type.Array(
            StringEnum(
              [
                "console",
                "page_error",
                "request_failed",
                "http_error",
              ] as const,
              { description: "Diagnostic category to return." },
            ),
            {
              minItems: 1,
              maxItems: 4,
              uniqueItems: true,
              description: "Unique diagnostic categories to return.",
            },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        mode: Type.Literal("tabs", {
          description: "List live browser tabs.",
        }),
      },
      { additionalProperties: false },
    ),
  ],
  { description: "Mode-specific browser observation request." },
);

const actionUrl = Type.String({
  minLength: 1,
  maxLength: LIMITS.urlChars,
  description: "Credential-free HTTP(S) URL.",
});
const actionValue = Type.String({
  maxLength: LIMITS.fillChars,
  description: "Text up to 20,000 characters; Browser never echoes it.",
});
const actionKey = Type.String({
  minLength: 1,
  maxLength: LIMITS.keyChars,
  description: "Playwright key string, at most 100 characters.",
});
const actionValues = Type.Array(
  Type.String({
    maxLength: LIMITS.selectValueChars,
    description: "Existing select option value, at most 500 characters.",
  }),
  {
    minItems: 1,
    maxItems: LIMITS.selectValues,
    description: "One to 20 existing select option values.",
  },
);
const deltaX = Type.Integer({
  minimum: -LIMITS.scrollDelta,
  maximum: LIMITS.scrollDelta,
  description: "Horizontal scroll delta from -10,000 to 10,000 CSS pixels.",
});
const deltaY = Type.Integer({
  minimum: -LIMITS.scrollDelta,
  maximum: LIMITS.scrollDelta,
  description: "Vertical scroll delta from -10,000 to 10,000 CSS pixels.",
});
const tabId = Type.String({
  minLength: 1,
  maxLength: LIMITS.tabChars,
  description: "Existing opaque tab ID from browser_observe tabs.",
});
function actionKind<T extends (typeof actions)[number]>(action: T) {
  return Type.Literal(action, {
    description: `Perform the ${action.replaceAll("_", " ")} action.`,
  });
}
const actRequest = Type.Union(
  [
    Type.Object(
      { action: actionKind("navigate"), url: actionUrl },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        action: StringEnum(["back", "forward", "reload"] as const, {
          description: "Navigate browser history or reload the active page.",
        }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        action: StringEnum(["click", "hover", "check", "uncheck"] as const, {
          description: "Interact with one required strict target.",
        }),
        target,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        action: StringEnum(["fill", "type"] as const, {
          description: "Supply text to one required strict target.",
        }),
        target,
        value: actionValue,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        action: actionKind("press"),
        key: actionKey,
        target: Type.Optional(target),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      { action: actionKind("select"), target, values: actionValues },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        action: actionKind("scroll"),
        deltaX,
        deltaY,
        target: Type.Optional(target),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        action: actionKind("wait"),
        condition: waitCondition,
        timeoutMs: Type.Optional(
          Type.Integer({
            minimum: LIMITS.waitMinMs,
            maximum: LIMITS.waitMaxMs,
            description:
              "Read-only wait deadline from 100 to 120,000 milliseconds; defaults to 10,000.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        action: actionKind("set_viewport"),
        width: Type.Integer({
          minimum: LIMITS.viewport.minWidth,
          maximum: LIMITS.viewport.maxWidth,
          description: "Viewport width in CSS pixels.",
        }),
        height: Type.Integer({
          minimum: LIMITS.viewport.minHeight,
          maximum: LIMITS.viewport.maxHeight,
          description: "Viewport height in CSS pixels.",
        }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        action: actionKind("open_tab"),
        url: Type.Optional(actionUrl),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        action: StringEnum(["switch_tab", "close_tab"] as const, {
          description: "Switch to or close one existing tab.",
        }),
        tabId,
      },
      { additionalProperties: false },
    ),
  ],
  { description: "Action-specific deterministic browser request." },
);

export const BrowserObserveParameters = Type.Object(
  {
    request: observeRequest,
  },
  {
    additionalProperties: false,
    description: "One mode-specific browser observation request.",
  },
);

export const BrowserActParameters = Type.Object(
  {
    request: actRequest,
  },
  {
    additionalProperties: false,
    description: "One action-specific browser request.",
  },
);

export type BrowserObserveParametersInput = Static<
  typeof BrowserObserveParameters
>;
export type BrowserActParametersInput = Static<typeof BrowserActParameters>;
export type Target = {
  kind: (typeof targetKinds)[number];
  value: string;
  name?: string;
  exact?: boolean;
};
export type WaitCondition =
  | { kind: "url"; value: string; match?: "contains" | "exact" }
  | { kind: "text"; value: string; exact?: boolean }
  | {
      kind: "target";
      target: Target;
      state: "attached" | "visible" | "hidden" | "detached";
    }
  | { kind: "load_state"; state: "domcontentloaded" | "load" };
export type BrowserObserveInput = {
  mode: "snapshot" | "screenshot" | "text" | "element" | "diagnostics" | "tabs";
  target?: Target;
  depth?: number;
  boxes?: boolean;
  fullPage?: boolean;
  styleProperties?: string[];
  categories?: string[];
};
export type BrowserActInput = {
  action: (typeof actions)[number];
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

const cssName = /^(?:--[a-zA-Z][\w-]*|[a-z][a-z0-9-]*)$/u;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function only(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).every((key) => keys.includes(key));
}
function string(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    !Array.from(value).some((character) => {
      const code = character.codePointAt(0)!;
      return code < 32 || code === 127;
    })
  );
}
function inputText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && Array.from(value).length <= maximum;
}

export function normalizeTarget(value: unknown): Target {
  if (
    !record(value) ||
    !only(value, ["kind", "value", "name", "exact"]) ||
    !targetKinds.includes(value.kind as Target["kind"]) ||
    !string(value.value, LIMITS.targetChars) ||
    (value.name !== undefined && !string(value.name, LIMITS.nameChars)) ||
    (value.exact !== undefined && typeof value.exact !== "boolean")
  ) {
    throw new BrowserError("target", "Browser target is invalid.");
  }
  const normalized = value as Target;
  if (
    (normalized.name !== undefined && normalized.kind !== "role") ||
    (normalized.exact !== undefined &&
      !["role", "text", "label", "placeholder"].includes(normalized.kind)) ||
    (normalized.kind === "ref" && !isSnapshotRef(normalized.value))
  ) {
    throw new BrowserError(
      "target",
      "Browser target has unsupported field combinations.",
    );
  }
  return { ...normalized };
}

export function normalizeObserve(value: unknown): BrowserObserveInput {
  if (!record(value) || !only(value, ["request"])) {
    throw new BrowserError(
      "target",
      "Browser observation has an invalid schema.",
    );
  }
  const request = value.request;
  if (
    !record(request) ||
    !only(request, [
      "mode",
      "target",
      "depth",
      "boxes",
      "fullPage",
      "styleProperties",
      "categories",
    ]) ||
    ![
      "snapshot",
      "screenshot",
      "text",
      "element",
      "diagnostics",
      "tabs",
    ].includes(request.mode as string)
  ) {
    throw new BrowserError(
      "target",
      "Browser observation has an invalid schema.",
    );
  }
  const input = request as BrowserObserveInput;
  const targetValue =
    input.target === undefined ? undefined : normalizeTarget(input.target);
  if (
    input.depth !== undefined &&
    (!Number.isInteger(input.depth) || input.depth < 1 || input.depth > 20)
  ) {
    throw new BrowserError(
      "target",
      "Snapshot depth must be an integer from 1 to 20.",
    );
  }
  if (input.boxes !== undefined && typeof input.boxes !== "boolean") {
    throw new BrowserError("target", "Snapshot boxes must be boolean.");
  }
  if (input.fullPage !== undefined && typeof input.fullPage !== "boolean") {
    throw new BrowserError("target", "Screenshot fullPage must be boolean.");
  }
  if (
    input.styleProperties !== undefined &&
    (!Array.isArray(input.styleProperties) ||
      input.styleProperties.length < 1 ||
      input.styleProperties.length > LIMITS.cssProperties ||
      new Set(input.styleProperties).size !== input.styleProperties.length ||
      input.styleProperties.some(
        (name) => !string(name, LIMITS.cssPropertyChars) || !cssName.test(name),
      ))
  ) {
    throw new BrowserError(
      "target",
      "Style properties must be unique valid CSS property names.",
    );
  }
  if (
    input.categories !== undefined &&
    (!Array.isArray(input.categories) ||
      input.categories.length < 1 ||
      input.categories.length > 4 ||
      new Set(input.categories).size !== input.categories.length ||
      input.categories.some(
        (category) =>
          !["console", "page_error", "request_failed", "http_error"].includes(
            category,
          ),
      ))
  ) {
    throw new BrowserError("target", "Diagnostic categories are invalid.");
  }
  const permitted: Record<BrowserObserveInput["mode"], readonly string[]> = {
    snapshot: ["mode", "target", "depth", "boxes"],
    screenshot: ["mode", "target", "fullPage"],
    text: ["mode", "target"],
    element: ["mode", "target", "styleProperties"],
    diagnostics: ["mode", "categories"],
    tabs: ["mode"],
  };
  if (
    !only(request, permitted[input.mode]) ||
    (input.mode === "element" && !targetValue) ||
    (input.mode === "screenshot" &&
      targetValue &&
      Object.hasOwn(request, "fullPage"))
  ) {
    throw new BrowserError(
      "target",
      "Fields are incompatible with this Browser observation mode.",
    );
  }
  return { ...input, target: targetValue };
}

export function normalizeAct(value: unknown): BrowserActInput {
  if (!record(value) || !only(value, ["request"])) {
    throw new BrowserError("target", "Browser action has an invalid schema.");
  }
  const request = value.request;
  if (!record(request)) {
    throw new BrowserError("target", "Browser action has an invalid schema.");
  }
  const fields = [
    "action",
    "url",
    "target",
    "value",
    "key",
    "values",
    "deltaX",
    "deltaY",
    "condition",
    "timeoutMs",
    "width",
    "height",
    "tabId",
  ];
  if (
    !only(request, fields) ||
    !actions.includes(request.action as BrowserActInput["action"])
  ) {
    throw new BrowserError("target", "Browser action has an invalid schema.");
  }
  const input = request as BrowserActInput;
  const targetValue =
    input.target === undefined ? undefined : normalizeTarget(input.target);
  const allowed: Record<BrowserActInput["action"], readonly string[]> = {
    navigate: ["action", "url"],
    back: ["action"],
    forward: ["action"],
    reload: ["action"],
    click: ["action", "target"],
    hover: ["action", "target"],
    check: ["action", "target"],
    uncheck: ["action", "target"],
    fill: ["action", "target", "value"],
    type: ["action", "target", "value"],
    press: ["action", "key", "target"],
    select: ["action", "target", "values"],
    scroll: ["action", "deltaX", "deltaY", "target"],
    wait: ["action", "condition", "timeoutMs"],
    set_viewport: ["action", "width", "height"],
    open_tab: ["action", "url"],
    switch_tab: ["action", "tabId"],
    close_tab: ["action", "tabId"],
  };
  if (!only(request, allowed[input.action])) {
    throw new BrowserError(
      "target",
      "Fields are invalid or incompatible with this Browser action.",
    );
  }
  if (
    (
      [
        "click",
        "hover",
        "check",
        "uncheck",
        "fill",
        "type",
        "select",
      ] as string[]
    ).includes(input.action) &&
    !targetValue
  ) {
    throw new BrowserError("target", "This Browser action requires a target.");
  }
  if (
    (input.action === "fill" || input.action === "type") &&
    !inputText(input.value, LIMITS.fillChars)
  ) {
    throw new BrowserError(
      "target",
      "Fill and type values must be bounded text.",
    );
  }
  if (input.action === "press" && !string(input.key, LIMITS.keyChars)) {
    throw new BrowserError("target", "Browser key is invalid.");
  }
  if (
    input.action === "select" &&
    (!Array.isArray(input.values) ||
      input.values.length < 1 ||
      input.values.length > LIMITS.selectValues ||
      input.values.some((entry) => !inputText(entry, LIMITS.selectValueChars)))
  ) {
    throw new BrowserError(
      "target",
      "Select requires one to 20 bounded option values.",
    );
  }
  if (
    input.action === "scroll" &&
    (!Number.isInteger(input.deltaX) ||
      !Number.isInteger(input.deltaY) ||
      Math.abs(input.deltaX!) > LIMITS.scrollDelta ||
      Math.abs(input.deltaY!) > LIMITS.scrollDelta ||
      (input.deltaX === 0 && input.deltaY === 0))
  ) {
    throw new BrowserError(
      "target",
      "Scroll requires non-zero integer deltas from -10,000 to 10,000.",
    );
  }
  if (input.action === "wait") {
    normalizeWait(input.condition, input.timeoutMs);
  }
  if (
    input.action === "set_viewport" &&
    (!Number.isInteger(input.width) ||
      !Number.isInteger(input.height) ||
      input.width! < LIMITS.viewport.minWidth ||
      input.width! > LIMITS.viewport.maxWidth ||
      input.height! < LIMITS.viewport.minHeight ||
      input.height! > LIMITS.viewport.maxHeight)
  ) {
    throw new BrowserError("target", "Viewport dimensions are invalid.");
  }
  if (
    (input.action === "switch_tab" || input.action === "close_tab") &&
    !string(input.tabId, LIMITS.tabChars)
  ) {
    throw new BrowserError("target", "Browser tab ID is invalid.");
  }
  if (
    (input.action === "navigate" && !string(input.url, LIMITS.urlChars)) ||
    (input.action === "open_tab" &&
      input.url !== undefined &&
      !string(input.url, LIMITS.urlChars))
  ) {
    throw new BrowserError("target", "Browser URL is invalid.");
  }
  if (input.url) {
    validateUrl(input.url);
  }
  return {
    ...input,
    target: targetValue,
    condition:
      input.action === "wait"
        ? normalizeWait(input.condition, input.timeoutMs)
        : undefined,
  };
}

function normalizeWait(value: unknown, timeoutMs: unknown): WaitCondition {
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== "number" ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < LIMITS.waitMinMs ||
      timeoutMs > LIMITS.waitMaxMs)
  ) {
    throw new BrowserError(
      "target",
      "Wait timeout must be an integer from 100 to 120,000 milliseconds.",
    );
  }
  if (
    !record(value) ||
    !["url", "text", "target", "load_state"].includes(value.kind as string)
  ) {
    throw new BrowserError("target", "Browser wait condition is invalid.");
  }
  const kind = value.kind as WaitCondition["kind"];
  const fields: Record<WaitCondition["kind"], readonly string[]> = {
    url: ["kind", "value", "match"],
    text: ["kind", "value", "exact"],
    target: ["kind", "target", "state"],
    load_state: ["kind", "state"],
  };
  if (!only(value, fields[kind])) {
    throw new BrowserError("target", "Wait condition has incompatible fields.");
  }
  if (kind === "url") {
    if (
      !string(value.value, LIMITS.urlChars) ||
      (value.match !== undefined &&
        value.match !== "contains" &&
        value.match !== "exact")
    ) {
      throw new BrowserError(
        "target",
        "URL wait requires bounded text and contains or exact matching.",
      );
    }
    return {
      kind,
      value: value.value,
      match: value.match as "contains" | "exact" | undefined,
    };
  }
  if (kind === "text") {
    if (
      !string(value.value, LIMITS.targetChars) ||
      (value.exact !== undefined && typeof value.exact !== "boolean")
    ) {
      throw new BrowserError(
        "target",
        "Text wait requires bounded visible text and an optional boolean exact flag.",
      );
    }
    return {
      kind,
      value: value.value,
      exact: value.exact as boolean | undefined,
    };
  }
  if (kind === "target") {
    if (
      !Object.hasOwn(value, "target") ||
      !["attached", "visible", "hidden", "detached"].includes(
        value.state as string,
      )
    ) {
      throw new BrowserError(
        "target",
        "Target wait requires a target and supported state.",
      );
    }
    return {
      kind,
      target: normalizeTarget(value.target),
      state: value.state as "attached" | "visible" | "hidden" | "detached",
    };
  }
  if (!["domcontentloaded", "load"].includes(value.state as string)) {
    throw new BrowserError(
      "target",
      "Load-state wait accepts domcontentloaded or load only.",
    );
  }
  return { kind, state: value.state as "domcontentloaded" | "load" };
}

export function validateUrl(value: string): URL {
  if (!string(value, LIMITS.urlChars)) {
    throw new BrowserError(
      "target",
      "Browser URL must be a bounded non-empty HTTP(S) URL.",
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BrowserError("target", "Browser URL is invalid.");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password
  ) {
    throw new BrowserError(
      "target",
      "Browser navigation accepts credential-free HTTP(S) URLs only.",
    );
  }
  return url;
}
