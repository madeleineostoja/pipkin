import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Ajv from "ajv";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { actions } from "./contracts.js";
import { LspPool, LSP_POOL_MANAGER_KEY } from "./pool.js";
import { registerLsp } from "./tool.js";
import { RequestCancelledError, RequestTimeoutError } from "./protocol.js";

const directories: string[] = [];
function workspace(): string {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "pipkin-lsp-tool-")),
  );
  directories.push(directory);
  writeFileSync(join(directory, "tsconfig.json"), "{}");
  writeFileSync(
    join(directory, "sample.ts"),
    "const value = value; // 😀 value\n",
  );
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  delete (globalThis as Record<symbol, unknown>)[LSP_POOL_MANAGER_KEY];
});
function tools() {
  const definitions: any[] = [];
  registerLsp({
    registerTool: (definition: unknown) => definitions.push(definition),
  } as never);
  return new Map(definitions.map((tool) => [tool.name, tool]));
}
function useClient(client: Record<string, unknown>) {
  const acquire = vi.fn(async () => client);
  (globalThis as Record<symbol, unknown>)[LSP_POOL_MANAGER_KEY] = {
    pool: { closed: false, acquire, shutdown() {}, status: () => [] },
  };
  return acquire;
}
async function call(
  name: string,
  input: unknown,
  cwd: string,
  signal?: AbortSignal,
) {
  const tool = tools().get(name)!;
  const result = await tool.execute("test", input, signal, undefined, {
    cwd,
    ui: { notify: vi.fn() },
  });
  const validate = new Ajv({ allErrors: true }).compile(tool.outputSchema);
  expect(
    validate(result.structuredContent),
    JSON.stringify(validate.errors),
  ).toBe(true);
  expect(result.isError).toBe(!result.structuredContent.ok);
  expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(
    DEFAULT_MAX_BYTES,
  );
  expect(result.content[0].text.split("\n").length).toBeLessThanOrEqual(
    DEFAULT_MAX_LINES,
  );
  return result.structuredContent;
}
const range = {
  start: { line: 2, character: 4 },
  end: { line: 3, character: 9 },
};

describe("on-demand LSP operation contracts", () => {
  it("registers nine deferred operations, without lifecycle output or independent clients", () => {
    const api = { registerTool: vi.fn(), on: vi.fn() };
    registerLsp(api as unknown as ExtensionAPI);
    expect(api.registerTool.mock.calls.map(([tool]) => tool.name)).toEqual(
      actions.map((action) => `lsp_${action}`),
    );
    expect(api.on).not.toHaveBeenCalled();
    for (const [tool] of api.registerTool.mock.calls) {
      expect(tool).toMatchObject({
        exposure: "deferred",
        namespace: { name: "lsp" },
      });
      expect(tool.parameters.additionalProperties).toBe(false);
    }
    expect(
      (globalThis as Record<symbol, unknown>)[LSP_POOL_MANAGER_KEY],
    ).toBeUndefined();
  });

  it("preserves semantic ranges, caller-relative files and external identifiers", async () => {
    const cwd = workspace();
    const external = "https://example.org/source.ts";
    const externalPath = join(workspace(), "sample.ts");
    const externalFile = pathToFileURL(externalPath).href;
    const semantic = vi.fn(async () => [
      { uri: pathToFileURL(join(cwd, "sample.ts")).href, range },
      { targetUri: external, targetSelectionRange: range },
      { uri: externalFile, range },
    ]);
    const acquire = useClient({ supports: () => true, semantic });
    for (const name of [
      "definition",
      "type_definition",
      "implementation",
      "references",
    ]) {
      const data = await call(
        `lsp_${name}`,
        { file: "sample.ts", position: { line: 1, column: 7 } },
        cwd,
      );
      expect(data).toMatchObject({
        ok: true,
        truncated: false,
        locations: [
          { file: "sample.ts", line: 3, column: 5, endLine: 4, endColumn: 10 },
          { file: external },
          { file: externalPath },
        ],
      });
    }
    expect(acquire).toHaveBeenCalledTimes(4);
  });

  it("resolves repeated symbol selectors in UTF-16 and rejects invalid positions before acquisition", async () => {
    const cwd = workspace();
    const semantic = vi.fn(async () => []);
    const acquire = useClient({ supports: () => true, semantic });
    await call(
      "lsp_references",
      {
        file: "sample.ts",
        position: { line: 1, symbol: "value", occurrence: 3 },
      },
      cwd,
    );
    expect(semantic.mock.calls[0]).toEqual(
      expect.arrayContaining([{ line: 0, character: 27 }]),
    );
    for (const position of [
      { line: 2, column: 10 },
      { line: 1, column: 100 },
      { line: 1, symbol: "missing" },
    ]) {
      expect(
        await call("lsp_definition", { file: "sample.ts", position }, cwd),
      ).toMatchObject({ ok: false, error: { code: "invalid_position" } });
    }
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it("rejects open, ambiguous and invalid inputs without dispatch", async () => {
    const cwd = workspace();
    const acquire = useClient({ supports: () => true });
    for (const input of [
      { file: "sample.ts", position: { line: 1, column: 1, symbol: "value" } },
      { file: "sample.ts", position: { line: 1.5, column: 1 } },
      {
        file: "sample.ts",
        position: { line: 1, symbol: "value", occurrence: 0 },
      },
      { file: "sample.ts", position: { line: 1, column: 1 }, timeout: 0.09 },
      { file: "sample.ts", position: { line: 1, column: 1 }, request: {} },
    ]) {
      expect(await call("lsp_hover", input, cwd)).toMatchObject({
        ok: false,
        error: { code: "invalid_arguments" },
      });
    }
    expect(await call("lsp_workspace_symbols", {}, cwd)).toMatchObject({
      error: { code: "invalid_arguments" },
    });
    expect(acquire).not.toHaveBeenCalled();
  });

  it("denies out-of-workspace and missing files without starting a server", async () => {
    const cwd = workspace();
    const acquire = useClient({});
    expect(
      await call(
        "lsp_document_symbols",
        { file: join(workspace(), "sample.ts") },
        cwd,
      ),
    ).toMatchObject({ error: { code: "workspace_denied" } });
    expect(
      await call("lsp_diagnostics", { file: "missing.ts" }, cwd),
    ).toMatchObject({ error: { code: "not_found" } });
    expect(acquire).not.toHaveBeenCalled();
  });

  it("distinguishes unavailable, unsupported, protocol, timeout and cancellation failures", async () => {
    const cwd = workspace();
    useClient({ available: false, reason: "startup failed" });
    expect(
      await call(
        "lsp_hover",
        { file: "sample.ts", position: { line: 1, column: 1 } },
        cwd,
      ),
    ).toMatchObject({ error: { code: "server_unavailable" } });
    useClient({ supports: () => false });
    expect(
      await call("lsp_document_symbols", { file: "sample.ts" }, cwd),
    ).toMatchObject({ error: { code: "unsupported" } });
    for (const [error, code] of [
      [new RequestTimeoutError("expired"), "timeout"],
      [new RequestCancelledError("cancelled"), "cancelled"],
      [
        Object.assign(new Error("not implemented"), { code: -32601 }),
        "unsupported",
      ],
      [new Error("protocol failed"), "request_failed"],
    ]) {
      useClient({
        supports: () => true,
        semantic: async () => {
          throw error;
        },
      });
      expect(
        await call("lsp_document_symbols", { file: "sample.ts" }, cwd),
      ).toMatchObject({ error: { code } });
    }
    useClient({
      available: false,
      reason: "acquisition timeout",
      timedOut: true,
    });
    expect(
      await call("lsp_document_symbols", { file: "sample.ts" }, cwd),
    ).toMatchObject({ error: { code: "timeout" } });
  });

  it("reports a genuinely missing Ruby server as unavailable", async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, "sample.rb"), "puts :hello");
    const path = process.env.PATH;
    try {
      process.env.PATH = "";
      const acquire = useClient({});
      expect(
        await call("lsp_diagnostics", { file: "sample.rb" }, cwd),
      ).toMatchObject({ error: { code: "server_unavailable" } });
      expect(acquire).not.toHaveBeenCalled();
    } finally {
      process.env.PATH = path;
    }
  });

  it("returns named document and workspace symbols with bounded text and explicit truncation", async () => {
    const cwd = workspace();
    useClient({
      supports: () => true,
      semantic: async () => [
        { name: "value", kind: 13, range, selectionRange: range },
      ],
      workspaceSymbols: async () => [
        { name: "x".repeat(2001), location: { uri: "custom:source", range } },
      ],
    });
    expect(
      await call("lsp_document_symbols", { file: "sample.ts" }, cwd),
    ).toMatchObject({
      symbols: [
        { name: "value", kind: 13, location: { file: "sample.ts", line: 3 } },
      ],
    });
    const data = await call("lsp_workspace_symbols", { query: "x" }, cwd);
    expect(data.truncated).toBe(true);
    expect(data.symbols[0].name).toHaveLength(2000);
    expect(data.symbols[0].location.file).toBe("custom:source");
  });

  it("accepts empty hover and bounds control-safe hover text", async () => {
    const cwd = workspace();
    useClient({ supports: () => true, semantic: async () => null });
    expect(
      await call(
        "lsp_hover",
        { file: "sample.ts", position: { line: 1, column: 1 } },
        cwd,
      ),
    ).toEqual({ ok: true, text: "", truncated: false });
    useClient({
      supports: () => true,
      semantic: async () => ({ contents: "\u001b[31m" + "x".repeat(2001) }),
    });
    expect(
      await call(
        "lsp_hover",
        { file: "sample.ts", position: { line: 1, column: 1 } },
        cwd,
      ),
    ).toEqual({ ok: true, text: "x".repeat(2000), truncated: true });
  });

  it("distinguishes current empty diagnostics, stale timed-out cache and no snapshot", async () => {
    const cwd = workspace();
    useClient({
      diagnostics: async () => ({
        diagnostics: [],
        fresh: true,
        truncated: false,
      }),
    });
    expect(
      await call("lsp_diagnostics", { file: "sample.ts" }, cwd),
    ).toMatchObject({
      ok: true,
      diagnostics: [],
      freshness: "current",
      timedOut: false,
    });
    useClient({
      diagnostics: async () => ({
        diagnostics: [
          {
            range,
            severity: 2,
            message: "old issue",
            source: "ts",
            code: 2322,
          },
        ],
        fresh: false,
        hasSnapshot: true,
        stale: true,
        timedOut: true,
        truncated: false,
        resultId: "previous",
      }),
    });
    expect(
      await call("lsp_diagnostics", { file: "sample.ts" }, cwd),
    ).toMatchObject({
      ok: true,
      freshness: "stale",
      timedOut: true,
      diagnostics: [
        {
          range: { line: 3, column: 5, endLine: 4, endColumn: 10 },
          message: "old issue",
        },
      ],
      evidence: { fresh: false, stale: true, resultId: "previous" },
    });
    useClient({
      diagnostics: async () => ({
        diagnostics: [],
        fresh: false,
        hasSnapshot: true,
        stale: true,
        timedOut: true,
        truncated: false,
      }),
    });
    expect(
      await call("lsp_diagnostics", { file: "sample.ts" }, cwd),
    ).toMatchObject({ ok: true, diagnostics: [], freshness: "stale" });
    useClient({
      diagnostics: async () => ({
        diagnostics: [],
        fresh: false,
        timedOut: true,
        truncated: false,
      }),
    });
    expect(
      await call("lsp_diagnostics", { file: "sample.ts" }, cwd),
    ).toMatchObject({ ok: false, error: { code: "timeout" } });
  });

  it("bounds both direct and structured item and total results without invented totals", async () => {
    const cwd = workspace();
    useClient({
      supports: () => true,
      semantic: async () =>
        Array.from({ length: 101 }, () => ({ uri: "custom:source", range })),
    });
    const locations = await call(
      "lsp_references",
      { file: "sample.ts", position: { line: 1, column: 1 } },
      cwd,
    );
    expect(locations.locations).toHaveLength(100);
    expect(locations.truncated).toBe(true);
    expect(locations).not.toHaveProperty("total");
    useClient({
      supports: () => true,
      workspaceSymbols: async () =>
        Array.from({ length: 100 }, (_, index) => ({
          name: `${index}-${"x".repeat(1990)}`,
        })),
    });
    const symbols = await call("lsp_workspace_symbols", { query: "x" }, cwd);
    expect(symbols.symbols.length).toBeLessThan(100);
    expect(symbols.truncated).toBe(true);
  });

  it("reports all configured kinds and availability without launching servers", async () => {
    const cwd = workspace();
    const pool = new LspPool();
    (globalThis as Record<symbol, unknown>)[LSP_POOL_MANAGER_KEY] = { pool };
    try {
      const data = await call("lsp_status", {}, cwd);
      expect(data.servers.map((server: any) => server.kind)).toEqual([
        "typescript",
        "svelte",
        "ruby",
      ]);
      expect(data.servers).toContainEqual(
        expect.objectContaining({
          kind: "typescript",
          configured: true,
          available: true,
          running: false,
          state: "available",
        }),
      );
      expect(pool.status()).toEqual([]);
    } finally {
      await pool.shutdown();
    }
  });

  it("does not lose configured availability when a different server is running", async () => {
    const cwd = workspace();
    (globalThis as Record<symbol, unknown>)[LSP_POOL_MANAGER_KEY] = {
      pool: {
        closed: false,
        acquire() {},
        shutdown() {},
        status: () => [
          { kind: "typescript", state: "running", workspaceRoot: cwd },
        ],
      },
    };
    const data = await call("lsp_status", {}, cwd);
    expect(data.servers).toHaveLength(3);
    expect(data.servers[0]).toMatchObject({
      kind: "typescript",
      running: true,
      state: "running",
    });
  });

  it("uses one acquisition/request timeout budget with a five-second default and fifteen-second cap", async () => {
    const cwd = workspace();
    const budgets: number[] = [];
    const semantic = vi.fn(async (...args: any[]) => {
      budgets.push(args[4].timeoutMs);
      return [];
    });
    (globalThis as Record<symbol, unknown>)[LSP_POOL_MANAGER_KEY] = {
      pool: {
        closed: false,
        shutdown() {},
        acquire: async (
          _server: unknown,
          _root: string,
          options: { timeoutMs: number },
        ) => {
          budgets.push(options.timeoutMs);
          await new Promise((resolve) => setTimeout(resolve, 25));
          return { supports: () => true, semantic };
        },
      },
    };
    await call("lsp_document_symbols", { file: "sample.ts" }, cwd);
    expect(budgets[0]).toBeLessThanOrEqual(5000);
    expect(budgets[1]).toBeLessThan(budgets[0] - 10);
    await call(
      "lsp_document_symbols",
      { file: "sample.ts", timeout: 100 },
      cwd,
    );
    expect(budgets[2]).toBeLessThanOrEqual(15000);
    expect(budgets[2]).toBeGreaterThan(14000);
  });

  it("summarizes stale diagnostics while expanding the same useful bounded payload", async () => {
    const tool = tools().get("lsp_diagnostics")!;
    const theme = { fg: (_color: string, text: string) => text };
    const data = {
      ok: true,
      freshness: "stale",
      timedOut: true,
      diagnostics: [{ message: "old issue" }],
    };
    const result = {
      content: [{ type: "text", text: JSON.stringify(data) }],
      details: data,
    };
    const render = (expanded: boolean) =>
      tool
        .renderResult(result, { expanded, isPartial: false }, theme, {
          args: {},
          isError: false,
        })
        .render(200)
        .join("\n");
    expect(render(false)).toContain("Diagnostics are stale after the timeout.");
    expect(render(true)).toContain("old issue");
  });
});
