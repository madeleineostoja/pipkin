import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { LIMITS } from "./limits.js";

const string = (maxLength: number) => Type.String({ maxLength });
const integer = Type.Integer({ minimum: 0 });
export const pageSchema = Type.Object(
  {
    tabId: string(LIMITS.tabChars),
    url: string(LIMITS.urlChars),
    title: string(LIMITS.titleChars),
    generation: integer,
  },
  { additionalProperties: false },
);
const context = {
  generation: integer,
  stateLost: Type.Boolean(),
  recovery: Type.Optional(string(2000)),
};
const errorSchema = Type.Object(
  {
    ok: Type.Literal(false),
    error: Type.Object(
      {
        code: StringEnum([
          "installation",
          "launch",
          "cancelled",
          "target",
          "stale_ref",
          "timeout",
          "page_gone",
          "uncertain_outcome",
          "browser_disconnected",
          "content",
          "backend",
        ] as const),
        message: string(2000),
      },
      { additionalProperties: false },
    ),
    ...context,
    cause: Type.Optional(string(1000)),
  },
  { additionalProperties: false },
);
const page = { page: pageSchema, ...context };
const imageSchema = Type.Object(
  {
    type: Type.Literal("image"),
    data: string(Math.ceil(LIMITS.screenshotBytes / 3) * 4),
    mimeType: Type.Literal("image/png"),
  },
  { additionalProperties: false },
);
const truncation = { truncated: Type.Boolean() };
const box = Type.Object(
  {
    x: Type.Number(),
    y: Type.Number(),
    width: Type.Number(),
    height: Type.Number(),
  },
  { additionalProperties: false },
);
const elementSchema = Type.Object(
  {
    tag: string(128),
    role: Type.Optional(string(500)),
    name: Type.Optional(string(500)),
    attributes: Type.Record(Type.String({ maxLength: 128 }), string(1000), {
      maxProperties: 11,
    }),
    outerHtml: string(LIMITS.elementHtmlChars),
    text: string(LIMITS.textChars),
    value: Type.Optional(string(LIMITS.elementValueChars)),
    checked: Type.Optional(Type.Boolean()),
    disabled: Type.Optional(Type.Boolean()),
    visible: Type.Boolean(),
    box: Type.Optional(box),
    styles: Type.Record(
      Type.String({ maxLength: LIMITS.cssPropertyChars }),
      string(LIMITS.styleValueChars),
      { maxProperties: 48 },
    ),
  },
  { additionalProperties: false },
);
const eventFields = {
  sequence: integer,
  tabId: string(LIMITS.tabChars),
  message: string(LIMITS.diagnosticMessageChars),
};
const diagnosticSchema = Type.Union([
  Type.Object(
    {
      ...eventFields,
      category: Type.Literal("console"),
      url: Type.Optional(string(LIMITS.urlChars)),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...eventFields, category: Type.Literal("page_error") },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...eventFields,
      category: Type.Literal("request_failed"),
      url: string(LIMITS.urlChars),
      method: string(100),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...eventFields,
      category: Type.Literal("http_error"),
      url: string(LIMITS.urlChars),
      status: Type.Integer({ minimum: 400, maximum: 999 }),
    },
    { additionalProperties: false },
  ),
]);
export const observationSuccess = {
  snapshot: Type.Object(
    {
      ok: Type.Literal(true),
      ...page,
      snapshot: string(LIMITS.snapshotChars),
      ...truncation,
    },
    { additionalProperties: false },
  ),
  screenshot: Type.Object(
    {
      ok: Type.Literal(true),
      ...page,
      image: imageSchema,
      width: Type.Integer({ minimum: 1, maximum: LIMITS.screenshotWidth }),
      height: Type.Integer({ minimum: 1, maximum: LIMITS.screenshotHeight }),
      bytes: Type.Integer({ minimum: 1, maximum: LIMITS.screenshotBytes }),
    },
    { additionalProperties: false },
  ),
  text: Type.Object(
    {
      ok: Type.Literal(true),
      ...page,
      text: string(LIMITS.textChars),
      ...truncation,
    },
    { additionalProperties: false },
  ),
  element: Type.Object(
    { ok: Type.Literal(true), ...page, element: elementSchema, ...truncation },
    { additionalProperties: false },
  ),
  diagnostics: Type.Object(
    {
      ok: Type.Literal(true),
      ...context,
      page: Type.Optional(pageSchema),
      events: Type.Array(diagnosticSchema, {
        maxItems: LIMITS.diagnosticResult,
      }),
      dropped: integer,
      omitted: integer,
      ...truncation,
    },
    { additionalProperties: false },
  ),
  tabs: Type.Object(
    {
      ok: Type.Literal(true),
      ...context,
      tabs: Type.Array(
        Type.Object(
          {
            id: string(LIMITS.tabChars),
            url: string(LIMITS.urlChars),
            title: string(LIMITS.titleChars),
            active: Type.Boolean(),
          },
          { additionalProperties: false },
        ),
        { maxItems: LIMITS.tabCount },
      ),
      ...truncation,
    },
    { additionalProperties: false },
  ),
};
export const actionSuccess = Type.Object(
  {
    ok: Type.Literal(true),
    ...context,
    page: Type.Optional(pageSchema),
    action: StringEnum([
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
    ] as const),
    outcome: string(2000),
    tabId: Type.Optional(string(LIMITS.tabChars)),
    viewport: Type.Optional(
      Type.Object(
        {
          width: Type.Integer({
            minimum: LIMITS.viewport.minWidth,
            maximum: LIMITS.viewport.maxWidth,
          }),
          height: Type.Integer({
            minimum: LIMITS.viewport.minHeight,
            maximum: LIMITS.viewport.maxHeight,
          }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export const observationOutputs = {
  snapshot: Type.Union([observationSuccess.snapshot, errorSchema]),
  screenshot: Type.Union([observationSuccess.screenshot, errorSchema]),
  text: Type.Union([observationSuccess.text, errorSchema]),
  element: Type.Union([observationSuccess.element, errorSchema]),
  diagnostics: Type.Union([observationSuccess.diagnostics, errorSchema]),
  tabs: Type.Union([observationSuccess.tabs, errorSchema]),
};
export const actionOutput = Type.Union([actionSuccess, errorSchema]);
export type BrowserPage = Static<typeof pageSchema>;
export type ElementData = Static<typeof elementSchema>;
export type DiagnosticEvent = Static<typeof diagnosticSchema>;
export type ObservationSuccess = Static<
  (typeof observationSuccess)[keyof typeof observationSuccess]
>;
export type ActionSuccess = Static<typeof actionSuccess>;
export type BrowserFailure = Static<typeof errorSchema>;
export type BrowserPayload =
  | ObservationSuccess
  | ActionSuccess
  | BrowserFailure;
export type ImageContent = Static<typeof imageSchema>;
export type BrowserResult<T extends BrowserPayload = BrowserPayload> = {
  content: ({ type: "text"; text: string } | ImageContent)[];
  structuredContent: T;
  isError?: boolean;
  details: Record<string, unknown>;
};
export function success<T extends ObservationSuccess | ActionSuccess>(
  payload: T,
  details: Record<string, unknown>,
): BrowserResult<T> {
  const content: BrowserResult["content"] = [];
  if ("image" in payload) {
    const { image, ...readable } = payload;
    content.push({ type: "text", text: JSON.stringify(readable) }, image);
  } else {
    content.push({ type: "text", text: JSON.stringify(payload) });
  }
  return { content, structuredContent: payload, details };
}
