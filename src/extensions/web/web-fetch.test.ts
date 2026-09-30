import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "./artifacts.js";
import { extractHtml } from "./extraction.js";
import { normalizeInput } from "./schema.js";
import {
  createInvocationDeadline,
  createWebTransport,
  type WebTransport,
} from "./transport.js";
import Ajv from "ajv";
import { WebFetchOutput } from "./result.js";
import { DeadlineError } from "./errors.js";
import { executeWebFetch as fetchResult } from "./web-fetch.js";
import { renderWebFetchResult } from "./result-renderer.js";

const validate = new Ajv().compile(WebFetchOutput);
async function executeWebFetch(...args: Parameters<typeof fetchResult>) {
  const result = await fetchResult(...args);
  expect(
    validate(result.structuredContent),
    JSON.stringify(validate.errors),
  ).toBe(true);
  expect(result.isError).toBe(!result.structuredContent.ok);
  return result;
}

function artifactOf(result: Awaited<ReturnType<typeof fetchResult>>) {
  const data = result.structuredContent;
  if (!data.ok || data.format !== "artifact") {
    throw new Error("Expected a successful artifact result");
  }
  return data.artifact;
}

function page(url: string, contentType: string, body: string): Response {
  const response = new Response(body, {
    status: 200,
    headers: { "content-type": contentType },
  });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

describe("web_fetch", () => {
  it("renders a semantic target summary and complete expanded content", () => {
    const result = {
      content: [{ type: "text" as const, text: "complete fetched body" }],
      details: {
        requestedUrl: "https://example.com/article",
        finalUrl: "https://example.com/article",
        output: "markdown",
        contentType: "text/html",
        contentChars: 21,
      },
    };
    const theme = { fg: (_color: string, text: string) => text } as never;

    const collapsed = renderWebFetchResult(
      result,
      { expanded: false, isPartial: false },
      theme,
      {},
    )
      .render(200)
      .map((line) => line.trimEnd())
      .join("\n");
    const expanded = renderWebFetchResult(
      result,
      { expanded: true, isPartial: false },
      theme,
      {},
    )
      .render(200)
      .map((line) => line.trimEnd())
      .join("\n");

    expect(collapsed).toBe("markdown · text/html · 21 characters");
    expect(collapsed).not.toContain("complete fetched body");
    expect(expanded).toContain("complete fetched body");
  });
  it("accepts only automatic output with an optional raw override", () => {
    expect(normalizeInput({ url: "https://example.com" })).toMatchObject({
      raw: false,
    });
    expect(
      normalizeInput({ url: "https://example.com", raw: true }),
    ).toMatchObject({ raw: true });
    expect(() =>
      normalizeInput({
        url: "https://example.com",
        format: "json",
      } as never),
    ).toThrow("invalid schema");
  });

  it("returns bounded typed target failures without reflecting credentials or contacting the target", async () => {
    const send = vi.fn();
    const transport = createWebTransport({
      browserFetch: send,
      profiles: ["chrome_147"],
    });
    for (const [url, code] of [
      ["http://127.0.0.1", "target"],
      ["https://user:secret@example.com", "content"],
      ["http://localhost", "target"],
    ]) {
      const result = await executeWebFetch({ url }, undefined, undefined, {
        transport,
      });
      expect(result.structuredContent).toMatchObject({
        ok: false,
        error: { code },
      });
      expect(JSON.stringify(result)).not.toContain("secret");
    }
    const invalid = await executeWebFetch({
      url: "https://example.com",
      removeImages: false,
    } as never);
    expect(invalid.structuredContent).toMatchObject({
      ok: false,
      error: { code: "content" },
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("returns typed network, timeout, HTTP and oversize failures", async () => {
    const send = vi
      .fn()
      .mockRejectedValue(new Error("sensitive transport detail"));
    const network = await executeWebFetch(
      { url: "https://8.8.8.8" },
      undefined,
      undefined,
      {
        transport: createWebTransport({
          browserFetch: send,
          profiles: ["chrome_147"],
        }),
      },
    );
    expect(network.structuredContent).toMatchObject({
      ok: false,
      error: { code: "network" },
    });
    expect(JSON.stringify(network)).not.toContain("sensitive transport detail");
    const transport: WebTransport = {
      profile: { browser: "chrome_147", os: "windows" },
      fetch: async () => {
        throw new DeadlineError();
      },
    };
    const timeout = await executeWebFetch(
      { url: "https://example.com" },
      undefined,
      undefined,
      { transport },
    );
    expect(timeout.structuredContent).toMatchObject({
      ok: false,
      error: { code: "timeout" },
    });
    transport.fetch = async () => new Response("unavailable", { status: 503 });
    const http = await executeWebFetch(
      { url: "https://example.com" },
      undefined,
      undefined,
      { transport },
    );
    expect(http.structuredContent).toMatchObject({
      ok: false,
      error: { code: "http" },
    });
    transport.fetch = async () => {
      const response = page("https://example.com", "text/plain", "body");
      response.headers.set("content-length", String(5 * 1024 * 1024 + 1));
      return response;
    };
    const oversize = await executeWebFetch(
      { url: "https://example.com" },
      undefined,
      undefined,
      { transport },
    );
    expect(oversize.structuredContent).toMatchObject({
      ok: false,
      error: { code: "oversize" },
    });
  });

  it("automatically renders JSON without extraction and keeps body out of details", async () => {
    const transport: WebTransport = {
      profile: { browser: "chrome_147", os: "windows" },
      fetch: async () =>
        page("https://example.com/data", "application/json", '{"answer":42}'),
    };

    const result = await executeWebFetch(
      { url: "https://example.com/data" },
      undefined,
      undefined,
      { transport },
    );

    expect(result.content[0]?.text).toContain('{\n  "answer": 42\n}');
    expect(result.structuredContent).toEqual({
      ok: true,
      url: "https://example.com/data",
      finalUrl: "https://example.com/data",
      status: 200,
      contentType: "application/json",
      format: "json",
      text: '{\n  "answer": 42\n}',
      truncated: false,
    });
    expect(result.details).toMatchObject({ output: "json" });
    expect(result.content[0]?.text).toMatch(
      /^Requested URL: https:\/\/example\.com\/data/,
    );
    expect(JSON.stringify(result.details)).not.toContain("answer");
  });

  it("preserves long JSON strings and decoded control characters in both selections", async () => {
    const value = {
      long: "x".repeat(9_001),
      controls: "a\u0000\u001b\t\n\r\u007f\u0085\u009bb",
    };
    const result = await executeWebFetch(
      { url: "https://example.com/data" },
      undefined,
      undefined,
      {
        transport: {
          profile: { browser: "chrome_147", os: "windows" },
          fetch: async () =>
            page(
              "https://example.com/data",
              "application/json",
              JSON.stringify(value),
            ),
        },
      },
    );
    const data = result.structuredContent;
    expect(data).toMatchObject({ ok: true, format: "json", truncated: false });
    if (!data.ok || data.format !== "json") {
      throw new Error("Expected JSON result");
    }
    expect(JSON.parse(data.text)).toEqual(value);
    expect(data.text).toContain("\\u0085\\u009b");
    const direct = result.content[0]!.text;
    expect(direct.split("\n\n").at(-1)).toBe(data.text);
    expect(
      [...direct].some((character) => {
        const code = character.codePointAt(0)!;
        return (code < 32 && code !== 10) || (code >= 127 && code <= 159);
      }),
    ).toBe(false);
    expect(Buffer.byteLength(direct)).toBeLessThanOrEqual(48 * 1024);
    expect(direct.split("\n").length).toBeLessThanOrEqual(1_900);
  });

  it.each([
    { bound: "characters", value: { text: "x".repeat(100) }, maxChars: 20 },
    { bound: "bytes", value: { text: "😀".repeat(20_000) }, maxChars: 40_000 },
    {
      bound: "lines",
      value: Array.from({ length: 2_000 }, () => 1),
      maxChars: 40_000,
    },
  ])(
    "discloses JSON truncation at the $bound bound with matching selections",
    async ({ value, maxChars }) => {
      const result = await executeWebFetch(
        { url: "https://example.com/data", maxChars },
        undefined,
        undefined,
        {
          transport: {
            profile: { browser: "chrome_147", os: "windows" },
            fetch: async () =>
              page(
                "https://example.com/data",
                "application/json",
                JSON.stringify(value),
              ),
          },
        },
      );
      const data = result.structuredContent;
      expect(data).toMatchObject({ ok: true, format: "json", truncated: true });
      if (!data.ok || data.format !== "json") {
        throw new Error("Expected JSON result");
      }
      const direct = result.content[0]!.text;
      expect(direct.split("\n\n").at(-1)).toBe(data.text);
      expect(Buffer.byteLength(direct)).toBeLessThanOrEqual(48 * 1024);
      expect(direct.split("\n").length).toBeLessThanOrEqual(1_900);
    },
  );

  it("extracts readable HTML as markdown and restores global console", async () => {
    const transport: WebTransport = {
      profile: { browser: "chrome_147", os: "windows" },
      fetch: async () =>
        page(
          "https://example.com/post",
          "text/html",
          "<html><head><title>Example</title></head><body><article><h1>Heading</h1><p>Readable page text.</p></article></body></html>",
        ),
    };
    const previousConsoleError = console.error;

    const result = await executeWebFetch(
      { url: "https://example.com/post" },
      undefined,
      undefined,
      { transport },
    );

    expect(result.content[0]?.text).toContain("# Heading");
    expect(result.content[0]?.text).toContain("Readable page text.");
    expect(console.error).toBe(previousConsoleError);
  });

  it("uses bounded extraction metadata and discloses semantic truncation", async () => {
    const transport: WebTransport = {
      profile: { browser: "chrome_147", os: "windows" },
      fetch: async () =>
        page("https://example.com/post", "text/html", "<main>ignored</main>"),
    };
    const result = await executeWebFetch(
      { url: "https://example.com/post", maxChars: 4 },
      undefined,
      undefined,
      {
        transport,
        extractHtml: async () => ({
          content: "readable content",
          title: "Example title",
          site: "Example",
        }),
      },
    );

    expect(result.content[0]?.text).toContain("Title: Example title");
    expect(result.content[0]?.text).toContain(
      "[Content truncated to requested maxChars",
    );
    expect(result.content[0]?.text).toContain("read");
    expect(result.structuredContent).toMatchObject({
      ok: true,
      source: { title: "Example title", site: "Example" },
      text: "read",
      truncated: true,
    });
    expect(JSON.stringify(result.details)).not.toContain("readable content");
  });

  it("detects valid JSON despite an incorrect content type", async () => {
    const transport: WebTransport = {
      profile: { browser: "chrome_147", os: "windows" },
      fetch: async () =>
        page("https://example.com/data", "text/plain", '{"ok":true}'),
    };

    const result = await executeWebFetch(
      { url: "https://example.com/data" },
      undefined,
      undefined,
      { transport },
    );

    expect(result.content[0]?.text).toContain('{\n  "ok": true\n}');
    expect(result.details).toMatchObject({
      contentType: "text/plain",
      output: "json",
    });
  });

  it("detects HTML despite an incorrect content type", async () => {
    const transport: WebTransport = {
      profile: { browser: "chrome_147", os: "windows" },
      fetch: async () =>
        page(
          "https://example.com/post",
          "text/plain",
          "<article><h1>Heading</h1><p>Readable page text.</p></article>",
        ),
    };

    const result = await executeWebFetch(
      { url: "https://example.com/post" },
      undefined,
      undefined,
      { transport },
    );

    expect(result.content[0]?.text).toContain("Readable page text.");
    expect(result.details).toMatchObject({
      contentType: "text/plain",
      output: "markdown",
    });
  });

  it("returns non-JSON textual responses as plain text", async () => {
    const transport: WebTransport = {
      profile: { browser: "chrome_147", os: "windows" },
      fetch: async () =>
        page("https://example.com/data", "text/plain", "plain response"),
    };

    const result = await executeWebFetch(
      { url: "https://example.com/data" },
      undefined,
      undefined,
      { transport },
    );

    expect(result.content[0]?.text).toContain("plain response");
    expect(result.details).toMatchObject({ output: "text" });
  });

  it("follows bounded immediate meta refreshes and rejects a sixth refresh", async () => {
    const fetch = vi
      .fn<WebTransport["fetch"]>()
      .mockResolvedValueOnce(
        page(
          "https://example.com/start",
          "text/html",
          '<html><head><meta http-equiv="refresh" content="0; url=/next"></head></html>',
        ),
      )
      .mockResolvedValueOnce(
        page("https://example.com/next", "text/plain", "finished"),
      );
    const transport: WebTransport = {
      profile: { browser: "chrome_147", os: "windows" },
      fetch,
    };
    const result = await executeWebFetch(
      { url: "https://example.com/start" },
      undefined,
      undefined,
      { transport },
    );
    expect(result.content[0]?.text).toContain("finished");
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://example.com/next",
      undefined,
      undefined,
      expect.anything(),
    );

    let loopCalls = 0;
    const loopingTransport: WebTransport = {
      profile: transport.profile,
      fetch: async (input) => {
        loopCalls++;
        return page(
          String(input),
          "text/html",
          '<html><head><meta http-equiv="refresh" content="0; url=/again"></head></html>',
        );
      },
    };
    await expect(
      executeWebFetch(
        { url: "https://example.com/again" },
        undefined,
        undefined,
        { transport: loopingTransport },
      ),
    ).resolves.toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error: {
          code: "redirect",
          message: expect.stringContaining("five immediate meta refreshes"),
        },
      },
    });
    expect(loopCalls).toBe(6);
  });

  it("writes a raw textual artifact without invoking extraction", async () => {
    const root = await mkdtemp(join(tmpdir(), "pipkin-web-test-"));
    const artifacts = new ArtifactStore({ temporaryRoot: root });
    const extract = vi.fn<typeof extractHtml>();
    const transport: WebTransport = {
      profile: { browser: "chrome_147", os: "windows" },
      fetch: async () =>
        page("https://example.com/raw", "text/plain", "unused"),
      fetchArtifact: async () =>
        page("https://example.com/raw", "text/plain", "raw evidence"),
    };
    try {
      const result = await executeWebFetch(
        { url: "https://example.com/raw", raw: true, maxChars: 4 },
        undefined,
        undefined,
        { transport, artifacts, extractHtml: extract },
      );
      const artifact = artifactOf(result);
      expect(artifact.lifetime).toBe("temporary");

      expect(result.content[0]?.text).toContain("raw ");
      expect(result.content[0]?.text).toContain("Temporary artifact:");
      expect(extract).not.toHaveBeenCalled();
      expect(artifact.bytes).toBe(Buffer.byteLength("raw evidence"));
      expect(await readFile(artifact.path, "utf8")).toBe("raw evidence");
      expect((await stat(artifact.path)).mode & 0o777).toBe(0o600);
      expect(JSON.stringify(result.details)).not.toContain("raw evidence");
    } finally {
      await artifacts.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("routes textual raw bodies, attachments, and binary raw responses to truthful artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "pipkin-web-test-"));
    const artifacts = new ArtifactStore({ temporaryRoot: root });
    const extract = vi.fn<typeof extractHtml>();
    const transport: WebTransport = {
      profile: { browser: "chrome_147", os: "windows" },
      fetch: async () => page("https://example.com", "text/plain", "unused"),
      fetchArtifact: async (input) => {
        const url = String(input);
        if (url.endsWith("data.csv")) {
          return page(url, "text/csv", "name,value\nPipkin,1");
        }
        if (url.endsWith("attachment")) {
          const attachment = page(url, "text/plain", "secret attachment");
          attachment.headers.set(
            "content-disposition",
            'attachment; filename="report.txt"',
          );
          return attachment;
        }
        return page(url, "application/octet-stream", "\0secret binary");
      },
    };
    try {
      const csv = await executeWebFetch(
        { url: "https://example.com/data.csv", raw: true },
        undefined,
        undefined,
        { transport, artifacts, extractHtml: extract },
      );
      const csvArtifact = artifactOf(csv);
      expect(csvArtifact.kind).toBe("raw-text");
      expect(csv.content[0]?.text).toContain("name,value\nPipkin,1");
      expect(await readFile(csvArtifact.path, "utf8")).toBe(
        "name,value\nPipkin,1",
      );

      const binary = await executeWebFetch(
        { url: "https://example.com/binary", raw: true },
        undefined,
        undefined,
        { transport, artifacts, extractHtml: extract },
      );
      expect(artifactOf(binary).kind).toBe("binary");
      expect(binary.content[0]?.text).not.toContain("secret binary");

      const attachment = await executeWebFetch(
        { url: "https://example.com/attachment", raw: true },
        undefined,
        undefined,
        { transport, artifacts, extractHtml: extract },
      );
      expect(artifactOf(attachment).kind).toBe("binary");
      expect(attachment.content[0]?.text).not.toContain("secret attachment");
      expect(extract).not.toHaveBeenCalled();
    } finally {
      await artifacts.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps long raw previews verbatim", async () => {
    const root = await mkdtemp(join(tmpdir(), "pipkin-web-test-"));
    const artifacts = new ArtifactStore({ temporaryRoot: root });
    const raw = "x".repeat(9_001);
    const lineLimited = "x\n".repeat(20_000);
    const transport: WebTransport = {
      profile: { browser: "chrome_147", os: "windows" },
      fetch: async () =>
        page("https://example.com/raw", "text/plain", "unused"),
      fetchArtifact: async (input) =>
        page(
          String(input),
          "text/plain",
          String(input).endsWith("lines") ? lineLimited : raw,
        ),
    };
    try {
      const result = await executeWebFetch(
        { url: "https://example.com/raw", raw: true, maxChars: 9_001 },
        undefined,
        undefined,
        { transport, artifacts },
      );
      expect(result.content[0]?.text.split("\n\n").at(-1)).toBe(raw);

      const limited = await executeWebFetch(
        { url: "https://example.com/lines", raw: true, maxChars: 40_000 },
        undefined,
        undefined,
        { transport, artifacts },
      );
      const limitedText = limited.content[0]?.text ?? "";
      expect(limitedText).toContain(
        "[Final output truncated to 48 KiB or 1,900 lines.]",
      );
      expect(Buffer.byteLength(limitedText)).toBeLessThanOrEqual(48 * 1024);
      expect(limitedText.split("\n").length).toBeLessThanOrEqual(1_900);
    } finally {
      await artifacts.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("streams attachments to artifacts without exposing their bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pipkin-web-test-"));
    const artifacts = new ArtifactStore({ temporaryRoot: root });
    const transport: WebTransport = {
      profile: { browser: "chrome_147", os: "windows" },
      fetch: async () =>
        page("https://example.com/file", "application/octet-stream", "unused"),
      fetchArtifact: async () => {
        const response = page(
          "https://example.com/file",
          "application/octet-stream",
          "\0secret",
        );
        response.headers.set(
          "content-disposition",
          'attachment; filename="report.bin"',
        );
        return response;
      },
    };
    try {
      const result = await executeWebFetch(
        { url: "https://example.com/file" },
        undefined,
        undefined,
        { transport, artifacts },
      );
      const artifact = artifactOf(result);

      expect(artifact.kind).toBe("binary");
      expect(result.content[0]?.text).toContain("Temporary artifact:");
      expect(result.content[0]?.text).not.toContain("secret");
      expect(JSON.stringify(result.details)).not.toContain("secret");
      expect(await readFile(artifact.path)).toEqual(Buffer.from("\0secret"));
    } finally {
      await artifacts.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { source: "URL", url: "https://example.com/report%C2%9B31m.bin" },
    {
      source: "Content-Disposition",
      url: "https://example.com/",
      disposition: "attachment; filename*=UTF-8''report%C2%9B31m.bin",
    },
  ])(
    "rejects C1 controls from $source before creating a temporary artifact",
    async ({ url, disposition }) => {
      const root = await mkdtemp(join(tmpdir(), "pipkin-web-test-"));
      const artifacts = new ArtifactStore({ temporaryRoot: root });
      try {
        const result = await executeWebFetch({ url }, undefined, undefined, {
          artifacts,
          transport: {
            profile: { browser: "chrome_147", os: "windows" },
            fetch: async () => {
              const response = page(
                url,
                "application/octet-stream",
                "\0artifact bytes",
              );
              if (disposition) {
                response.headers.set("content-disposition", disposition);
              }
              return response;
            },
          },
        });
        const artifact = artifactOf(result);
        expect(basename(artifact.path)).toMatch(/^artifact-[\da-f-]+\.bin$/u);
        expect(
          [...artifact.path].some((character) => {
            const code = character.codePointAt(0)!;
            return code < 32 || (code >= 127 && code <= 159);
          }),
        ).toBe(false);
        expect(result.content[0]!.text).toContain(
          `Temporary artifact: ${artifact.path} (`,
        );
        expect(result.content[0]!.text).not.toContain("\u009b");
        expect(artifact).toMatchObject({
          bytes: Buffer.byteLength("\0artifact bytes"),
          lifetime: "temporary",
          kind: "binary",
        });
        expect(await readFile(artifact.path)).toEqual(
          Buffer.from("\0artifact bytes"),
        );
        expect((await stat(artifact.path)).mode & 0o777).toBe(0o600);
        const [directory] = await readdir(root);
        expect(await readdir(join(root, directory!))).toEqual([
          basename(artifact.path),
        ]);
        await artifacts.dispose();
        expect(await readdir(root)).toEqual([]);
      } finally {
        await artifacts.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("rejects script-only fallback content as JavaScript-required", async () => {
    const transport: WebTransport = {
      profile: { browser: "chrome_147", os: "windows" },
      fetch: async () => page("https://example.com", "text/plain", "unused"),
    };
    const deadline = createInvocationDeadline();

    try {
      await expect(
        extractHtml(
          "<html><body><script>loadApplication()</script><style>.app { color: red }</style><noscript>Enable JavaScript</noscript></body></html>",
          "https://example.com",
          { transport, deadline },
        ),
      ).rejects.toThrow("may require JavaScript");
    } finally {
      deadline.dispose();
    }
  });

  it("reserves the final truncation notice under byte and line ceilings", async () => {
    const transport: WebTransport = {
      profile: { browser: "chrome_147", os: "windows" },
      fetch: async () =>
        page("https://example.com/post", "text/html", "<main>ignored</main>"),
    };
    const result = await executeWebFetch(
      { url: "https://example.com/post" },
      undefined,
      undefined,
      {
        transport,
        extractHtml: async () => ({
          content: "line\n".repeat(20_000),
        }),
      },
    );

    const text = result.content[0]?.text ?? "";
    expect(text).toContain(
      "[Final output truncated to 48 KiB or 1,900 lines.]",
    );
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(48 * 1024);
    expect(text.split("\n").length).toBeLessThanOrEqual(1_900);
    expect(result.structuredContent).toMatchObject({ truncated: true });
    const data = result.structuredContent;
    if (data.ok && data.format !== "artifact") {
      expect(text.endsWith(data.text)).toBe(true);
      expect(data.text.split("\n").length).toBeLessThanOrEqual(1900);
    }
  });

  it("bounds multi-byte text and extracted metadata without exposing control characters", async () => {
    const result = await executeWebFetch(
      { url: "https://example.com" },
      undefined,
      undefined,
      {
        transport: {
          profile: { browser: "chrome_147", os: "windows" },
          fetch: async () =>
            page("https://example.com", "text/html", "<main>ignored</main>"),
        },
        extractHtml: async () => ({
          content: "\u001b\u0000" + "😀".repeat(40_000),
          title: "\u001b" + "t".repeat(1000),
        }),
      },
    );
    const data = result.structuredContent;
    expect(data).toMatchObject({
      ok: true,
      format: "markdown",
      truncated: true,
    });
    if (data.ok && data.format !== "artifact") {
      expect(data.source?.title).toHaveLength(512);
      expect(Buffer.byteLength(data.text)).toBeLessThanOrEqual(48 * 1024);
      expect(result.content[0]?.text.endsWith(data.text)).toBe(true);
    }
    const direct = result.content[0]!.text;
    expect(Buffer.byteLength(direct)).toBeLessThanOrEqual(48 * 1024);
    expect(direct).not.toContain("\u001b");
    expect(direct).not.toContain("\u0000");
  });

  it("rejects a nonempty application loading shell as JavaScript-required", async () => {
    const deadline = createInvocationDeadline();
    const transport: WebTransport = {
      profile: { browser: "chrome_147", os: "windows" },
      fetch: async () => page("https://example.com", "text/plain", "unused"),
    };

    try {
      await expect(
        extractHtml(
          '<div id="root">Loading...</div><script>boot()</script>',
          "https://example.com",
          { transport, deadline },
        ),
      ).rejects.toThrow("may require JavaScript");
    } finally {
      deadline.dispose();
    }
  });

  it("uses the sanitized untouched DOM fallback for useful short content", async () => {
    const deadline = createInvocationDeadline();
    const transport: WebTransport = {
      profile: { browser: "chrome_147", os: "windows" },
      fetch: async () => page("https://example.com", "text/plain", "unused"),
    };

    try {
      await expect(
        extractHtml(
          "<html><body><main>Brief useful evidence.</main><script>ignore()</script><noscript>ignore</noscript><p hidden>hidden</p></body></html>",
          "https://example.com",
          {
            transport,
            deadline,
            defuddle: (async () => ({ content: "" })) as never,
          },
        ),
      ).resolves.toMatchObject({ content: "Brief useful evidence." });
    } finally {
      deadline.dispose();
    }
  });

  it("forwards Defuddle POST requests through the controlled transport", async () => {
    const deadline = createInvocationDeadline();
    const fetch = vi.fn<WebTransport["fetch"]>(async () =>
      page("https://extractor.example/api", "text/plain", "nested response"),
    );
    const transport: WebTransport = {
      profile: { browser: "chrome_147", os: "windows" },
      fetch,
    };

    try {
      await extractHtml("<main>Initial content</main>", "https://example.com", {
        transport,
        deadline,
        defuddle: (async (
          _document: Document,
          _url: string,
          options: {
            fetch?: (
              input: RequestInfo | URL,
              init?: RequestInit,
            ) => Promise<Response>;
          },
        ) => {
          await options.fetch!(
            new Request("https://extractor.example/api", {
              method: "POST",
              body: "bounded extractor body",
              headers: { "x-extractor": "yes" },
            }),
          );
          return { content: "Readable extracted content." };
        }) as never,
      });
      expect(fetch).toHaveBeenCalledWith(
        expect.any(Request),
        undefined,
        undefined,
        deadline,
      );
    } finally {
      deadline.dispose();
    }
  });

  it("observes cancellation immediately after synchronous extraction", async () => {
    const controller = new AbortController();
    const transport: WebTransport = {
      profile: { browser: "chrome_147", os: "windows" },
      fetch: async () =>
        page("https://example.com/post", "text/html", "<main>content</main>"),
    };

    await expect(
      executeWebFetch(
        { url: "https://example.com/post" },
        controller.signal,
        undefined,
        {
          transport,
          extractHtml: async () => {
            controller.abort(new DOMException("cancelled", "AbortError"));
            return { content: "late content" };
          },
        },
      ),
    ).resolves.toMatchObject({
      isError: true,
      structuredContent: { ok: false, error: { code: "cancelled" } },
    });
  });
});
