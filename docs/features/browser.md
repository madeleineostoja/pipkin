# Browser

Browser is Pipkin's stateful rendered-interface tool. It owns one isolated, non-persistent headless Chromium context per Pi session for local and HTTP(S) applications. It is deliberately separate from [Web Fetch](web-fetch.md), which is stateless, credential-free, and limited to public-address retrieval.

## Installation and session lifecycle

Pipkin declares `playwright-core` and `@playwright/browser-chromium` as runtime dependencies. A normal `npm install` runs the browser package's standard lifecycle, placing matching Chromium, headless-shell, and FFmpeg revisions in Playwright's shared OS cache. Browser never downloads or updates these artifacts while a tool runs.

If the expected executable is missing (for example, lifecycle scripts were skipped or the cache was removed), the first call fails as `installation`, names the installed Playwright version, and tells the operator to repair the normal Pipkin install with `npm install` or `npm rebuild`. Do not install a global Playwright CLI.

Extension loading and `session_start` do not launch Chromium. The first call to either Browser tool coalesces startup into one headless browser, one ephemeral context, and one blank `1440×900` page. Calls are serialized; queued cancellation never starts a browser operation, and executing cancellation or shutdown closes/invalidate the active runtime before another call can use it. `session_start` defensively resets stale state and `session_shutdown` is idempotent.

A disconnect, reset, or context recreation loses all tabs, refs, and diagnostics. Results identify fresh-context state loss. Browser uses no existing profile, persistent storage directory, downloads, uploads, proxy, permission, executable, or filesystem-path option.

## Workflow and targets

Use `browser_observe` to understand rendered state, particularly `snapshot`, then use `browser_act` to navigate or manage tabs, and observe again after a document or tab change. Snapshot refs belong only to the current document; rerendering, navigation, switching tabs, or recreating the context can make them stale.

A target is a closed object with these fields:

| Field   | Contract                                                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`  | Required: `ref`, `role`, `text`, `label`, `placeholder`, `test_id`, or `css`.                                                               |
| `value` | Required non-empty, control-character-free string, at most 1,000 characters. Its spelling is preserved; whitespace is not silently trimmed. |
| `name`  | Optional accessible name, only for `role`, at most 500 characters.                                                                          |
| `exact` | Optional boolean for `role`, `text`, `label`, and `placeholder` only; defaults to `false`.                                                  |

`ref` maps to Playwright's `aria-ref=<ref>` selector; the other semantic kinds map to their corresponding Playwright `getBy…` locator, and `css` is an explicit fallback. Resolution is strict: it must match exactly one element. Stale refs and ambiguous targets are not healed; observe again instead.

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

The initial action surface is navigation and page control only:

| Action                      | Fields and behaviour                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------- |
| `navigate`                  | Required credential-free HTTP(S) `url`; replaces the active tab at `domcontentloaded`. |
| `back`, `forward`, `reload` | No additional fields; use history/reload and wait for `domcontentloaded`.              |
| `set_viewport`              | Required integer `width` and `height` within the viewport bounds.                      |
| `open_tab`                  | Optional validated HTTP(S) `url`; creates and activates a tab.                         |
| `switch_tab`, `close_tab`   | Required existing opaque `tabId`, at most 128 characters.                              |

Navigation, history, reload, and tab-context outcomes include a short fresh snapshot. Action results report action, active tab, sanitized URL/title, and a compact outcome. Browser never exposes arbitrary JavaScript, raw Playwright options, CDP, or target-mutating actions in this slice.

Page ownership is synchronous. A popup opened while a dispatched action is running becomes active when that action settles and the result reports the new tab. A page opened outside an action is listed but does not steal focus. If the active page closes itself, Browser selects the most recently active live tab; when none remains it creates a fresh blank tab. Closing the final tab therefore leaves one usable blank page; closing a non-active tab does not invalidate the active tab. Tab IDs are monotonic and never reused within a context.

## Limits and output bounds

| Boundary                   | Contract                                                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Default/caller viewport    | `1440×900` at device scale factor 1; width `320–2560`, height `240–1600` CSS pixels.                                                      |
| Launch/navigation deadline | 30 seconds; navigation waits for `domcontentloaded`, never `networkidle`.                                                                 |
| URL/target/name/tab ID     | 2,000 / 1,000 / 500 / 128 characters; URL has no credentials or control characters.                                                       |
| Snapshot                   | Depth `1–20`, default `10`; 16,000 characters and 600 lines.                                                                              |
| Rendered text/element HTML | 16,000 characters and 600 lines / 12,000 characters; page-controlled element values and style values are each capped at 1,000 characters. |
| Requested styles           | 1–32 unique property names, each at most 128 characters.                                                                                  |
| Diagnostics                | Retain newest 100; return newest 50 within 16,000 characters; each message is at most 1,000 and URL at most 2,000 characters.             |
| Screenshot                 | PNG only: at most 10 MiB encoded, 4,096 CSS-pixel width, and 12,000 CSS-pixel height.                                                     |
| Tabs                       | At most 20 live tabs.                                                                                                                     |

When text has both a character and line limit, Browser stops at the first limit, appends `…`, and reports original/returned character and line counts. It never splits a UTF-16 surrogate pair or an AI snapshot ref token. Oversized screenshots fail as `content`; Browser neither writes, truncates, nor rescales them.

## Recovery and safety

Browser failures use `installation`, `launch`, `cancelled`, `target`, `stale_ref`, `timeout`, `page_gone`, `uncertain_outcome`, `browser_disconnected`, `content`, or `backend`. Before dispatch, invalid targets/URLs and stale refs win; then a dispatched state-changing action failure is `uncertain_outcome`; then cancellation, timeout, page loss/disconnect, and backend failures follow. Errors retain only a bounded underlying reason.

An observation may retry once after a proven pre-dispatch/disconnected fresh-context failure. An action is never replayed: cancellation, timeout, page closure, or disconnect after it dispatched is `uncertain_outcome`, so observe before deciding what to do next. Read-only observation cancellation is `cancelled`; a read-only timeout is `timeout`; a closed page or disconnected browser without a mutation is `page_gone` or `browser_disconnected`.

Top-level navigation accepts only credential-free `http:` and `https:`, including loopback and private development hosts; it rejects `file:`, `data:`, JavaScript, browser-internal, extension, and credential URLs. This is **not** an SSRF boundary: redirects, subresources, and loaded pages retain ordinary Chromium network authority and may initiate requests to public or private services. Rendered text, diagnostics, and images are untrusted external evidence. Browser is extension-owned process/network activity, outside Sandbox and Readonly mediation; Chromium's sandbox is not a Pipkin trust boundary.
