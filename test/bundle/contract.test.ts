import {
  createAgentSession,
  createBashToolDefinition,
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createEventBus,
  type Extension,
  type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PUBLIC_TOOL_CATALOGUE,
  PUBLIC_TOOL_EXCEPTIONS,
} from "../../src/extensions/guidance/catalogue.js";
import {
  EXPLORE_PROMPT,
  REVIEW_PROMPT,
} from "../../src/extensions/subagents/agent-profiles.js";
import { undocumentedSchemaProperties } from "../support/schema-descriptions.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const expectedExtensions = [
  "./src/extensions/sandbox/index.ts",
  "./src/extensions/readonly/index.ts",
  "./src/extensions/context/index.ts",
  "./src/extensions/ui/index.ts",
  "./src/extensions/personality/index.ts",
  "./src/extensions/guidance/index.ts",
  "./src/extensions/lsp/index.ts",
  "./src/extensions/processes/index.ts",
  "./src/extensions/subagents/index.ts",
  "./src/extensions/implement/index.ts",
  "./src/extensions/reference/index.ts",
  "./src/extensions/web/index.ts",
  "./src/extensions/browser/index.ts",
  "./src/extensions/mcp/index.ts",
  "./src/extensions/papercuts/index.ts",
  "./src/extensions/btw/index.ts",
];
const expectedExtensionPaths = expectedExtensions.map((path) => path.slice(2));
const manifest = JSON.parse(
  readFileSync(join(ROOT, "package.json"), "utf8"),
) as {
  pi: { extensions: string[] };
  workspaces?: unknown;
};

const expectedTools = {
  bash_outcome: "src/extensions/context/index.ts",
  context_recall: "src/extensions/context/index.ts",
  lsp: "src/extensions/lsp/index.ts",
  start_process: "src/extensions/processes/index.ts",
  get_process_result: "src/extensions/processes/index.ts",
  stop_process: "src/extensions/processes/index.ts",
  Agent: "src/extensions/subagents/index.ts",
  get_subagent_result: "src/extensions/subagents/index.ts",
  steer_subagent: "src/extensions/subagents/index.ts",
  inspect_implement_run: "src/extensions/implement/index.ts",
  docs: "src/extensions/reference/index.ts",
  package_search: "src/extensions/reference/index.ts",
  code_search: "src/extensions/reference/index.ts",
  web_fetch: "src/extensions/web/index.ts",
  batch_web_fetch: "src/extensions/web/index.ts",
  browser_observe: "src/extensions/browser/index.ts",
  browser_act: "src/extensions/browser/index.ts",
  record_papercut: "src/extensions/papercuts/index.ts",
};

const expectedOptionalTools = {
  mcp: "src/extensions/mcp/index.ts",
  mcpScript: "src/extensions/mcp/index.ts",
};
const expectedCommands = {
  sandbox: "src/extensions/sandbox/index.ts",
  readonly: "src/extensions/readonly/index.ts",
  processes: "src/extensions/processes/index.ts",
  agents: "src/extensions/subagents/index.ts",
  implement: "src/extensions/implement/index.ts",
  papercuts: "src/extensions/papercuts/index.ts",
  btw: "src/extensions/btw/index.ts",
};
const expectedOptionalCommands = {
  mcp: "src/extensions/mcp/index.ts",
  "mcp-auth": "src/extensions/mcp/index.ts",
};

const expectedMessageRenderers = {
  btw: "src/extensions/btw/index.ts",
};
const expectedEntryRenderers = {
  "pipkin.context.epoch.v1": "src/extensions/context/index.ts",
  "pipkin.implement.terminal-handoff": "src/extensions/implement/index.ts",
};

const safetyPaths = [
  "src/extensions/sandbox/index.ts",
  "src/extensions/readonly/index.ts",
];
const managedGlobalSymbols = [
  Symbol.for("pipkin:sandbox:runtime"),
  Symbol.for("pipkin:sandbox:bash"),
  Symbol.for("pipkin:subagents:manager"),
  Symbol.for("pipkin:lsp:pool"),
  Symbol.for("pipkin:lsp:unavailable-warnings"),
];
const runtimeManagerKey = Symbol.for("pipkin:subagents:manager");

type BundleFixture = {
  agentDir: string;
  eventBus: ReturnType<typeof createEventBus>;
  runtimeListenerCount: () => number;
  loader: DefaultResourceLoader;
  result: LoadExtensionsResult;
  dispose: () => Promise<void>;
};

type GlobalSymbolState = {
  symbol: symbol;
  exists: boolean;
  value: unknown;
};

const fixtures: BundleFixture[] = [];

afterEach(async () => {
  while (fixtures.length > 0) {
    await fixtures.pop()?.dispose();
  }
});

function getConfigPath(agentDir: string): string {
  return join(agentDir, "pipkin", "config.json");
}

function snapshotGlobalSymbols(): GlobalSymbolState[] {
  const globalScope = globalThis as Record<symbol, unknown>;
  return managedGlobalSymbols.map((symbol) => ({
    symbol,
    exists: Object.hasOwn(globalScope, symbol),
    value: globalScope[symbol],
  }));
}

async function disposeRuntimeFor(eventBus: ReturnType<typeof createEventBus>) {
  const manager = (globalThis as Record<symbol, unknown>)[runtimeManagerKey] as
    | {
        coordinators?: WeakMap<
          object,
          { runtime?: { dispose?: () => Promise<void> } }
        >;
      }
    | undefined;
  await manager?.coordinators?.get(eventBus)?.runtime?.dispose?.();
}

function restoreGlobalSymbols(states: readonly GlobalSymbolState[]): void {
  const globalScope = globalThis as Record<symbol, unknown>;
  for (const { symbol, exists, value } of states) {
    if (exists) {
      globalScope[symbol] = value;
    } else {
      delete globalScope[symbol];
    }
  }
}

async function loadBundle(
  mcp?: Record<string, { url: string }>,
): Promise<BundleFixture> {
  const agentDir = mkdtempSync(join(tmpdir(), "pipkin-bundle-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const exitListeners = new Set(process.listeners("exit"));
  const globals = snapshotGlobalSymbols();
  const eventBus = createEventBus();
  const adapterRuntimeEvents = new Set([
    "pi-mcp-adapter:runtime-register:v1",
    "pi-mcp-adapter:runtime-snapshot:v1",
  ]);
  let runtimeListenerCount = 0;
  const on = eventBus.on.bind(eventBus);
  eventBus.on = ((channel, handler) => {
    const unsubscribe = on(channel, handler);
    if (!adapterRuntimeEvents.has(channel)) {
      return unsubscribe;
    }
    runtimeListenerCount += 1;
    let active = true;
    return () => {
      if (active) {
        active = false;
        runtimeListenerCount -= 1;
      }
      unsubscribe();
    };
  }) as typeof eventBus.on;
  const configPath = getConfigPath(agentDir);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({
      models: {
        utility: { model: "openai/gpt-4o", thinking: "off" },
        low: { model: "openai/gpt-4o", thinking: "low" },
        medium: { model: "openai/gpt-4o", thinking: "medium" },
        high: { model: "openai/gpt-4o", thinking: "high" },
      },
      nickname: "Pipkin",
      ...(mcp ? { mcp } : {}),
    }),
    { encoding: "utf8", flush: true },
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const dispose = async () => {
    await disposeRuntimeFor(eventBus);
    eventBus.clear();
    for (const listener of process.listeners("exit")) {
      if (!exitListeners.has(listener)) {
        process.removeListener("exit", listener);
      }
    }
    restoreGlobalSymbols(globals);
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    rmSync(agentDir, { force: true, recursive: true });
  };

  try {
    const loader = new DefaultResourceLoader({
      cwd: ROOT,
      agentDir,
      eventBus,
      settingsManager: SettingsManager.inMemory(),
      additionalExtensionPaths: [ROOT],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const fixture = {
      agentDir,
      eventBus,
      runtimeListenerCount: () => runtimeListenerCount,
      loader,
      result: loader.getExtensions(),
      dispose,
    };
    fixtures.push(fixture);
    return fixture;
  } catch (error) {
    await dispose();
    throw error;
  }
}

function relativeExtensionPath(extension: Extension): string {
  return relative(ROOT, extension.resolvedPath);
}

function ownerMap(
  extensions: readonly Extension[],
  key: "messageRenderers" | "entryRenderers",
): Record<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const extension of extensions) {
    for (const name of extension[key]?.keys() ?? []) {
      const entries = owners.get(name) ?? [];
      entries.push(relativeExtensionPath(extension));
      owners.set(name, entries);
    }
  }
  return Object.fromEntries(
    [...owners.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
}

function provenanceMap(
  extensions: readonly Extension[],
  key: "tools" | "commands",
): Record<string, string[]> {
  const sources = new Map<string, string[]>();
  for (const extension of extensions) {
    for (const [name, registration] of extension[key]) {
      const entries = sources.get(name) ?? [];
      entries.push(relative(ROOT, registration.sourceInfo.path));
      sources.set(name, entries);
    }
  }
  return Object.fromEntries(
    [...sources.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
}

function expectedProvenance(
  expected: Record<string, string>,
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(expected)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, owner]) => [name, [owner]]),
  );
}

function safetyExtensions(result: LoadExtensionsResult): Extension[] {
  return result.extensions.filter((extension) =>
    safetyPaths.includes(relativeExtensionPath(extension)),
  );
}

async function createBundleRunner(
  fixture: BundleFixture,
  extensions: Extension[],
  reason: "startup" | "reload" = "startup",
): Promise<{
  runner: ExtensionRunner;
  extensions: Extension[];
  errors: string[];
}> {
  const modelRuntime = await ModelRuntime.create({
    authPath: join(fixture.agentDir, "auth.json"),
    modelsPath: join(fixture.agentDir, "models.json"),
  });
  const runner = new ExtensionRunner(
    extensions,
    fixture.result.runtime,
    ROOT,
    SessionManager.inMemory(ROOT),
    new ModelRegistry(modelRuntime),
  );
  const errors: string[] = [];
  runner.onError((error) =>
    errors.push(`${error.extensionPath}: ${error.error}`),
  );
  runner.bindCore(
    {
      sendMessage: () => {},
      sendUserMessage: () => {},
      appendEntry: () => {},
      setSessionName: () => {},
      getSessionName: () => undefined,
      setLabel: () => {},
      getActiveTools: () => [],
      getAllTools: () => [],
      setActiveTools: () => {},
      refreshTools: () => {},
      getCommands: () => [],
      setModel: async () => false,
      getThinkingLevel: () => "off",
      setThinkingLevel: () => {},
    },
    {
      getModel: () => undefined,
      getScopedModels: () => [],
      isIdle: () => true,
      isProjectTrusted: () => true,
      getSignal: () => undefined,
      abort: () => {},
      hasPendingMessages: () => false,
      shutdown: () => {},
      getContextUsage: () => undefined,
      compact: () => {},
      getSystemPrompt: () => "",
    },
  );
  await runner.emit({ type: "session_start", reason });
  return { runner, extensions, errors };
}

async function createSafetyRunner(
  fixture: BundleFixture,
  reason: "startup" | "reload",
): Promise<{
  runner: ExtensionRunner;
  extensions: Extension[];
  errors: string[];
}> {
  const extensions = safetyExtensions(fixture.result);
  expect(extensions.map(relativeExtensionPath)).toEqual(safetyPaths);
  return createBundleRunner(fixture, extensions, reason);
}

async function assertSafetyOrder(
  fixture: BundleFixture,
  reason: "startup" | "reload",
): Promise<void> {
  const { runner, extensions, errors } = await createSafetyRunner(
    fixture,
    reason,
  );
  const calls: string[] = [];

  for (const extension of extensions) {
    const handlers = extension.handlers.get("tool_call");
    expect(handlers).toBeDefined();
    extension.handlers.set(
      "tool_call",
      handlers?.map((handler) => async (...args: unknown[]) => {
        calls.push(relativeExtensionPath(extension));
        return handler(...args);
      }) ?? [],
    );
  }

  await runner.emitToolCall({
    type: "tool_call",
    toolCallId: `safety-order-${reason}`,
    toolName: "pipkin_bundle_probe",
    input: {},
  });
  expect(calls).toEqual(safetyPaths);
  await runner.emit({ type: "session_shutdown", reason: "reload" });
  expect(errors).toEqual([]);
}

const ignoredProjectDirectories = new Set([
  join(ROOT, ".git"),
  join(ROOT, ".pi"),
  join(ROOT, "node_modules"),
  join(ROOT, "tmp"),
]);

function projectFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return ignoredProjectDirectories.has(path) ? [] : projectFiles(path);
    }
    return [path];
  });
}

describe("Pipkin bundle", () => {
  it("loads the fixed manifest inventory through Pi's package loader", async () => {
    const previousDirectTools = process.env.MCP_DIRECT_TOOLS;
    process.env.MCP_DIRECT_TOOLS = "ambient-server";
    try {
      const fixture = await loadBundle();

      expect(manifest.pi.extensions).toEqual(expectedExtensions);
      expect(fixture.result.errors).toEqual([]);
      expect(fixture.result.extensions.map(relativeExtensionPath)).toEqual(
        expectedExtensionPaths,
      );
      expect(
        new Set(fixture.result.extensions.map(relativeExtensionPath)).size,
      ).toBe(expectedExtensions.length);
      expect(process.env.MCP_DIRECT_TOOLS).toBe("ambient-server");
      for (const extension of fixture.result.extensions) {
        expect(relative(ROOT, extension.sourceInfo.path)).toBe(
          relativeExtensionPath(extension),
        );
      }
    } finally {
      if (previousDirectTools === undefined) {
        delete process.env.MCP_DIRECT_TOOLS;
      } else {
        process.env.MCP_DIRECT_TOOLS = previousDirectTools;
      }
    }
  });

  it("contains configured MCP and keeps first-run lazy servers offline", async () => {
    const previousDirectTools = process.env.MCP_DIRECT_TOOLS;
    process.env.MCP_DIRECT_TOOLS = "inert";
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(503).end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("inert MCP server did not bind a TCP port");
    }
    const ambientProjectMcpPath = join(ROOT, ".mcp.json");
    const ambientProjectMcpBefore = existsSync(ambientProjectMcpPath)
      ? readFileSync(ambientProjectMcpPath, "utf8")
      : undefined;
    writeFileSync(
      ambientProjectMcpPath,
      JSON.stringify({
        mcpServers: { ambient: { url: "http://127.0.0.1:9/ambient" } },
      }),
      "utf8",
    );

    try {
      const fixture = await loadBundle({
        inert: { url: `http://127.0.0.1:${address.port}/mcp` },
      });
      const mcp = fixture.result.extensions.find(
        (extension) =>
          relativeExtensionPath(extension) === "src/extensions/mcp/index.ts",
      );
      expect(provenanceMap(fixture.result.extensions, "tools")).toEqual(
        expectedProvenance({ ...expectedTools, ...expectedOptionalTools }),
      );
      expect(provenanceMap(fixture.result.extensions, "commands")).toEqual(
        expectedProvenance({
          ...expectedCommands,
          ...expectedOptionalCommands,
        }),
      );
      expect(mcp?.tools.has("mcp_script")).toBe(false);
      expect(mcp?.commands.has("pi-mcp")).toBe(false);
      expect(mcp?.flags.has("mcp-config")).toBe(false);
      for (const name of Object.keys(expectedOptionalTools)) {
        const definition = mcp?.tools.get(name)?.definition;
        expect(definition?.renderResult).toBeTypeOf("function");
        expect(undocumentedSchemaProperties(definition?.parameters)).toEqual(
          [],
        );
        expect(definition?.promptSnippet).toBeUndefined();
        expect(definition?.promptGuidelines).toBeUndefined();
      }
      expect(mcp?.tools.get("mcpScript")?.definition.description).not.toMatch(
        /skill/i,
      );
      expect(process.env.MCP_DIRECT_TOOLS).toBe("__none__");
      expect(fixture.runtimeListenerCount()).toBe(2);
      expect(
        readFileSync(join(fixture.agentDir, "mcp-cache.json"), "utf8"),
      ).toBe('{"version":1,"servers":{}}');

      const statusSnapshots: unknown[] = [];
      const shutdownListenerCounts: number[] = [];
      const unsubscribe = fixture.eventBus.on(
        "pi-mcp-adapter/status/v1",
        (snapshot) => {
          statusSnapshots.push(snapshot);
          if (
            typeof snapshot === "object" &&
            snapshot !== null &&
            "servers" in snapshot &&
            Array.isArray(snapshot.servers) &&
            snapshot.servers.length === 0
          ) {
            shutdownListenerCounts.push(fixture.runtimeListenerCount());
          }
        },
      );
      const { runner, errors } = await createBundleRunner(
        fixture,
        fixture.result.extensions,
      );
      await vi.waitFor(() => expect(statusSnapshots).not.toEqual([]));
      expect(statusSnapshots).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            servers: [
              expect.objectContaining({
                name: "inert",
                status: "not-connected",
              }),
            ],
          }),
        ]),
      );
      expect(requests).toBe(0);

      const commandNotifications: string[] = [];
      const commandContext = {
        hasUI: true,
        mode: "print",
        cwd: ROOT,
        ui: { notify: (message: string) => commandNotifications.push(message) },
      };
      const mcpCommand = mcp?.commands.get("mcp");
      const mcpAuthCommand = mcp?.commands.get("mcp-auth");
      expect(mcpCommand).toBeDefined();
      expect(mcpAuthCommand).toBeDefined();
      await mcpCommand!.handler("status", commandContext as never);
      await mcpCommand!.handler("setup", commandContext as never);
      await mcpCommand!.handler("disable inert", commandContext as never);
      await mcpCommand!.handler("enable inert", commandContext as never);
      await mcpAuthCommand!.handler("", commandContext as never);
      expect(commandNotifications.join("\n")).toContain("inert");
      expect(commandNotifications.join("\n")).not.toContain("ambient");
      expect(commandNotifications).toEqual(
        expect.arrayContaining([
          expect.stringContaining("MCP setup is unavailable"),
          expect.stringContaining("/mcp disable is unavailable"),
          expect.stringContaining("/mcp enable is unavailable"),
          expect.stringContaining("Use /mcp-auth <server>"),
        ]),
      );

      const mcpTool = runner
        .getAllRegisteredTools()
        .find(({ definition }) => definition.name === "mcp")?.definition;
      expect(mcpTool).toBeDefined();
      await expect(
        mcpTool!.execute(
          "mcp-connect-inert",
          { connect: "inert" },
          undefined,
          undefined,
          {} as never,
        ),
      ).resolves.toBeDefined();
      await vi.waitFor(() => expect(requests).toBeGreaterThan(0));
      const lsp = runner
        .getAllRegisteredTools()
        .find(({ definition }) => definition.name === "lsp")?.definition;
      await expect(
        lsp!.execute(
          "after-mcp-failure",
          { request: { action: "status" } },
          undefined,
          undefined,
          { cwd: ROOT, ui: {} } as never,
        ),
      ).resolves.toMatchObject({
        details: expect.objectContaining({ action: "status" }),
      });
      expect(errors).toEqual([]);
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      expect(shutdownListenerCounts).toEqual([2, 2]);
      expect(fixture.runtimeListenerCount()).toBe(0);

      const staleSnapshot: {
        version: number;
        name: string;
        result?: unknown;
      } = { version: 1, name: "inert" };
      const staleRegistration: {
        version: number;
        name: string;
        definition: { url: string };
        result?: unknown;
      } = {
        version: 1,
        name: "stale",
        definition: { url: "http://127.0.0.1:9/stale" },
      };
      fixture.eventBus.emit(
        "pi-mcp-adapter:runtime-snapshot:v1",
        staleSnapshot,
      );
      fixture.eventBus.emit(
        "pi-mcp-adapter:runtime-register:v1",
        staleRegistration,
      );
      expect(staleSnapshot.result).toBeUndefined();
      expect(staleRegistration.result).toBeUndefined();

      await fixture.loader.reload();
      fixture.result = fixture.loader.getExtensions();
      expect(fixture.result.errors).toEqual([]);
      expect(fixture.runtimeListenerCount()).toBe(2);
      const replacementRequest: {
        version: number;
        name: string;
        result?: unknown;
      } = { version: 1, name: "inert" };
      fixture.eventBus.emit(
        "pi-mcp-adapter:runtime-snapshot:v1",
        replacementRequest,
      );
      expect(replacementRequest.result).toBeDefined();

      const replacement = await createBundleRunner(
        fixture,
        fixture.result.extensions,
        "reload",
      );
      await replacement.runner.emit({
        type: "session_shutdown",
        reason: "reload",
      });
      expect(shutdownListenerCounts).toEqual([2, 2, 2, 2]);
      expect(fixture.runtimeListenerCount()).toBe(0);
      unsubscribe();
      const replacementStaleSnapshot: {
        version: number;
        name: string;
        result?: unknown;
      } = { version: 1, name: "inert" };
      const replacementStaleRegistration: {
        version: number;
        name: string;
        definition: { url: string };
        result?: unknown;
      } = {
        version: 1,
        name: "stale",
        definition: { url: "http://127.0.0.1:9/stale" },
      };
      fixture.eventBus.emit(
        "pi-mcp-adapter:runtime-snapshot:v1",
        replacementStaleSnapshot,
      );
      fixture.eventBus.emit(
        "pi-mcp-adapter:runtime-register:v1",
        replacementStaleRegistration,
      );
      expect(replacementStaleSnapshot.result).toBeUndefined();
      expect(replacementStaleRegistration.result).toBeUndefined();
      expect(replacement.errors).toEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      if (ambientProjectMcpBefore === undefined) {
        rmSync(ambientProjectMcpPath, { force: true });
      } else {
        writeFileSync(ambientProjectMcpPath, ambientProjectMcpBefore, "utf8");
      }
      if (previousDirectTools === undefined) {
        delete process.env.MCP_DIRECT_TOOLS;
      } else {
        process.env.MCP_DIRECT_TOOLS = previousDirectTools;
      }
    }
  });

  it("assigns every factory-time public registration to its expected feature", async () => {
    const fixture = await loadBundle();

    const tools = provenanceMap(fixture.result.extensions, "tools");
    expect(tools).toEqual(expectedProvenance(expectedTools));
    expect(PUBLIC_TOOL_CATALOGUE.map((entry) => entry.name).sort()).toEqual(
      [
        ...Object.keys(expectedTools),
        ...Object.keys(expectedOptionalTools),
      ].sort(),
    );
    expect(tools).not.toHaveProperty("propose_papercut");
    expect(tools.record_papercut).toEqual([
      "src/extensions/papercuts/index.ts",
    ]);
    expect(provenanceMap(fixture.result.extensions, "commands")).toEqual(
      expectedProvenance(expectedCommands),
    );
    expect(ownerMap(fixture.result.extensions, "messageRenderers")).toEqual(
      expectedProvenance(expectedMessageRenderers),
    );
    expect(ownerMap(fixture.result.extensions, "entryRenderers")).toEqual(
      expectedProvenance(expectedEntryRenderers),
    );
    const context = fixture.result.extensions.find(
      (extension) =>
        relativeExtensionPath(extension) === "src/extensions/context/index.ts",
    );
    expect(
      context?.tools.get("bash_outcome")?.definition.renderCall,
    ).toBeTypeOf("function");
    expect(
      context?.tools.get("bash_outcome")?.definition.renderResult,
    ).toBeTypeOf("function");
    expect(
      context?.tools.get("context_recall")?.definition.renderCall,
    ).toBeTypeOf("function");
    expect(
      context?.tools.get("context_recall")?.definition.renderResult,
    ).toBeTypeOf("function");
    expect(
      context?.tools.get("bash_outcome")?.definition.renderShell,
    ).toBeUndefined();
    expect(
      context?.tools.get("context_recall")?.definition.renderShell,
    ).toBeUndefined();
    const subagents = fixture.result.extensions.find(
      (extension) =>
        relativeExtensionPath(extension) ===
        "src/extensions/subagents/index.ts",
    );
    const agent = subagents?.tools.get("Agent")?.definition;
    const agentParameters = JSON.parse(JSON.stringify(agent?.parameters));
    expect(agent?.description).toContain("return its ID immediately");
    expect(agentParameters.properties.mode).toBeUndefined();
    expect(agentParameters.properties.subagent_type.enum).toEqual([
      "Explore",
      "Review",
    ]);
    expect(
      subagents?.tools.get("get_subagent_result")?.definition.description,
    ).toContain("managed subagent");
    expect(
      subagents?.tools.get("steer_subagent")?.definition.description,
    ).toContain("running managed subagent");
    const web = fixture.result.extensions.find(
      (extension) =>
        relativeExtensionPath(extension) === "src/extensions/web/index.ts",
    );
    const browser = fixture.result.extensions.find(
      (extension) =>
        relativeExtensionPath(extension) === "src/extensions/browser/index.ts",
    );
    expect(
      browser?.tools.get("browser_observe")?.definition.renderCall,
    ).toBeTypeOf("function");
    expect(
      browser?.tools.get("browser_act")?.definition.renderResult,
    ).toBeTypeOf("function");
    const browserAct = JSON.parse(
      JSON.stringify(browser?.tools.get("browser_act")?.definition.parameters),
    );
    const browserActions = browserAct.properties.request.anyOf;
    expect(
      browserActions.flatMap(
        (branch: {
          properties: { action: { const?: string; enum?: string[] } };
        }) =>
          branch.properties.action.const
            ? [branch.properties.action.const]
            : (branch.properties.action.enum ?? []),
      ),
    ).toEqual([
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
    ]);
    const waitAction = browserActions.find(
      (branch: { properties: { action: { const?: string } } }) =>
        branch.properties.action.const === "wait",
    );
    expect(
      waitAction.properties.condition.anyOf.map(
        (branch: { properties: { kind: { const: string } } }) =>
          branch.properties.kind.const,
      ),
    ).toEqual(["url", "text", "target", "load_state"]);
    expect(JSON.stringify(browserAct).length).toBeLessThan(24_000);
    const webFetch = web?.tools.get("web_fetch")?.definition;
    const batchWebFetch = web?.tools.get("batch_web_fetch")?.definition;
    expect(webFetch?.description).toContain("one URL");
    expect(webFetch?.description).toContain("temporary artifacts");
    expect(webFetch?.description).toContain("Set raw");
    expect(webFetch?.description).not.toMatch(/untrusted|not instructions/i);
    expect(batchWebFetch?.description).toContain("one to eight URLs");
    expect(batchWebFetch?.description).toContain("fixed concurrency");
    expect(batchWebFetch?.description).toContain("temporary artifact");
    expect(batchWebFetch?.description).toContain("raw per request");
    expect(batchWebFetch?.description).not.toMatch(
      /untrusted|not instructions/i,
    );
    expect(webFetch?.renderShell).toBeUndefined();
    expect(webFetch?.renderCall).toBeTypeOf("function");
    expect(webFetch?.renderResult).toBeTypeOf("function");
    expect(batchWebFetch?.renderShell).toBeUndefined();
    expect(batchWebFetch?.renderCall).toBeTypeOf("function");
    expect(batchWebFetch?.renderResult).toBeTypeOf("function");
    for (const { name: toolName } of PUBLIC_TOOL_CATALOGUE.filter(({ name }) =>
      Object.hasOwn(expectedTools, name),
    )) {
      const definition = fixture.result.extensions
        .map((extension) => extension.tools.get(toolName)?.definition)
        .find(Boolean);
      expect(definition?.renderCall).toBeTypeOf("function");
      expect(definition?.renderResult).toBeTypeOf("function");
    }
    for (const extension of fixture.result.extensions) {
      for (const { definition } of extension.tools.values()) {
        expect(definition.promptSnippet).toBeUndefined();
        expect(definition.promptGuidelines).toBeUndefined();
      }
    }
    await expect(
      webFetch?.execute(
        "blocked-web-fetch",
        { url: "http://localhost" },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("localhost");
  });

  it("projects registered Browser failures through the tool-result boundary once", async () => {
    const fixture = await loadBundle();
    const browser = fixture.result.extensions.find(
      (extension) =>
        relativeExtensionPath(extension) === "src/extensions/browser/index.ts",
    );
    expect(browser).toBeDefined();
    const { runner, errors } = await createBundleRunner(fixture, [browser!]);
    const definition = runner
      .getAllRegisteredTools()
      .find(({ definition }) => definition.name === "browser_act")?.definition;
    expect(definition).toBeDefined();
    const input = {
      request: { action: "navigate", url: "file:///tmp/not-allowed" },
    };

    await expect(
      definition!.execute(
        "browser-failure",
        input,
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toMatchObject({ category: "target" });

    const event = {
      type: "tool_result" as const,
      toolCallId: "browser-failure",
      toolName: "browser_act",
      input,
      content: [{ type: "text" as const, text: "raw failure" }],
      details: undefined,
      isError: true,
    };
    await expect(runner.emitToolResult(event)).resolves.toMatchObject({
      content: [
        {
          type: "text",
          text: expect.stringContaining("Browser target"),
        },
      ],
      details: { category: "target" },
      isError: true,
    });
    await expect(runner.emitToolResult(event)).resolves.toBeUndefined();
    expect(errors).toEqual([]);
    await runner.emit({ type: "session_shutdown", reason: "quit" });
  });

  it("keeps safety startup and reload handlers ordered and registers Sandbox", async () => {
    const fixture = await loadBundle();
    await assertSafetyOrder(fixture, "startup");
    expect(provenanceMap(safetyExtensions(fixture.result), "tools")).toEqual(
      expectedProvenance({ bash: "src/extensions/sandbox/index.ts" }),
    );
    const bash = safetyExtensions(fixture.result)[0]?.tools.get(
      "bash",
    )?.definition;
    const nativeBash = createBashToolDefinition(ROOT);
    expect(bash).toMatchObject({
      name: nativeBash.name,
      label: nativeBash.label,
      description: nativeBash.description,
      parameters: nativeBash.parameters,
      promptSnippet: nativeBash.promptSnippet,
      promptGuidelines: nativeBash.promptGuidelines,
    });
    expect(PUBLIC_TOOL_EXCEPTIONS.bash).toContain("native Bash");
    expect(PUBLIC_TOOL_EXCEPTIONS.explore).toContain("private");
    expect(PUBLIC_TOOL_EXCEPTIONS.pi_managed_complete).toContain("private");
    expect(provenanceMap(safetyExtensions(fixture.result), "commands")).toEqual(
      expectedProvenance({
        sandbox: "src/extensions/sandbox/index.ts",
        readonly: "src/extensions/readonly/index.ts",
      }),
    );
    await fixture.loader.reload();
    fixture.result = fixture.loader.getExtensions();
    expect(fixture.result.errors).toEqual([]);
    expect(provenanceMap(fixture.result.extensions, "tools")).toEqual(
      expectedProvenance(expectedTools),
    );
    await assertSafetyOrder(fixture, "reload");
  });

  it("covers the complete post-start public surface and its explicit exceptions", async () => {
    const fixture = await loadBundle();
    const { runner, errors } = await createBundleRunner(
      fixture,
      fixture.result.extensions,
    );
    const definitions = runner
      .getAllRegisteredTools()
      .map(({ definition }) => definition);
    const names = definitions.map((definition) => definition.name).sort();

    expect(names).toEqual([...Object.keys(expectedTools), "bash"].sort());
    const catalogueNames = PUBLIC_TOOL_CATALOGUE.map(
      (entry) => entry.name,
    ).sort();
    const rendererExemptions = new Set(["bash"]);
    expect(catalogueNames).toEqual(
      [
        ...Object.keys(expectedTools),
        ...Object.keys(expectedOptionalTools),
      ].sort(),
    );
    expect(PUBLIC_TOOL_EXCEPTIONS).toMatchObject({
      bash: expect.stringContaining("native Bash"),
      explore: expect.stringContaining("private"),
      pi_managed_complete: expect.stringContaining("private"),
    });
    expect(names).not.toEqual(
      expect.arrayContaining(["explore", "pi_managed_complete"]),
    );

    const nativeBash = createBashToolDefinition(ROOT);
    for (const definition of definitions) {
      if (rendererExemptions.has(definition.name)) {
        expect(definition).toMatchObject({
          name: nativeBash.name,
          label: nativeBash.label,
          description: nativeBash.description,
          parameters: nativeBash.parameters,
          promptSnippet: nativeBash.promptSnippet,
          promptGuidelines: nativeBash.promptGuidelines,
        });
        continue;
      }
      expect(catalogueNames).toContain(definition.name);
      expect(definition.renderResult).toBeTypeOf("function");
      expect(
        definition.description?.trim(),
        `${definition.name} description`,
      ).not.toBe("");
      expect(
        undocumentedSchemaProperties(definition.parameters),
        `${definition.name} schema`,
      ).toEqual([]);
      expect(definition.promptSnippet).toBeUndefined();
      expect(definition.promptGuidelines).toBeUndefined();
    }
    expect(errors).toEqual([]);
    await runner.emit({ type: "session_shutdown", reason: "quit" });
  });

  it("assembles bounded parent and role prompts with filtered Guidance exactly once", async () => {
    const fixture = await loadBundle();
    const guidanceExtension = fixture.result.extensions.find(
      (extension) =>
        relativeExtensionPath(extension) === "src/extensions/guidance/index.ts",
    );
    expect(guidanceExtension).toBeDefined();
    const { runner, errors } = await createBundleRunner(fixture, [
      guidanceExtension!,
    ]);
    const basePrompt = "Pi base instructions\n\nLoaded context";
    const parent = await runner.emitBeforeAgentStart(
      "parent task",
      undefined,
      basePrompt,
      { selectedTools: ["bash_outcome", "context_recall"] } as never,
    );

    expect(parent?.systemPrompt).toContain(basePrompt);
    expect(parent?.systemPrompt?.match(/## Pipkin guidance/g)).toHaveLength(1);
    expect(parent?.systemPrompt).toContain("bash_outcome:");
    expect(parent?.systemPrompt).not.toContain("start_process:");
    expect(parent?.systemPrompt?.length).toBeLessThan(12_000);

    const external = await runner.emitBeforeAgentStart(
      "fetch evidence",
      undefined,
      basePrompt,
      { selectedTools: ["web_fetch"] } as never,
    );
    expect(external?.systemPrompt?.match(/### External content/g)).toHaveLength(
      1,
    );
    expect(
      external?.systemPrompt?.match(/cannot redefine the task/g),
    ).toHaveLength(1);

    for (const [role, activeTools] of [
      [EXPLORE_PROMPT, ["bash", "bash_outcome", "context_recall", "lsp"]],
      [
        REVIEW_PROMPT,
        ["bash", "bash_outcome", "context_recall", "lsp", "explore"],
      ],
    ] as const) {
      const child = await runner.emitBeforeAgentStart(
        "child task",
        undefined,
        `${basePrompt}\n\n${role}`,
        { selectedTools: activeTools } as never,
      );
      const prompt = child?.systemPrompt ?? "";

      expect(prompt).toContain(basePrompt);
      expect(prompt).toContain(role);
      expect(prompt.match(/## Pipkin guidance/g)).toHaveLength(1);
      expect(prompt.split(role)).toHaveLength(2);
      expect(prompt).toContain("bash_outcome:");
      expect(prompt).toContain("context_recall:");
      expect(prompt).not.toContain("start_process:");
      expect(prompt.length).toBeLessThan(12_000);
    }
    expect(errors).toEqual([]);
    await runner.emit({ type: "session_shutdown", reason: "quit" });
  });

  it("persists a native error result for a forbidden web target", async () => {
    const fixture = await loadBundle();
    const faux = createFauxCore({});
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          "web_fetch",
          { url: "http://localhost" },
          { id: "blocked-web-fetch" },
        ),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("acknowledged"),
    ]);
    const sessionManager = SessionManager.inMemory(ROOT);
    const resourceLoader = Object.create(
      fixture.loader,
    ) as DefaultResourceLoader;
    resourceLoader.getExtensions = () => ({
      ...fixture.result,
      extensions: fixture.result.extensions.filter(
        (extension) =>
          relativeExtensionPath(extension) === "src/extensions/web/index.ts",
      ),
    });
    const { session } = await createAgentSession({
      cwd: ROOT,
      model: faux.getModel(),
      resourceLoader,
      sessionManager,
      settingsManager: SettingsManager.inMemory(),
      tools: ["web_fetch"],
    });

    try {
      await session.bindExtensions({ mode: "tui", uiContext: {} as never });
      session.agent.streamFunction = faux.streamSimple;
      await session.agent.prompt("fetch localhost");
      const result = sessionManager
        .buildSessionContext()
        .messages.find(
          (message) =>
            message.role === "toolResult" &&
            message.toolCallId === "blocked-web-fetch",
        );

      expect(result).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("localhost") }],
      });
    } finally {
      await (
        session as unknown as { _extensionRunner: ExtensionRunner }
      )._extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
  });

  it("resolves internal modules without mutating Pipkin runtime state", async () => {
    vi.resetModules();
    const before = snapshotGlobalSymbols();
    const [
      { getConfigPath },
      { formatCompactTokens },
      { setPipkinStatus },
      { createActivityPublisher },
      { bindSandboxHost },
      { executeSandboxBash, startSandboxManagedExecution },
      { retainResult, decodeRetainedResult },
      { getSubagentRuntime },
      { MANAGED_COMPLETION_FINAL_ACTION },
      { generateSessionName },
    ] = await Promise.all([
      import("#lib/config"),
      import("#lib/ui/metrics"),
      import("#ui/status"),
      import("#ui/activity"),
      import("#sandbox/runtime"),
      import("#sandbox/bash"),
      import("#context/retained-result"),
      import("#subagents/runtime"),
      import("#subagents/completion"),
      import("#personality/session-name"),
    ]);

    expect(getConfigPath("/tmp/pipkin-agent")).toBe(
      "/tmp/pipkin-agent/pipkin/config.json",
    );
    expect(formatCompactTokens(1_500)).toBe("1.5k");
    expect(setPipkinStatus).toBeTypeOf("function");
    expect(createActivityPublisher).toBeTypeOf("function");
    expect(bindSandboxHost).toBeTypeOf("function");
    expect(executeSandboxBash).toBeTypeOf("function");
    expect(startSandboxManagedExecution).toBeTypeOf("function");
    expect(retainResult).toBeTypeOf("function");
    expect(decodeRetainedResult).toBeTypeOf("function");
    expect(getSubagentRuntime).toBeTypeOf("function");
    expect(MANAGED_COMPLETION_FINAL_ACTION).toBe(
      "Call pi_managed_complete exactly once as your final action after all other required work.",
    );
    expect(generateSessionName).toBeTypeOf("function");
    expect(snapshotGlobalSymbols()).toEqual(before);
  });

  it("keeps Context retained-result ownership side-effect-free and acyclic", () => {
    const retained = readFileSync(
      join(ROOT, "src/extensions/context/retained-result.ts"),
      "utf8",
    );
    const bashOutcome = readFileSync(
      join(ROOT, "src/extensions/context/bash-outcome.ts"),
      "utf8",
    );
    const processTools = readFileSync(
      join(ROOT, "src/extensions/processes/tools.ts"),
      "utf8",
    );
    const sandbox = readFileSync(
      join(ROOT, "src/extensions/sandbox/bash-capability.ts"),
      "utf8",
    );

    expect(retained).not.toMatch(/register|bindSandbox|#sandbox|#processes/);
    expect(bashOutcome).toContain('from "./retained-result.ts"');
    expect(processTools).toContain('from "#context/retained-result"');
    expect(sandbox).not.toContain("#context/retained-result");
    expect(retained).not.toContain("#sandbox/bash");
  });

  it("contains no package-era topology or cross-feature entrypoint imports", () => {
    expect(manifest.workspaces).toBeUndefined();
    expect(JSON.stringify(manifest)).not.toContain("workspace:");
    expect(existsSync(join(ROOT, "packages"))).toBe(false);
    expect(existsSync(join(ROOT, "lib", "src"))).toBe(false);

    const files = projectFiles(ROOT);
    expect(files.filter((path) => path.endsWith("package.json"))).toEqual([
      join(ROOT, "package.json"),
    ]);
    expect(
      files.filter((path) => /vitest\.config\.[cm]?[jt]s$/.test(path)),
    ).toEqual([join(ROOT, "vitest.config.ts")]);

    for (const path of files.filter(
      (candidate) =>
        candidate.startsWith(join(ROOT, "src")) &&
        /\.[cm]?[jt]s$/.test(candidate) &&
        !/\.test\.[cm]?[jt]s$/.test(candidate),
    )) {
      const source = readFileSync(path, "utf8");
      expect(source).not.toMatch(/@pi-extensions\//);
      expect(source).not.toMatch(/pi-subagents\/runtime/);
      expect(source).not.toMatch(
        /(?:from|import)\s*\(?["'][^"']*extensions\/[^"']+\/index(?:\.ts|\.js)?["']/,
      );
    }
  });
});
