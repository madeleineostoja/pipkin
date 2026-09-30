# Browser

Browser owns one isolated, non-persistent headless Chromium context per Pi session for rendered local and HTTP(S) applications. It is separate from [Web Fetch](web-fetch.md), which is stateless and limited to credential-free public-address retrieval.

## Workflow

Use `browser_navigate`, then explicitly call `browser_snapshot` to inspect the rendered page. Interact through a snapshot ref or semantic target, and observe again after document/tab changes or uncertain outcomes. Actions return compact identity/outcomes, never hidden snapshots. All Browser operations use native deferred discovery in the `browser` namespace and share one serialized owner.

Codemode receives typed structured results, including errors as data (`ok:false` with native `isError:true` for direct callers). Screenshot results carry a native image block in both direct content and structured data. Explicitly forward it rather than printing the base64 payload:

```javascript
const navigation = await tools.browser_navigate({
  url: "http://localhost:3000",
});
if (!navigation.ok) {
  text(navigation);
} else {
  text(await tools.browser_snapshot({ depth: 10 }));
  const shot = await tools.browser_screenshot({
    capture: { kind: "viewport" },
  });
  if (shot.ok) image(shot.image);
  else text(shot);
}
```

This composition does not authorize replay after an uncertain action. Inspecting the page is evidence, not permission to repeat a possible mutation.

### Strict targets

| Field   | Contract                                                                                  |
| ------- | ----------------------------------------------------------------------------------------- |
| `kind`  | Required `ref`, `role`, `text`, `label`, `placeholder`, `test_id`, or `css`.              |
| `value` | Non-empty, control-safe string, at most 1,000 characters; selector spelling is preserved. |
| `name`  | Optional accessible name for `role` only, at most 500 characters.                         |
| `exact` | Optional for `role`, `text`, `label`, `placeholder` only; default false.                  |

Targets are a nested union selected by `kind`; the public schema rejects fields belonging to another kind. For `{kind:"role",value:"button",name:"Save"}`, `value` is the accessible role and `name` is the accessible label.

Snapshot refs are opaque, bound to their current snapshot/document and live owner generation. Browser resolves them only through Playwright's `aria-ref` selector. Semantic targets use corresponding `getBy…` locators; CSS is an explicit choice, never an automatic fallback. Resolution must match exactly one element. Stale refs and ambiguous targets fail explicitly. A semantic target wait may start before the element exists, but ambiguity is still rejected; refs must already resolve.

## Observation operations

Inputs are closed root objects, not dispatchers. Unknown, missing, unrelated or out-of-bound fields fail before startup or action dispatch. Page-required observations may launch lazily; `browser_tabs` and `browser_diagnostics` return empty success without launching Chromium.

| Tool                  | Inputs                                                                                                           | Successful data                                                                                                                                                                                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser_snapshot`    | Optional `target`, `depth` 1–20 (default 10), `boxes` (default false).                                           | Readable AI ARIA snapshot with actionable refs, `page`, `truncated`.                                                                                                                                                                                                            |
| `browser_screenshot`  | Optional `capture`: `{kind:"viewport"}` (default), `{kind:"page"}`, or `{kind:"target",target}`.                 | `page`, native PNG `image`, `width`, `height`, `bytes`.                                                                                                                                                                                                                         |
| `browser_text`        | Optional `target`.                                                                                               | Rendered inner `text`, `page`, `truncated`; not HTML/article extraction.                                                                                                                                                                                                        |
| `browser_element`     | Required `target`; optional 1–32 unique `styleProperties` using valid hyphenated/custom CSS names.               | Bounded `element` data: `tag`, available explicit `role`/ARIA `name`, curated `attributes`, `outerHtml`, `text`, available `value`/`checked`/`disabled`, `visible`, available viewport `box`, and curated/requested `styles`; `page`, `truncated`. Unavailable data is omitted. |
| `browser_diagnostics` | Optional unique `categories`: 1–4 of `console`, `page_error`, `request_failed`, `http_error`; omitted means all. | Typed `events`, retained-history `dropped`, matching retained `omitted`, `truncated`; `page` if available. Reading never clears records.                                                                                                                                        |
| `browser_tabs`        | Empty object.                                                                                                    | `tabs` with `id`, bounded sanitized `url`/`title`, `active`; `truncated`.                                                                                                                                                                                                       |

Page descriptors contain `{tabId,url,title,generation}`. Results also disclose owner `generation`, `stateLost` and bounded recovery guidance when relevant. URLs strip credentials, query and fragment data. Text and element fields redact remembered form input. Direct content contains the same useful bounded result, not just renderer metadata.

Listeners retain the newest 100 normalized console warnings/errors, uncaught page errors, failed requests and HTTP 4xx/5xx records. Events carry `sequence`, `tabId`, `category`, `message`; console may include `url`, failed requests include `url`/`method`, HTTP errors include `url`/`status`. No bodies, headers, cookies, console object graphs or protocol objects are returned. Records keep their tab ID after closure. Returned events are source-ordered; bounded selection favors the newest records. `truncated` also reports clipped event fields, even when no records were dropped or omitted.

## Action operations

| Tool                                      | Inputs and behavior                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------------------- |
| `browser_navigate`                        | Required credential-free HTTP(S) `url`; navigate the active page to `domcontentloaded`. |
| `browser_history`                         | Required `action`: `back`, `forward`, or `reload`; wait for `domcontentloaded`.         |
| `browser_click`, `browser_hover`          | Required strict `target`; preserve actionability without force.                         |
| `browser_set_checked`                     | Required `target` and boolean `checked`.                                                |
| `browser_fill`, `browser_type`            | Required `target`, bounded text `value`; never echo supplied text.                      |
| `browser_press`                           | Required bounded `key`, optional `target`; otherwise press on the active page.          |
| `browser_select`                          | Required `target`, 1–20 existing option `values`; values are not echoed.                |
| `browser_scroll`                          | Required integer `deltaX`/`deltaY`, each ±10,000 and not both zero; optional `target`.  |
| `browser_wait`                            | Required closed `condition`, optional `timeoutMs`; read-only, timeout is an error.      |
| `browser_viewport`                        | Required integer `width`/`height` within viewport bounds.                               |
| `browser_open_tab`                        | Optional validated HTTP(S) `url`; creates/activates a tab, returns its `tabId`.         |
| `browser_switch_tab`, `browser_close_tab` | Required existing opaque `tabId`. Return active page identity.                          |

`browser_fill` replaces existing field contents; `browser_type` types sequentially without clearing first, for interactions that need individual key events.

Wait conditions are `{kind:"url",value,match?:"contains"|"exact"}` (contains default), `{kind:"text",value,exact?}`, `{kind:"target",target,state:"attached"|"visible"|"hidden"|"detached"}`, or `{kind:"load_state",state:"domcontentloaded"|"load"}`. Timeout defaults to 10,000 ms, range 100–120,000. No regex/glob language, `networkidle`, or fixed sleep.

Successful actions contain `action`, `outcome`, compact `page` identity, generation/state-loss metadata and recovery guidance when needed. Viewport results also return the applied `viewport`. No implicit full snapshot, JavaScript evaluation, raw Playwright options, CDP or forced actions are exposed.

A popup opened during a dispatched action becomes active at settlement. A page opened outside an action is listed but does not steal focus. When an active page closes, Browser selects the most recently active live tab or creates a fresh blank page. Closing the last tab therefore leaves one usable blank page; closing a non-active tab does not invalidate active refs. Tab IDs are monotonic and not reused during a session.

Generic fill/type may target password fields when the model already has a value. Browser has no credential vault or acquisition behavior. It suppresses remembered supplied text in Browser-owned evidence, but cannot redact Pi transcript/provider inputs. Selected values are not unnecessarily echoed.

## Installation and lifecycle

Runtime dependencies `playwright-core` and `@playwright/browser-chromium` supply matching Chromium/headless-shell/FFmpeg revisions in Playwright's shared OS cache. Install with `npm install` and permit the browser package's standard install lifecycle. If npm reports blocked scripts, review and approve `@playwright/browser-chromium` with the installed npm's script-policy commands, then `npm rebuild @playwright/browser-chromium`. Do not install a global Playwright CLI. Browser never downloads artifacts during tool execution; a missing executable returns `installation` with repair guidance.

Extension loading and `session_start` do not launch Chromium. The first page-required call starts one headless browser, ephemeral context with locale `en-US`, and blank `1440×900` page. This gives `Intl` a valid locale. Calls are serialized; queued cancellation never starts an operation. Executing cancellation/shutdown closes and invalidates the runtime before another call can use it. Session reset and shutdown are idempotent.

Disconnect/reset/context recreation loses tabs, refs and diagnostics. Results explicitly disclose state loss. Browser does not use an existing profile, persistent directory, downloads, uploads, proxy, permissions, executable override or filesystem-path option.

## Bounds

| Boundary               | Contract                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Viewport               | Default `1440×900`, scale factor 1; width 320–2560, height 240–1600 CSS pixels.                                                                |
| Deadlines              | Launch/navigation 30s; element 10s; wait default 10s, range 100–120000 ms.                                                                     |
| Form/key/select/scroll | Form text 20,000 chars; keys 100; 1–20 option values up to 500 chars; deltas ±10,000, not both zero.                                           |
| URL/target/name/tab ID | 2,000 / 1,000 / 500 / 128 chars.                                                                                                               |
| Snapshot/text          | 16,000 chars and 600 lines; snapshot depth 1–20, default 10.                                                                                   |
| Element                | HTML 12,000 chars; text 16,000/600 lines; value/styles/curated attribute values 1,000 chars each; up to 32 requested style names of 128 chars. |
| Diagnostics            | Retain newest 100; return newest 50 within 16,000 chars and 600 message lines; messages 1,000 chars, URLs 2,000.                               |
| Screenshot             | PNG at most 10 MiB, 4,096 CSS-pixel width, 12,000 height.                                                                                      |
| Tabs                   | At most 20 live tabs.                                                                                                                          |

Text stops at the first character/line bound, appends `…` and exposes `truncated`; renderer metadata retains original/returned counts. It never splits surrogate pairs or snapshot ref tokens. Oversized images fail as `content`; they are not written, truncated or rescaled.

## Recovery and safety

Failures return `{ok:false,error:{code,message},generation,stateLost,cause?,recovery?}` directly, with native `isError:true`; no reconstruction listener or failure map is involved.

| Code                     | Meaning and recovery                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `installation`, `launch` | No usable context; repair managed installation or platform/sandbox constraints, then observe.                                  |
| `target`                 | Invalid/missing/ambiguous input or target before dispatch; correct input or observe a unique target.                           |
| `stale_ref`              | Ref is not current or no longer resolves; snapshot again for fresh refs.                                                       |
| `cancelled`              | Pre-dispatch cancellation or observation/read-only wait cancellation; check the current page before continuing.                |
| `timeout`                | Read-only deadline exceeded; observe before deciding whether to wait again.                                                    |
| `page_gone`              | Page lost without an in-flight mutation; inspect tabs or fallback page.                                                        |
| `browser_disconnected`   | Context/refs/tabs invalidated without an in-flight mutation; observe to start fresh.                                           |
| `uncertain_outcome`      | Mutation failed/timed out/cancelled after possible dispatch; never replay automatically. Observe before choosing a new action. |
| `content`                | Output/image exceeds a fixed bound; narrow scope or choose viewport/target capture.                                            |
| `backend`                | Unexpected bounded failure; observe state, retry only a read-only operation when understood.                                   |

Pre-dispatch input/target/stale-ref failures take precedence; dispatched state-changing failures become `uncertain_outcome`. Only observations retry once, and only after the owner proves generation loss, including loss during final page identity collection. Successful evidence and refs belong to the reported live generation. State loss is acknowledged only by the final delivered result, so cancellation cannot hide its notice. No action is replayed. Wait is read-only: cancellation/timeout remain `cancelled`/`timeout`, page loss/disconnect remain `page_gone`/`browser_disconnected`.

Top-level navigation accepts credential-free HTTP(S), including loopback/private development hosts, and rejects file/data/JavaScript/browser-internal/extension URLs. This is **not an SSRF boundary**: redirects, subresources and loaded pages retain ordinary Chromium network authority. Rendered text, diagnostics and images are untrusted evidence. Browser activity is outside Sandbox/Readonly mediation; Chromium's sandbox is not a Pipkin trust boundary.
