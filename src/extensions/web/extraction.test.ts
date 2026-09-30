import { describe, expect, it, vi } from "vitest";
import type { DefuddleResponse } from "defuddle/node";
import { createInvocationDeadline, type WebTransport } from "./transport.js";
import { extractHtml } from "./extraction.js";
import { WebError } from "./errors.js";

const transport: WebTransport = {
  profile: { browser: "chrome_147", os: "windows" },
  fetch: async () => new Response("unused"),
};
const html = "<html><body><main>Useful fallback content.</main></body></html>";

describe("HTML extraction diagnostic containment", () => {
  it.each(["success", "fallback"] as const)(
    "contains synchronous and asynchronous Defuddle diagnostics on %s",
    async (outcome) => {
      const deadline = createInvocationDeadline();
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const result = await extractHtml(html, "https://example.com", {
          transport,
          deadline,
          defuddle: async () => {
            console.warn("dependency warning with sensitive URL");
            await Promise.resolve();
            console.error(new Error("dependency stack"));
            console.log("dependency diagnostic");
            if (outcome === "fallback") {
              throw new Error("extraction failed");
            }
            return {
              content: "Readable extracted content.",
            } as DefuddleResponse;
          },
        });
        expect(result.content).toBe(
          outcome === "success"
            ? "Readable extracted content."
            : "Useful fallback content.",
        );
        expect(JSON.stringify(result)).not.toMatch(/dependency|sensitive/);
        expect(error).not.toHaveBeenCalled();
        expect(warning).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalled();
        expect(console.error).toBe(error);
      } finally {
        deadline.dispose();
        vi.restoreAllMocks();
      }
    },
  );

  it("contains real Defuddle metadata warnings without a metadata-specific shield", async () => {
    const deadline = createInvocationDeadline();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await extractHtml(
        '<html><head><meta property="og:url" content="not a valid URL"></head><body><article><h1>Heading</h1><p>Readable page text.</p></article></body></html>',
        "https://example.com/post",
        { transport, deadline },
      );
      expect(result.content).toContain("Readable page text.");
      expect(warning).not.toHaveBeenCalled();
    } finally {
      deadline.dispose();
      warning.mockRestore();
    }
  });

  it("does not hide a rejected extractor request that Defuddle catches and logs", async () => {
    const deadline = createInvocationDeadline();
    const failure = new WebError("target", "Extractor request denied.");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        extractHtml(html, "https://example.com", {
          deadline,
          transport: {
            ...transport,
            fetch: async () => {
              throw failure;
            },
          },
          defuddle: async (_document, _url, options) => {
            try {
              await options!.fetch!("https://extractor.example/api");
            } catch (cause) {
              console.error(cause);
            }
            return { content: "Misleading success." } as DefuddleResponse;
          },
        }),
      ).rejects.toBe(failure);
      expect(error).not.toHaveBeenCalled();
    } finally {
      deadline.dispose();
      error.mockRestore();
    }
  });
});
