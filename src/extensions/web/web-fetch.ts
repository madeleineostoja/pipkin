import {
  truncateHead,
  type AgentToolUpdateCallback,
} from "@earendil-works/pi-coding-agent";
import { ArtifactStore, ARTIFACT_LIMITS, type Artifact } from "./artifacts.js";
import { assertActive, cleanupReader, type Deadline } from "./cancellation.js";
import { LIMITS } from "./constants.js";
import { abortReason, WebError } from "./errors.js";
import {
  extractHtml,
  inspectHtml,
  isHtml,
  renderJson,
  type ExtractedPage,
} from "./extraction.js";
import { normalizeInput, type WebFetchInput } from "./schema.js";
import {
  createInvocationDeadline,
  createWebTransport,
  type WebTransport,
} from "./transport.js";
import {
  controlSafeText,
  webFetchFailure,
  type WebFetchData,
  type WebFetchResult,
} from "./result.js";

export type WebFetchDependencies = {
  transport?: WebTransport;
  extractHtml?: typeof extractHtml;
  artifacts?: ArtifactStore;
};

export async function executeWebFetch(
  input: WebFetchInput,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback,
  dependencies: WebFetchDependencies = {},
): Promise<WebFetchResult> {
  let deadline: Deadline | undefined;
  try {
    const request = normalizeInput(input);
    deadline = createInvocationDeadline(request.timeoutMs);
    const transport = dependencies.transport ?? createWebTransport();
    const extract = dependencies.extractHtml ?? extractHtml;
    const artifacts = dependencies.artifacts ?? new ArtifactStore();
    onUpdate?.({
      content: [{ type: "text", text: "Resolving public target…" }],
      details: { phase: "resolving" },
    });
    let response = await fetchResponse(
      transport,
      request.url,
      signal,
      deadline,
    );
    let metaRefreshes = 0;
    while (true) {
      assertActive(deadline, signal);
      const contentType = mediaType(response.headers.get("content-type"));
      if (response.status < 200 || response.status > 299) {
        await response.body?.cancel().catch(() => {});
        throw new WebError(
          "http",
          `Web Fetch received HTTP ${response.status} from the public target.`,
        );
      }
      if (
        isAttachment(response.headers.get("content-disposition")) ||
        !isArtifactTextual(contentType)
      ) {
        const artifact = await artifacts.write(response, {
          kind: "binary",
          maximumBytes: ARTIFACT_LIMITS.binaryBytes,
          signal,
          deadline,
        });
        return artifactResult({
          requestedUrl: request.url,
          response,
          artifact,
          profile: transport.profile,
          semanticTruncated: false,
        });
      }
      if (request.raw) {
        const artifact = await artifacts.write(response, {
          kind: "raw-text",
          maximumBytes: ARTIFACT_LIMITS.rawBytes,
          maximumPreviewChars: request.maxChars,
          signal,
          deadline,
        });
        return artifactResult({
          requestedUrl: request.url,
          response,
          artifact,
          profile: transport.profile,
          semanticTruncated: artifact.previewTruncated ?? false,
        });
      }
      const source = await readText(response, signal, deadline);
      assertActive(deadline, signal);
      const json = renderJson(source);
      if (json !== undefined) {
        const content = truncateCharacters(json, request.maxChars);
        return result({
          requestedUrl: request.url,
          response,
          contentType,
          body: content.value,
          output: "json",
          profile: transport.profile,
          semanticTruncated: content.truncated,
        });
      }
      if (isHtml(contentType) || looksLikeHtml(source)) {
        const inspection = inspectHtml(source, response.url, {
          deadline,
          parentSignal: signal,
        });
        if (inspection.meta) {
          if (metaRefreshes >= LIMITS.metaRefreshes) {
            throw new WebError(
              "redirect",
              "Web Fetch stopped after five immediate meta refreshes.",
            );
          }
          metaRefreshes++;
          onUpdate?.({
            content: [
              { type: "text", text: "Following immediate page redirect…" },
            ],
            details: { phase: "meta-refresh" },
          });
          response = await fetchResponse(
            transport,
            inspection.meta,
            signal,
            deadline,
          );
          continue;
        }
        onUpdate?.({
          content: [{ type: "text", text: "Extracting readable content…" }],
          details: { phase: "extracting" },
        });
        const page: ExtractedPage = await extract(source, response.url, {
          transport,
          parentSignal: signal,
          deadline,
        });
        assertActive(deadline, signal);
        const content = truncateCharacters(page.content, request.maxChars);
        return result({
          requestedUrl: request.url,
          response,
          contentType,
          body: content.value,
          output: "markdown",
          profile: transport.profile,
          page,
          semanticTruncated: content.truncated,
        });
      }
      const content = truncateCharacters(source, request.maxChars);
      return result({
        requestedUrl: request.url,
        response,
        contentType,
        body: content.value,
        output: "text",
        profile: transport.profile,
        semanticTruncated: content.truncated,
      });
    }
  } catch (error) {
    return webFetchFailure(error, signal);
  } finally {
    deadline?.dispose();
  }
}

function result(options: {
  requestedUrl: string;
  response: Response;
  contentType: string;
  body: string;
  output: "markdown" | "json" | "text";
  profile: WebTransport["profile"];
  page?: ExtractedPage;
  semanticTruncated: boolean;
  artifact?: Artifact;
}): WebFetchResult {
  const requestedUrl = metadataText(options.requestedUrl, LIMITS.urlChars);
  const finalUrl = metadataText(options.response.url, LIMITS.urlChars);
  const title = options.page?.title
    ? metadataText(options.page.title)
    : undefined;
  const site = options.page?.site ? metadataText(options.page.site) : undefined;
  const published = options.page?.published
    ? metadataText(options.page.published)
    : undefined;
  const contentType = metadataText(options.contentType);
  const source = {
    ...(title ? { title } : {}),
    ...(site ? { site } : {}),
    ...(published ? { published } : {}),
  };
  const finish = (
    text: string,
    directText: string,
    finalTruncated: boolean,
  ): WebFetchResult => {
    const truncated = options.semanticTruncated || finalTruncated;
    const common = {
      ok: true as const,
      url: requestedUrl,
      finalUrl,
      status: options.response.status,
      contentType,
      ...(Object.keys(source).length ? { source } : {}),
      truncated,
    };
    const structuredContent: WebFetchData = options.artifact
      ? {
          ...common,
          format: "artifact",
          artifact: {
            path: options.artifact.path,
            mediaType: contentType,
            bytes: options.artifact.bytes,
            lifetime: "temporary",
            kind: options.artifact.kind,
          },
          ...(options.artifact.kind === "raw-text" ? { text } : {}),
        }
      : {
          ...common,
          format: options.output,
          text,
        };
    return {
      content: [{ type: "text", text: directText }],
      details: {
        output: options.artifact ? "artifact" : options.output,
        contentType,
        contentChars: Array.from(text).length,
        truncated,
      },
      structuredContent,
      isError: false,
    };
  };
  const header = [
    `Requested URL: ${requestedUrl}`,
    ...(options.response.url !== options.requestedUrl
      ? [`Final URL: ${finalUrl}`]
      : []),
    `HTTP: ${options.response.status} · ${contentType}`,
    `Output: ${options.artifact ? "artifact" : options.output}`,
    ...(title ? [`Title: ${title}`] : []),
    ...(site ? [`Site: ${site}`] : []),
    ...(published ? [`Published: ${published}`] : []),
    `Browser: ${options.profile.browser} / ${options.profile.os}`,
    ...(options.artifact
      ? [
          `Temporary artifact: ${options.artifact.path} (${options.artifact.bytes} bytes, ${contentType}, ${options.artifact.kind}; deleted at session shutdown)`,
        ]
      : []),
    ...(options.semanticTruncated
      ? [
          `[Content truncated to requested maxChars (${LIMITS.maxChars} maximum).]`,
        ]
      : []),
  ];
  const prefix = `${header.join("\n")}\n\n`;
  // JSON is already control-escaped; filtering or wrapping would change its values.
  const safeBody =
    options.output === "json" ? options.body : controlSafeText(options.body);
  const body =
    options.output === "json" || options.artifact?.kind === "raw-text"
      ? safeBody
      : softWrap(safeBody);
  const initial = `${prefix}${body}`;
  const trial = truncateHead(initial, {
    maxBytes: LIMITS.resultBytes,
    maxLines: LIMITS.resultLines,
  });
  if (!trial.truncated) {
    return finish(body, trial.content, false);
  }
  const notice = "[Final output truncated to 48 KiB or 1,900 lines.]";
  const truncatedPrefix = `${header.join("\n")}\n${notice}\n\n`;
  const truncatedBody = truncateHead(body, {
    maxBytes: LIMITS.resultBytes - Buffer.byteLength(truncatedPrefix),
    maxLines: LIMITS.resultLines - truncatedPrefix.split("\n").length,
  });
  return finish(
    truncatedBody.content,
    `${truncatedPrefix}${truncatedBody.content}`,
    true,
  );
}

function artifactResult(options: {
  requestedUrl: string;
  response: Response;
  artifact: Artifact;
  profile: WebTransport["profile"];
  semanticTruncated: boolean;
}): WebFetchResult {
  return result({
    requestedUrl: options.requestedUrl,
    response: options.response,
    contentType: options.artifact.contentType,
    body: options.artifact.preview ?? "",
    output: "text",
    profile: options.profile,
    semanticTruncated: options.semanticTruncated,
    artifact: options.artifact,
  });
}

async function fetchResponse(
  transport: WebTransport,
  url: string,
  signal: AbortSignal | undefined,
  deadline: ReturnType<typeof createInvocationDeadline>,
): Promise<Response> {
  return transport.fetchArtifact
    ? transport.fetchArtifact(url, signal, deadline)
    : transport.fetch(url, undefined, signal, deadline);
}

function mediaType(value: string | null): string {
  const type = value?.slice(0, LIMITS.metadataChars).split(";", 1)[0]?.trim();
  return type?.toLowerCase() || "unknown";
}

function isAttachment(value: string | null): boolean {
  return /\battachment\b/iu.test(value?.slice(0, LIMITS.metadataChars) ?? "");
}

function looksLikeHtml(value: string): boolean {
  return /^\s*(?:<!doctype\s+html|<html|<head|<body|<main|<article|<section|<div|<p|<h[1-6])(?:\s|>)/iu.test(
    value,
  );
}

function isArtifactTextual(contentType: string): boolean {
  return (
    contentType.startsWith("text/") ||
    /^(?:application|image)\/(?:[^/;]+\+)?(?:json|xml)$/iu.test(contentType) ||
    /^application\/(?:javascript|ecmascript|graphql|sql)$/iu.test(contentType)
  );
}

async function readText(
  response: Response,
  signal: AbortSignal | undefined,
  deadline: ReturnType<typeof createInvocationDeadline>,
): Promise<string> {
  const length = response.headers.get("content-length");
  if (
    length &&
    /^\d+$/u.test(length) &&
    Number(length) > LIMITS.responseBytes
  ) {
    await response.body?.cancel().catch(() => {});
    throw new WebError(
      "oversize",
      "Web Fetch response exceeds its 5 MiB text limit.",
    );
  }
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const cleanup = cleanupReader(reader);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancel = () => {
    void cleanup.cancel(signal?.reason ?? deadline.signal.reason);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  deadline.signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      assertActive(deadline, signal);
      const next = await reader.read();
      assertActive(deadline, signal);
      if (next.done) {
        break;
      }
      bytes += next.value.byteLength;
      if (bytes > LIMITS.responseBytes) {
        throw new WebError(
          "oversize",
          "Web Fetch response exceeds its 5 MiB text limit.",
        );
      }
      chunks.push(next.value);
    }
  } catch (error) {
    await cleanup.cancel();
    if (signal?.aborted) {
      throw abortReason(signal);
    }
    if (deadline.signal.aborted) {
      throw abortReason(deadline.signal);
    }
    if (error instanceof WebError) {
      throw error;
    }
    throw new WebError("network", "Web Fetch response stream failed.");
  } finally {
    signal?.removeEventListener("abort", cancel);
    deadline.signal.removeEventListener("abort", cancel);
    cleanup.release();
  }
  const output = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
}

function metadataText(
  value: string,
  maximum: number = LIMITS.metadataChars,
): string {
  const compact = controlSafeText(value).replace(/\s+/gu, " ").trim();
  const characters = Array.from(compact);
  return characters.length > maximum
    ? `${characters.slice(0, maximum - 1).join("")}…`
    : compact;
}

function truncateCharacters(
  value: string,
  maximum: number,
): {
  value: string;
  truncated: boolean;
} {
  const characters = Array.from(value);
  return characters.length > maximum
    ? { value: characters.slice(0, maximum).join(""), truncated: true }
    : { value, truncated: false };
}

function softWrap(value: string): string {
  return value
    .split("\n")
    .map((line) => {
      const characters = Array.from(line);
      const chunks: string[] = [];
      while (characters.length > 0) {
        chunks.push(characters.splice(0, 8_000).join(""));
      }
      return chunks.join("\n");
    })
    .join("\n");
}
