import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import Ajv from "ajv";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { LspPool, LSP_POOL_MANAGER_KEY } from "./pool.js";
import {
  ContentLengthDecoder,
  encodeMessage,
  type JsonRpcMessage,
} from "./protocol.js";
import { registerLsp } from "./tool.js";

class Server extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  messages: JsonRpcMessage[] = [];
  respond: (message: JsonRpcMessage) => void = () => {};
  capabilities: Record<string, unknown> = {
    definitionProvider: true,
    documentSymbolProvider: true,
    workspaceSymbolProvider: true,
    hoverProvider: true,
    diagnosticProvider: {},
  };
  kill() {
    this.emit("close", 0, null);
    return true;
  }
  constructor() {
    super();
    const decoder = new ContentLengthDecoder();
    this.stdin.on("data", (chunk: Buffer) => {
      for (const message of decoder.push(chunk)) {
        this.messages.push(message);
        if (message.method === "initialize") {
          this.reply(message, { capabilities: this.capabilities });
        } else {
          this.respond(message);
        }
      }
    });
  }
  reply(message: JsonRpcMessage, result: unknown) {
    this.stdout.write(encodeMessage({ id: message.id, result }));
  }
  publish(params: unknown) {
    this.stdout.write(
      encodeMessage({ method: "textDocument/publishDiagnostics", params }),
    );
  }
}

function tools(register = registerLsp) {
  const definitions = new Map<string, ToolDefinition>();
  register({
    registerTool: (tool: ToolDefinition) => definitions.set(tool.name, tool),
  } as never);
  return definitions;
}
async function call(
  definitions: Map<string, ToolDefinition>,
  cwd: string,
  name: string,
  input: unknown,
  signal?: AbortSignal,
) {
  const tool = definitions.get(name)!;
  const result = await tool.execute("probe", input, signal, undefined, {
    cwd,
    ui: { notify: vi.fn() },
  } as never);
  const validate = new Ajv({ allErrors: true }).compile(tool.outputSchema!);
  expect(
    validate(result.structuredContent),
    JSON.stringify(validate.errors),
  ).toBe(true);
  expect(result.isError).toBe(
    !(result.structuredContent as { ok: boolean }).ok,
  );
  expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(
    result.structuredContent,
  );
  return result.structuredContent;
}
async function fixture(
  run: (cwd: string, server: Server, pool: LspPool) => Promise<void>,
  Pool = LspPool,
) {
  const cwd = realpathSync(
    mkdtempSync(join(tmpdir(), "pipkin-lsp-responses-")),
  );
  writeFileSync(join(cwd, "tsconfig.json"), "{}");
  writeFileSync(join(cwd, "sample.ts"), "const value = 1;\n");
  const server = new Server();
  const pool = new Pool({ spawn: (() => server) as never });
  const global = globalThis as Record<symbol, unknown>;
  const previous = global[LSP_POOL_MANAGER_KEY];
  global[LSP_POOL_MANAGER_KEY] = { pool };
  try {
    await run(cwd, server, pool);
  } finally {
    await pool.shutdown();
    if (previous === undefined) {
      delete global[LSP_POOL_MANAGER_KEY];
    } else {
      global[LSP_POOL_MANAGER_KEY] = previous;
    }
    rmSync(cwd, { recursive: true, force: true });
  }
}

const range = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 5 },
};

describe("untrusted language-server responses", () => {
  it("rejects malformed semantic data through registered operations while accepting null and unresolved symbols", async () => {
    await fixture(async (cwd, server) => {
      const definitions = tools();
      const positionInput = {
        file: "sample.ts",
        position: { line: 1, column: 1 },
      };
      for (const [name, input, response] of [
        ["lsp_definition", positionInput, {}],
        [
          "lsp_definition",
          positionInput,
          [{ uri: "custom:source", range }, null],
        ],
        ["lsp_document_symbols", { file: "sample.ts" }, "not an array"],
        [
          "lsp_document_symbols",
          { file: "sample.ts" },
          [{ name: "  ", range }],
        ],
        ["lsp_document_symbols", { file: "sample.ts" }, [{ name: "value" }]],
        [
          "lsp_document_symbols",
          { file: "sample.ts" },
          [{ name: "value", selectionRange: range }],
        ],
        [
          "lsp_document_symbols",
          { file: "sample.ts" },
          [{ name: "value", range }],
        ],
        [
          "lsp_document_symbols",
          { file: "sample.ts" },
          [{ name: "value", location: { uri: "custom:source" } }],
        ],
        [
          "lsp_workspace_symbols",
          { query: "value" },
          [{ name: "value", location: {} }],
        ],
        ["lsp_hover", positionInput, { contents: {} }],
      ] as const) {
        server.respond = (message) => {
          if (message.id !== undefined) {
            server.reply(message, response);
          }
        };
        expect(await call(definitions, cwd, name, input)).toMatchObject({
          ok: false,
          error: { code: "request_failed" },
        });
      }
      server.respond = (message) => {
        if (message.id !== undefined) {
          server.reply(message, null);
        }
      };
      expect(
        await call(definitions, cwd, "lsp_definition", positionInput),
      ).toMatchObject({ ok: true, locations: [] });
      expect(
        await call(definitions, cwd, "lsp_document_symbols", {
          file: "sample.ts",
        }),
      ).toMatchObject({ ok: true, symbols: [] });
      expect(
        await call(definitions, cwd, "lsp_hover", positionInput),
      ).toMatchObject({ ok: true, text: "" });
      for (const response of [
        [],
        [{ name: "value", kind: 13, range, selectionRange: range }],
        [
          {
            name: "value",
            kind: 13,
            location: { uri: "custom:source", range },
          },
        ],
      ]) {
        server.respond = (message) => {
          if (message.id !== undefined) {
            server.reply(message, response);
          }
        };
        const result = await call(definitions, cwd, "lsp_document_symbols", {
          file: "sample.ts",
        });
        expect(result).toMatchObject({
          ok: true,
          symbols: response.length
            ? [
                {
                  name: "value",
                  location: { line: 1, column: 1, endLine: 1, endColumn: 6 },
                },
              ]
            : [],
        });
      }
      server.respond = (message) => {
        if (message.id !== undefined) {
          server.reply(message, [
            { name: "value", kind: 13, location: { uri: "custom:source" } },
          ]);
        }
      };
      expect(
        await call(definitions, cwd, "lsp_workspace_symbols", {
          query: "value",
        }),
      ).toMatchObject({ ok: true, symbols: [{ name: "value", kind: 13 }] });
    });
  });

  it("does not let invalid pull diagnostics establish currency or replace a usable cache", async () => {
    await fixture(async (cwd, server) => {
      const definitions = tools();
      const input = { file: "sample.ts", timeout: 0.1 };
      server.respond = (message) => {
        if (message.method === "textDocument/diagnostic") {
          server.reply(message, {
            kind: "full",
            resultId: "good",
            items: [{ range, message: "known issue" }],
          });
        }
      };
      expect(
        await call(definitions, cwd, "lsp_diagnostics", input),
      ).toMatchObject({ ok: true, freshness: "current" });
      server.respond = (message) => {
        if (message.method === "textDocument/diagnostic") {
          server.reply(message, {
            kind: "full",
            resultId: "bad",
            items: [null],
          });
        }
      };
      expect(
        await call(definitions, cwd, "lsp_diagnostics", input),
      ).toMatchObject({ ok: false, error: { code: "request_failed" } });
      server.respond = () => {};
      expect(
        await call(definitions, cwd, "lsp_diagnostics", input),
      ).toMatchObject({
        ok: true,
        freshness: "stale",
        timedOut: true,
        diagnostics: [{ message: "known issue" }],
        evidence: { resultId: "good" },
      });
      server.respond = (message) => {
        if (message.method === "textDocument/diagnostic") {
          server.reply(message, { kind: "full", items: [] });
        }
      };
      expect(
        await call(definitions, cwd, "lsp_diagnostics", input),
      ).toMatchObject({ ok: true, freshness: "current", diagnostics: [] });
    });
  });

  it("contains malformed publications during synchronization and pending diagnostic waits without poisoning cache", async () => {
    await fixture(async (cwd, server, pool) => {
      delete server.capabilities.diagnosticProvider;
      const definitions = tools();
      const input = { file: "sample.ts", timeout: 0.2 };
      let uri = "";
      server.respond = (message) => {
        if (message.method === "textDocument/didOpen") {
          uri = (message.params as { textDocument: { uri: string } })
            .textDocument.uri;
          server.publish({
            uri,
            version: 1,
            diagnostics: [{ range: {}, message: "invalid" }],
          });
          server.publish(null);
        }
        if (message.id !== undefined) {
          server.reply(message, null);
        }
      };
      expect(
        await call(definitions, cwd, "lsp_definition", {
          file: "sample.ts",
          position: { line: 1, column: 1 },
        }),
      ).toMatchObject({ ok: true, locations: [] });
      const waiting = call(definitions, cwd, "lsp_diagnostics", input);
      await new Promise((resolve) => setImmediate(resolve));
      server.publish({ uri, version: 1, diagnostics: [null] });
      expect(await waiting).toMatchObject({
        ok: false,
        error: { code: "timeout" },
      });
      server.publish({
        uri,
        version: 1,
        diagnostics: [{ range, message: "known issue" }],
      });
      expect(
        await call(definitions, cwd, "lsp_diagnostics", input),
      ).toMatchObject({ ok: true, freshness: "current" });
      writeFileSync(join(cwd, "sample.ts"), "const value = 2;\n");
      const stale = call(definitions, cwd, "lsp_diagnostics", input);
      await new Promise((resolve) => setImmediate(resolve));
      server.publish({
        uri,
        version: 2,
        diagnostics: [{ range: {}, message: "invalid" }],
      });
      expect(await stale).toMatchObject({
        ok: true,
        freshness: "stale",
        timedOut: true,
        diagnostics: [{ message: "known issue" }],
      });
      server.publish({ uri, version: 2, diagnostics: [] });
      expect(
        await call(definitions, cwd, "lsp_diagnostics", input),
      ).toMatchObject({ ok: true, freshness: "current", diagnostics: [] });
      expect(pool.status()).toMatchObject([{ activeRequests: 0 }]);
      await pool.shutdown();
      expect(pool.closed).toBe(true);
    });
  });

  it("classifies actual shared-pool timeouts across separate uncached Jiti loaders", async () => {
    const { createJiti } = createRequire(
      import.meta.resolve("@earendil-works/pi-coding-agent"),
    )("jiti") as {
      createJiti(
        base: string,
        options: { moduleCache: boolean },
      ): {
        import<T>(specifier: string): Promise<T>;
      };
    };
    const runtimeLoader = createJiti(import.meta.url, { moduleCache: false });
    const operationLoader = createJiti(import.meta.url, { moduleCache: false });
    const runtime =
      await runtimeLoader.import<typeof import("./pool.js")>("./pool.ts");
    const operations =
      await operationLoader.import<typeof import("./tool.js")>("./tool.ts");
    expect(runtime.LspPool).not.toBe(LspPool);
    expect(operations.registerLsp).not.toBe(registerLsp);
    await fixture(async (cwd, server, pool) => {
      const definitions = tools(operations.registerLsp);
      expect(
        await call(definitions, cwd, "lsp_document_symbols", {
          file: "sample.ts",
          timeout: 0.1,
        }),
      ).toMatchObject({ ok: false, error: { code: "timeout" } });
      expect(
        await call(definitions, cwd, "lsp_workspace_symbols", {
          query: "value",
          timeout: 0.1,
        }),
      ).toMatchObject({ ok: false, error: { code: "timeout" } });
      const controller = new AbortController();
      const cancelled = call(
        definitions,
        cwd,
        "lsp_document_symbols",
        { file: "sample.ts" },
        controller.signal,
      );
      await vi.waitFor(() =>
        expect(
          server.messages.filter(
            (message) => message.method === "textDocument/documentSymbol",
          ),
        ).toHaveLength(2),
      );
      controller.abort();
      expect(await cancelled).toMatchObject({
        ok: false,
        error: { code: "cancelled" },
      });
      server.respond = (message) => {
        if (message.method === "textDocument/diagnostic") {
          server.reply(message, { kind: "full", items: [] });
        }
      };
      await call(definitions, cwd, "lsp_diagnostics", { file: "sample.ts" });
      server.respond = () => {};
      expect(
        await call(definitions, cwd, "lsp_diagnostics", {
          file: "sample.ts",
          timeout: 0.1,
        }),
      ).toMatchObject({ ok: true, freshness: "stale", timedOut: true });
      expect(
        server.messages.filter((message) => message.method === "initialize"),
      ).toHaveLength(1);
      expect(
        server.messages.filter(
          (message) => message.method === "$/cancelRequest",
        ),
      ).toHaveLength(4);
      expect(pool.status()).toMatchObject([
        { activeRequests: 0, state: "running" },
      ]);
    }, runtime.LspPool);
  });
});
