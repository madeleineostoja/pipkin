import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { BrowserError } from "./errors.js";
import { LIMITS } from "./limits.js";

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
      description: "How to resolve the page target.",
    }),
    value: Type.String({
      minLength: 1,
      maxLength: LIMITS.targetChars,
      description: "Ref, semantic value, or CSS selector for the target.",
    }),
    name: Type.Optional(
      Type.String({
        maxLength: LIMITS.nameChars,
        description: "Accessible name, valid only with a role target.",
      }),
    ),
    exact: Type.Optional(
      Type.Boolean({
        description:
          "Exact matching preference for supported semantic target kinds.",
      }),
    ),
  },
  {
    additionalProperties: false,
    description:
      "One strict semantic or CSS target for the current active page.",
  },
);

export const BrowserObserveParameters = Type.Object(
  {
    mode: StringEnum(
      [
        "snapshot",
        "screenshot",
        "text",
        "element",
        "diagnostics",
        "tabs",
      ] as const,
      { description: "Observation mode for the active rendered tab." },
    ),
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
        description: "Include bounding boxes in an AI snapshot.",
      }),
    ),
    fullPage: Type.Optional(
      Type.Boolean({
        description:
          "Capture the full page screenshot when no target is supplied.",
      }),
    ),
    styleProperties: Type.Optional(
      Type.Array(
        Type.String({
          minLength: 1,
          maxLength: LIMITS.cssPropertyChars,
          description: "Hyphenated CSS property or custom property to include.",
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
          description: "Unique diagnostic categories to return.",
        },
      ),
    ),
  },
  { additionalProperties: false },
);

export const BrowserActParameters = Type.Object(
  {
    action: StringEnum(
      [
        "navigate",
        "back",
        "forward",
        "reload",
        "set_viewport",
        "open_tab",
        "switch_tab",
        "close_tab",
      ] as const,
      { description: "Deterministic navigation or tab action to perform." },
    ),
    url: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: LIMITS.urlChars,
        description: "Credential-free HTTP(S) URL for navigation or a new tab.",
      }),
    ),
    width: Type.Optional(
      Type.Integer({
        minimum: LIMITS.viewport.minWidth,
        maximum: LIMITS.viewport.maxWidth,
        description: "Viewport width in CSS pixels.",
      }),
    ),
    height: Type.Optional(
      Type.Integer({
        minimum: LIMITS.viewport.minHeight,
        maximum: LIMITS.viewport.maxHeight,
        description: "Viewport height in CSS pixels.",
      }),
    ),
    tabId: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: LIMITS.tabChars,
        description: "Opaque tab ID from browser_observe tabs.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type Target = {
  kind: (typeof targetKinds)[number];
  value: string;
  name?: string;
  exact?: boolean;
};
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
  action:
    | "navigate"
    | "back"
    | "forward"
    | "reload"
    | "set_viewport"
    | "open_tab"
    | "switch_tab"
    | "close_tab";
  url?: string;
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
  const target = value as Target;
  if (
    (target.name !== undefined && target.kind !== "role") ||
    (target.exact !== undefined &&
      !["role", "text", "label", "placeholder"].includes(target.kind))
  ) {
    throw new BrowserError(
      "target",
      "Browser target has unsupported field combinations.",
    );
  }
  return { ...target };
}

export function normalizeObserve(value: unknown): BrowserObserveInput {
  if (
    !record(value) ||
    !only(value, [
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
    ].includes(value.mode as string)
  ) {
    throw new BrowserError(
      "target",
      "Browser observation has an invalid schema.",
    );
  }
  const input = value as BrowserObserveInput;
  if (input.target !== undefined) {
    input.target = normalizeTarget(input.target);
  }
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
    !only(value, permitted[input.mode]) ||
    (input.mode === "element" && !input.target) ||
    (input.mode === "screenshot" &&
      input.target &&
      Object.hasOwn(value, "fullPage"))
  ) {
    throw new BrowserError(
      "target",
      "Fields are incompatible with this Browser observation mode.",
    );
  }
  return input;
}

export function normalizeAct(value: unknown): BrowserActInput {
  if (
    !record(value) ||
    !only(value, ["action", "url", "width", "height", "tabId"]) ||
    ![
      "navigate",
      "back",
      "forward",
      "reload",
      "set_viewport",
      "open_tab",
      "switch_tab",
      "close_tab",
    ].includes(value.action as string)
  ) {
    throw new BrowserError("target", "Browser action has an invalid schema.");
  }
  const input = value as BrowserActInput;
  const required: Record<BrowserActInput["action"], readonly string[]> = {
    navigate: ["action", "url"],
    back: ["action"],
    forward: ["action"],
    reload: ["action"],
    set_viewport: ["action", "width", "height"],
    open_tab: ["action", "url"],
    switch_tab: ["action", "tabId"],
    close_tab: ["action", "tabId"],
  };
  const allowed =
    input.action === "open_tab" ? ["action", "url"] : required[input.action];
  if (
    !only(value, allowed) ||
    (input.action === "navigate" && !string(input.url, LIMITS.urlChars)) ||
    (input.action === "open_tab" &&
      input.url !== undefined &&
      !string(input.url, LIMITS.urlChars)) ||
    ((input.action === "switch_tab" || input.action === "close_tab") &&
      !string(input.tabId, LIMITS.tabChars)) ||
    (input.action === "set_viewport" &&
      (!Number.isInteger(input.width) ||
        !Number.isInteger(input.height) ||
        input.width! < LIMITS.viewport.minWidth ||
        input.width! > LIMITS.viewport.maxWidth ||
        input.height! < LIMITS.viewport.minHeight ||
        input.height! > LIMITS.viewport.maxHeight))
  ) {
    throw new BrowserError(
      "target",
      "Fields are invalid or incompatible with this Browser action.",
    );
  }
  if (input.url) {
    validateUrl(input.url);
  }
  return input;
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
