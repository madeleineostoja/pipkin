# Web Fetch

Web Fetch retrieves bounded content from one public HTTP(S) URL. Fetched pages and source metadata are untrusted external data, never instructions.

## Retrieve a page

`web_fetch` is deferred in the `web` namespace and callable through native codemode. It returns readable content directly, or named structured fields to a script.

```json
{ "url": "https://example.com/article", "maxChars": 12000 }
```

Use [Browser](browser.md) when JavaScript rendering, interaction, visual evidence, localhost, or isolated browser state matters. Web Fetch remains the direct public, credential-free path and does not share Browser state. Use user-configured native documentation MCP for known-library documentation, `npm search --json` for package discovery, and `gh` with existing authentication for GitHub workflows; see [native research setup](../configuration.md#native-research-setup). No tool automatically falls back to another.

## Request options

The closed input accepts only these fields; there is no batch operation or public extractor tuning. HTML extraction internally removes images and uses extractor-supported replies.

| Field       | Default | Valid values                                           | Purpose                                                                          |
| ----------- | ------: | ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `url`       |       — | Public credential-free HTTP(S) URL, 1–2,000 characters | Target to retrieve                                                               |
| `raw`       | `false` | Boolean                                                | Save untouched textual response as a temporary artifact instead of extracting it |
| `maxChars`  | `40000` | Integer `1–40000`                                      | Maximum returned text or raw preview characters; byte/line bounds also apply     |
| `timeoutMs` | `15000` | Integer `1000–120000`                                  | Request deadline in milliseconds                                                 |

## Results

Successful structured results contain `ok:true`, `url`, `finalUrl`, HTTP `status`, `contentType`, a named `format`, and explicit `truncated`. Optional extracted `source` metadata names bounded `title`, `site`, and `published` fields. Metadata is not verification of the page's claims.

| Content                         | `format`   | Result                                                   |
| ------------------------------- | ---------- | -------------------------------------------------------- |
| Valid JSON                      | `json`     | Pretty-printed `text`                                    |
| HTML                            | `markdown` | Readable `text`                                          |
| Other text                      | `text`     | Plain `text`                                             |
| Attachment or non-text response | `artifact` | Temporary artifact descriptor, no binary bytes           |
| Text with `raw:true`            | `artifact` | Temporary artifact descriptor and bounded `text` preview |

Detection does not depend on an accurate server content type. JSON text preserves decoded values and escapes unsafe controls; it is parseable when `truncated:false`. Raw mode preserves textual bytes in the file, without extraction; previews are control-safe. Attachments and binary responses remain binary artifacts even with `raw:true`.

Artifacts expose `{path,mediaType,bytes,lifetime:"temporary",kind:"raw-text"|"binary"}`. They are not durable Context references. Direct content includes the same selected text or temporary artifact facts, with compact response/source metadata; collapsed rows summarize the format, media type, returned character count, and truncation.

Codemode can select fields without parsing prose:

```js
const page = await tools.web_fetch({ url: "https://example.com/article" });
if (page.ok)
  text({ format: page.format, text: page.text, truncated: page.truncated });
else text(page.error);
```

Failures return `ok:false,error:{code,message}` and native `isError:true`. A schema-bearing failed call resolves as structured error data in codemode, so check `ok` rather than assuming `await` throws. Invalid inputs rejected by the host can still be native errors before dispatch.

| Error code  | Meaning                                                                          |
| ----------- | -------------------------------------------------------------------------------- |
| `target`    | Invalid or non-public target, including non-public DNS answers                   |
| `dns`       | Public-target resolution failed                                                  |
| `network`   | Transport or response stream failed                                              |
| `redirect`  | Redirect target or redirect limit failure                                        |
| `oversize`  | Response, artifact, or extractor request exceeds its bound                       |
| `http`      | Non-2xx response                                                                 |
| `content`   | Invalid request (including credentialed URL construction) or unsupported content |
| `extract`   | No readable content, possibly JavaScript-required                                |
| `artifact`  | Temporary artifact creation, storage, or owner availability failure              |
| `timeout`   | Request deadline expired                                                         |
| `cancelled` | Caller or session shutdown cancelled the operation                               |

## Limits

| Boundary                                            |                  Limit |
| --------------------------------------------------- | ---------------------: |
| Text response before parsing / raw textual artifact |                  5 MiB |
| Binary artifact                                     |                 25 MiB |
| Extractor POST body                                 |                  1 MiB |
| HTTP redirects                                      |                      5 |
| Immediate meta-refresh redirects                    |                      5 |
| Returned content                                    | 48 KiB and 1,900 lines |

Truncation is explicit in both direct content and structured data. Returned structured text is the same bounded selection shown directly, not an unbounded second copy.

## Network and security boundaries

Web Fetch uses a fixed browser-grade Chrome/Windows transport. It validates the initial URL and every HTTP redirect, immediate meta refresh, and extractor request. URL credentials, localhost names, private addresses, and DNS results containing any non-public answer are rejected.

The host resolver performs validation, but the browser transport resolves again when connecting. This reduces SSRF risk but is not address pinning and leaves a DNS-rebinding window.

Web Fetch does not support:

- JavaScript execution or crawling;
- ordinary linked-asset retrieval;
- authentication, cookies, or caller headers;
- proxies or private-network exceptions;
- caching or caller-controlled browser settings;
- caller-controlled temporary paths or concurrency.

Web Fetch is trusted extension-owned network and temporary-filesystem egress. Sandbox and Readonly do not mediate its requests or artifact writes. It does not protect secrets from providers or remote services.

## Artifact lifetime

Artifacts live in a private, unpredictable session-temporary directory and are deleted at session shutdown. Unsafe remote filename suggestions, including C0/C1 controls, are rejected before file creation; a safe URL filename or generated name is used instead. A direct `read` can inspect a returned canonical path during the live session. Copy the file elsewhere before shutdown if it must persist; binary bytes never enter tool output.

## Extractor diagnostics

Defuddle sometimes logs caught failures directly to the process console. Web Fetch captures `debug`, `info`, `log`, `warn`, `error`, and `trace` calls in the asynchronous extraction scope, preventing those diagnostics from writing over Pi's terminal UI. Unrelated concurrent console output passes through unchanged; this is not global console suppression.

The capture utility bounds each operation to 16 entries of 1,000 UTF-16 code units, marks clipped entries, and counts omitted entries. Captured text is private, temporary diagnostic data and is discarded by extraction rather than copied into tool results, metadata, or a log file. Return values and exceptions remain unchanged by capture; Web Fetch retains its existing readable-content fallback and typed failure handling, including rejected extractor requests.

Console methods are restored when the last overlapping capture settles, including rejection and cancellation unwind. Direct stdout/stderr writes and unawaited background work are outside this boundary. This containment does not repair extraction bugs or provide general Pi-wide terminal protection.

If `pi-smart-fetch` is separately installed, remove it before reloading Pipkin so its registration does not collide with `web_fetch`.
