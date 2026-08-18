# Browser

Browser is Pipkin's stateful rendered-interface tool. It owns one isolated, non-persistent headless Chromium context per Pi session for local and HTTP(S) applications. It is deliberately separate from [Web Fetch](web-fetch.md), which is stateless, credential-free, and limited to public-address retrieval.

## Installation and session lifecycle

Pipkin declares `playwright-core` and `@playwright/browser-chromium` as runtime dependencies. A normal `npm install` runs the browser package's standard lifecycle, placing matching Chromium, headless-shell, and FFmpeg revisions in Playwright's shared OS cache. Browser never downloads or updates these artifacts while a tool runs.

If the expected executable is missing (for example, lifecycle scripts were skipped or the cache was removed), the first call fails as `installation`, names the installed Playwright version, and tells the operator to repair the normal Pipkin install with `npm install` or `npm rebuild`. Do not install a global Playwright CLI.

Extension loading and `session_start` do not launch Chromium. The first call to either Browser tool coalesces startup into one headless browser, one ephemeral context, and one blank `1440×900` page. Calls are serialized; queued cancellation never starts a browser operation, and executing cancellation or shutdown closes/invalidate the active runtime before another call can use it. `session_start` defensively resets stale state and `session_shutdown` is idempotent.

A disconnect, reset, or context recreation loses all tabs, refs, and diagnostics. Results identify fresh-context state loss. Browser uses no existing profile, persistent storage directory, downloads, uploads, proxy, permission, executable, or filesystem-path option.

## Workflow and targets

Use `browser_observe` to understand rendered state, particularly `snapshot`, then use `browser_act` to interact through a ref or semantic target. Observe again after a document or tab change and after an uncertain result. Snapshot refs belong only to the current document; rerendering, navigation, switching tabs, or recreating the context can make them stale.

A target is a closed object with these fields:

| Field   | Contract                                                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`  | Required: `ref`, `role`, `text`, `label`, `placeholder`, `test_id`, or `css`.                                                               |
| `value` | Required non-empty, control-character-free string, at most 1,000 characters. Its spelling is preserved; whitespace is not silently trimmed. |
| `name`  | Optional accessible name, only for `role`, at most 500 characters.                                                                          |
| `exact` | Optional boolean for `role`, `text`, `label`, and `placeholder` only; defaults to `false`.                                                  |

Browser makes each emitted `ref` opaque and binds it to the snapshot/document that emitted it, then resolves its underlying value only through Playwright's `aria-ref=<ref>` selector. The other semantic kinds map to their corresponding Playwright `getBy…` locator, and `css` is an explicit fallback. Resolution is strict: it must match exactly one element. Stale refs and ambiguous targets are not healed; observe again instead.

## Tools

### `browser_observe`

All modes return bounded external evidence and sanitized current URL/title metadata where page evidence is returned. Unknown, missing, unrelated, conflicting, control-character, or out-of-bound fields fail before startup or page mutation.

| Mode          | Fields                                                                                                                                                 | Result                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `snapshot`    | Optional `target`; `depth` integer `1–20` (default `10`); `boxes` boolean (default `false`).                                                           | Playwright AI ARIA YAML with actionable refs, scope and truncation counts.                                                           |
| `screenshot`  | Optional element `target`, or `fullPage` boolean (default `false`) without a target. Supplying both fields is invalid even when `fullPage` is `false`. | Exactly one in-memory PNG image block plus text, scope, dimensions, bytes, URL, and title.                                           |
| `text`        | Optional `target`.                                                                                                                                     | Rendered `innerText`, not source HTML or article extraction.                                                                         |
| `element`     | Required `target`; optional unique `styleProperties` array of 1–32 valid hyphenated/custom CSS names.                                                  | Bounded outer HTML and text, value/checked/disabled/Playwright visibility state, viewport box, curated styles, and requested styles. |
| `diagnostics` | Optional unique `categories` array containing 1–4 of `console`, `page_error`, `request_failed`, `http_error`; omitted means all.                       | Recent normalized records; reading does not clear them.                                                                              |
| `tabs`        | No other fields.                                                                                                                                       | Live opaque tab IDs, bounded titles, sanitized URLs, and active markers.                                                             |

Browser attaches page listeners as soon as it owns a page. It retains the newest 100 console warning/error, uncaught page error, failed request, and HTTP 4xx/5xx records, without bodies, headers, cookies, request bodies, console object graphs, or protocol objects. Each record has bounded message/URL fields and keeps its original tab ID after that tab closes.

### `browser_act`

`browser_act` accepts only the following deterministic actions. It rejects unknown, unrelated, conflicting, unsupported, or out-of-bound fields before dispatch.

| Action                               | Fields and behaviour                                                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `navigate`                           | Required credential-free HTTP(S) `url`; replaces the active tab at `domcontentloaded`.                                              |
| `back`, `forward`, `reload`          | No additional fields; use history/reload and wait for `domcontentloaded`.                                                           |
| `click`, `hover`, `check`, `uncheck` | Required strict `target`; preserve Playwright actionability with no force.                                                          |
| `fill`, `type`                       | Required `target` and text `value` up to 20,000 characters. Browser never echoes supplied text.                                     |
| `press`                              | Required key up to 100 characters and optional target. Without a target it presses on the active page.                              |
| `select`                             | Required `target` and 1–20 existing option `values`, each up to 500 characters.                                                     |
| `scroll`                             | Integer `deltaX` and `deltaY`, each `-10000…10000` and not both zero; optional target scrolls that element, otherwise the viewport. |
| `wait`                               | Required closed `condition` and optional `timeoutMs`; this is read-only, never a fixed sleep.                                       |
| `set_viewport`                       | Required integer `width` and `height` within the viewport bounds.                                                                   |
| `open_tab`                           | Optional validated HTTP(S) `url`; creates and activates a tab.                                                                      |
| `switch_tab`, `close_tab`            | Required existing opaque `tabId`, at most 128 characters.                                                                           |

A wait condition is one of: URL `value` with `contains` (default) or `exact` matching; visible text `value` with optional `exact`; a shared `target` with `attached`, `visible`, `hidden`, or `detached` state; or load state `domcontentloaded` or `load`. Regexes, globs, `networkidle`, and sleep are not supported. Wait timeout is an integer `100–120000` ms and defaults to 10 seconds.

Element actions use a fixed 10-second deadline; launch and navigation use 30 seconds. Navigation, history, reload, tab-context outcomes, and active-tab recovery include a short fresh snapshot. Ordinary interaction results instead contain a compact action, sanitized target kind, active tab, sanitized URL/title, and outcome, and tell the agent when to observe. Browser never exposes arbitrary JavaScript, raw Playwright options, CDP, or forced actions.

Browser has no credential vault, credential storage, or dedicated credential-acquisition behaviour. Generic `fill` and `type` may target password fields when the model already has a value. Browser suppresses supplied fill/type values from Browser-owned output, but cannot redact them from the Pi transcript or model-provider path.

Page ownership is synchronous. A popup opened while a dispatched action is running becomes active when that action settles and the result reports the new tab. A page opened outside an action is listed but does not steal focus. If the active page closes itself, Browser selects the most recently active live tab; when none remains it creates a fresh blank tab. Closing the final tab therefore leaves one usable blank page; closing a non-active tab does not invalidate the active tab. Tab IDs are monotonic and never reused within a context.

## Limits and output bounds

| Boundary                           | Contract                                                                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Default/caller viewport            | `1440×900` at device scale factor 1; width `320–2560`, height `240–1600` CSS pixels.                                                                   |
| Launch/navigation/element deadline | 30 seconds / 30 seconds at `domcontentloaded` / 10 seconds; never `networkidle`.                                                                       |
| Wait                               | Default 10 seconds; integer `100–120000` milliseconds.                                                                                                 |
| Fill/type/key/select/scroll        | 20,000 characters / 20,000 characters / 100 characters / 1–20 values of at most 500 characters / integer deltas `-10000…10000`, at least one non-zero. |
| URL/target/name/tab ID             | 2,000 / 1,000 / 500 / 128 characters; URL has no credentials or control characters.                                                                    |
| Snapshot                           | Depth `1–20`, default `10`; 16,000 characters and 600 lines.                                                                                           |
| Rendered text/element HTML         | 16,000 characters and 600 lines / 12,000 characters; page-controlled element values and style values are each capped at 1,000 characters.              |
| Requested styles                   | 1–32 unique property names, each at most 128 characters.                                                                                               |
| Diagnostics                        | Retain newest 100; return newest 50 within 16,000 characters; each message is at most 1,000 and URL at most 2,000 characters.                          |
| Screenshot                         | PNG only: at most 10 MiB encoded, 4,096 CSS-pixel width, and 12,000 CSS-pixel height.                                                                  |
| Tabs                               | At most 20 live tabs.                                                                                                                                  |

When text has both a character and line limit, Browser stops at the first limit, appends `…`, and reports original/returned character and line counts. It never splits a UTF-16 surrogate pair or an AI snapshot ref token. Oversized screenshots fail as `content`; Browser neither writes, truncates, nor rescales them.

## Recovery and safety

Every failure uses a stable category with bounded cause/recovery metadata. A recreated context visibly reports that its prior tabs, refs, and diagnostics were lost; an active-tab fallback is reported by the result or error that observes it.

| Category               | Meaning and state effect                                                                                                               | Recovery                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `installation`         | The managed Chromium executable is unavailable; no page state exists.                                                                  | Repair Pipkin's normal `npm install` or `npm rebuild`; do not install a global CLI or retry a download at tool time. |
| `launch`               | Chromium could not start; no usable context is retained.                                                                               | Repair platform dependencies or host sandbox constraints, then observe again.                                        |
| `cancelled`            | Cancellation happened before dispatch, or during an observation/read-only wait. The active generation is closed when needed.           | Repeat an observation or wait only after checking the current page.                                                  |
| `target`               | A URL, tab, or semantic target was invalid, missing, or ambiguous before dispatch; state is unchanged.                                 | Correct the input or observe to identify a unique target.                                                            |
| `stale_ref`            | A ref did not belong to the latest snapshot/current document or no longer resolves; state is unchanged.                                | Observe again and use a currently emitted ref.                                                                       |
| `timeout`              | A read-only operation exceeded its deadline; the page may still change.                                                                | Observe before deciding whether to wait again.                                                                       |
| `page_gone`            | No mutation was in flight and the active page closed or changed. Browser selects the newest active remaining tab or opens a blank tab. | Inspect tabs or observe the selected fallback.                                                                       |
| `uncertain_outcome`    | A state-changing action failed, timed out, or was cancelled after dispatch. Its outcome is unknown.                                    | Never replay automatically; observe before choosing a new action.                                                    |
| `browser_disconnected` | No mutation was in flight when Chromium disconnected. Handles, refs, tabs, and diagnostics are invalidated.                            | Observe again to start one fresh isolated context; its first result/error discloses state loss.                      |
| `content`              | A snapshot, text, HTML, diagnostic, or image output violated a fixed bound.                                                            | Narrow the scope or choose a viewport/element screenshot.                                                            |
| `backend`              | An unexpected bounded browser failure occurred.                                                                                        | Observe current tabs/page and retry only if the operation was read-only and state is understood.                     |

Browser records a dispatch boundary immediately before each Playwright call. Pre-dispatch invalid input, target, and stale-ref failures take precedence; then dispatched state-changing actions become `uncertain_outcome`; then cancellation, timeout, page loss/disconnect, and backend failures apply. Only an observation retries once, and only after the owner proved that its generation disconnected; no `browser_act` action is replayed. `wait` is read-only, so its cancellation/timeout remain `cancelled`/`timeout` and its page loss/disconnect remains `page_gone`/`browser_disconnected`.

Top-level navigation accepts only credential-free `http:` and `https:`, including loopback and private development hosts; it rejects `file:`, `data:`, JavaScript, browser-internal, extension, and credential URLs. This is **not** an SSRF boundary: redirects, subresources, and loaded pages retain ordinary Chromium network authority and may initiate requests to public or private services. Rendered text, diagnostics, and images are untrusted external evidence. Browser is extension-owned process/network activity, outside Sandbox and Readonly mediation; Chromium's sandbox is not a Pipkin trust boundary.
