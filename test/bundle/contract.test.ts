import {
  AgentSessionRuntime,
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  runPrintMode,
  SessionManager,
  SettingsManager,
  createEventBus,
  type Extension,
  type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  bindSandboxHost as bindSandboxMode,
  prepareSandboxChild,
} from "#sandbox/runtime";
import { createManagedSessionHarness } from "../support/managed-session.ts";
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
import Ajv from "ajv";
import { executeWebFetch } from "../../src/extensions/web/web-fetch.js";
import type { WebFetchInput } from "../../src/extensions/web/schema.js";
import {
  EXPLORE_PROMPT,
  REVIEW_PROMPT,
} from "../../src/extensions/subagents/agent-profiles.js";
import { undocumentedSchemaProperties } from "../support/schema-descriptions.js";
import { Check } from "typebox/value";
import { success } from "../../src/extensions/browser/results.js";
import {
  loadPipkinConfig,
  loadProjectPipkinConfig,
} from "../../src/lib/config.ts";
import {
  expectedCommands,
  expectedExtensions,
  expectedTools,
  privateExposures,
} from "./inventory.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const safetyPaths = [
  "src/extensions/sandbox/index.ts",
  "src/extensions/readonly/index.ts",
];
const managedGlobalSymbols = [
  "pipkin:sandbox:runtime",
  "pipkin:sandbox:bash",
  "pipkin:subagents:manager",
  "pipkin:lsp:pool",
  "pipkin:lsp:unavailable-warnings",
].map(Symbol.for);
const runtimeManagerKey = Symbol.for("pipkin:subagents:manager");

type BundleFixture = {
  agentDir: string;
  cwd: string;
  eventBus: ReturnType<typeof createEventBus>;
  loader: DefaultResourceLoader;
  result: LoadExtensionsResult;
  dispose: () => Promise<void>;
};
const fixtures: BundleFixture[] = [];
afterEach(async () => {
  while (fixtures.length) {
    await fixtures.pop()?.dispose();
  }
});

function snapshotGlobalSymbols() {
  const scope = globalThis as Record<symbol, unknown>;
  return managedGlobalSymbols.map((symbol) => ({
    symbol,
    exists: Object.hasOwn(scope, symbol),
    value: scope[symbol],
  }));
}
async function loadBundle(
  options: {
    nativeFactories?: boolean;
    additionalPaths?: string[];
    mcp?: Record<string, unknown>;
  } = {},
): Promise<BundleFixture> {
  const agentDir = mkdtempSync(join(tmpdir(), "pipkin-bundle-"));
  const cwd = join(agentDir, "workspace");
  mkdirSync(cwd);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const exitListeners = new Set(process.listeners("exit"));
  const globals = snapshotGlobalSymbols();
  const eventBus = createEventBus();
  const configPath = join(agentDir, "pipkin/config.json");
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({
      models: Object.fromEntries(
        ["utility", "low", "medium", "high"].map((tier) => [
          tier,
          { model: "openai/gpt-4o", thinking: "off" },
        ]),
      ),
      nickname: "Pipkin",
    }),
  );
  if (options.mcp) {
    writeFileSync(
      join(agentDir, "mcp.json"),
      JSON.stringify({ mcpServers: options.mcp }),
    );
  }
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const dispose = async () => {
    const manager = (globalThis as Record<symbol, unknown>)[
      runtimeManagerKey
    ] as
      | {
          coordinators?: WeakMap<
            object,
            { runtime?: { dispose?: () => Promise<void> } }
          >;
        }
      | undefined;
    await manager?.coordinators?.get(eventBus)?.runtime?.dispose?.();
    eventBus.clear();
    for (const listener of process.listeners("exit")) {
      if (!exitListeners.has(listener)) {
        process.removeListener("exit", listener);
      }
    }
    const scope = globalThis as Record<symbol, unknown>;
    for (const { symbol, exists, value } of globals) {
      if (exists) {
        scope[symbol] = value;
      } else {
        delete scope[symbol];
      }
    }
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    rmSync(agentDir, { recursive: true, force: true });
  };
  try {
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      eventBus,
      settingsManager: SettingsManager.inMemory(),
      additionalExtensionPaths: [ROOT, ...(options.additionalPaths ?? [])],
      extensionFactories: options.nativeFactories
        ? [
            {
              name: "codemode",
              replaceable: true,
              factory: createCodemodeExtension({ mode: "on" }),
            },
            {
              name: "tool_search",
              replaceable: true,
              factory: createToolSearchExtension(),
            },
            { name: "mcp", replaceable: true, factory: createMcpExtension() },
          ]
        : [],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const fixture = {
      agentDir,
      cwd,
      eventBus,
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
function relativeExtensionPath(extension: Extension) {
  return relative(ROOT, extension.resolvedPath);
}
function provenanceMap(
  extensions: readonly Extension[],
  key: "tools" | "commands" | "messageRenderers" | "entryRenderers",
) {
  const sources = new Map<string, string[]>();
  for (const extension of extensions) {
    if (key === "tools" || key === "commands") {
      for (const [name, registration] of extension[key]) {
        sources.set(name, [
          ...(sources.get(name) ?? []),
          relative(ROOT, registration.sourceInfo.path),
        ]);
      }
    } else {
      for (const name of extension[key]?.keys() ?? []) {
        sources.set(name, [
          ...(sources.get(name) ?? []),
          relativeExtensionPath(extension),
        ]);
      }
    }
  }
  return Object.fromEntries(
    [...sources].sort(([a], [b]) => a.localeCompare(b)),
  );
}
function expectedProvenance(expected: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(expected).map(([name, owner]) => [
      name,
      [`src/extensions/${owner}/index.ts`],
    ]),
  );
}
async function createBundleRunner(
  fixture: BundleFixture,
  extensions = fixture.result.extensions,
  reason: "startup" | "reload" = "startup",
) {
  const modelRuntime = await ModelRuntime.create({
    authPath: join(fixture.agentDir, "auth.json"),
    modelsPath: join(fixture.agentDir, "models.json"),
  });
  const runner = new ExtensionRunner(
    extensions,
    fixture.result.runtime,
    fixture.cwd,
    SessionManager.inMemory(fixture.cwd),
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
      getSettings: () => ({}),
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
  return { runner, errors };
}
async function nativeSession(
  fixture: BundleFixture,
  defaultTools = ["+codemode", "+tool_search"],
  tools?: string[],
  bind = true,
) {
  const { faux, model, modelRuntime } = await createManagedSessionHarness([]);
  const sessionManager = SessionManager.inMemory(fixture.cwd);
  const settingsManager = SettingsManager.inMemory({
    defaultTools,
    codemode: { mode: "on" },
  });
  const { session } = await createAgentSession({
    cwd: fixture.cwd,
    agentDir: fixture.agentDir,
    model,
    modelRuntime,
    resourceLoader: fixture.loader,
    sessionManager,
    settingsManager,
    tools,
  });
  const errors: string[] = [];
  const notices: string[] = [];
  session.extensionRunner.onError((error) => errors.push(error.error));
  if (bind) {
    await session.bindExtensions({
      mode: "print",
      uiContext: {
        notify: (message: string) => notices.push(message),
      } as never,
    });
  }
  session.agent.streamFunction = faux.streamSimple;
  const prompt = async (
    calls: Array<{
      name: string;
      args: Parameters<typeof fauxToolCall>[1];
      id: string;
    }>,
  ) => {
    faux.setResponses([
      ...calls.map(({ name, args, id }) =>
        fauxAssistantMessage(fauxToolCall(name, args, { id }), {
          stopReason: "toolUse",
        }),
      ),
      fauxAssistantMessage("acknowledged"),
    ]);
    await session.prompt("synthetic fixture request");
    return sessionManager
      .buildSessionContext()
      .messages.filter((message) => message.role === "toolResult");
  };
  const dispose = async () => {
    await session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    session.dispose();
  };
  const runPrint = async (mode: "text" | "json") => {
    const runtime = new AgentSessionRuntime(
      session,
      {
        cwd: fixture.cwd,
        agentDir: fixture.agentDir,
        modelRuntime,
        settingsManager,
        resourceLoader: fixture.loader,
        diagnostics: [],
      },
      async () => {
        throw new Error("The print fixture does not replace sessions");
      },
    );
    faux.setResponses([
      fauxAssistantMessage("acknowledged"),
      fauxAssistantMessage("acknowledged"),
    ]);
    return runPrintMode(runtime, { mode, messages: ["first", "second"] });
  };
  return {
    session,
    sessionManager,
    errors,
    notices,
    prompt,
    dispose,
    runPrint,
  };
}

// A stateless local protocol fixture, connected by Pi's real MCP transport.
async function fakeMcpServer() {
  const calls: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    let body = "";
    for await (const chunk of request) {
      body += chunk;
    }
    const rpc = JSON.parse(body);
    if (rpc.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    let result: unknown;
    if (rpc.method === "initialize") {
      result = {
        protocolVersion: rpc.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1" },
      };
    } else if (rpc.method === "tools/list") {
      result = {
        tools: ["echo", "forbidden"].map((name) => ({
          name,
          description: `Fixture ${name}`,
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        })),
      };
    } else if (rpc.method === "tools/call") {
      calls.push(rpc.params.name);
      result = {
        content: [{ type: "text", text: "native MCP fixture called" }],
      };
    } else {
      result = {};
    }
    response
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture failed to bind");
  }
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    calls,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
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
    return entry.isDirectory()
      ? ignoredProjectDirectories.has(path)
        ? []
        : projectFiles(path)
      : [path];
  });
}

describe("Pipkin bundle", () => {
  it("loads the fixed complete manifest inventory with source provenance", async () => {
    const fixture = await loadBundle();
    expect(manifest.pi.extensions).toEqual(expectedExtensions);
    expect(fixture.result.errors).toEqual([]);
    expect(fixture.result.extensions.map(relativeExtensionPath)).toEqual(
      expectedExtensions.map((path) => path.slice(2)),
    );
    for (const extension of fixture.result.extensions) {
      expect(relative(ROOT, extension.sourceInfo.path)).toBe(
        relativeExtensionPath(extension),
      );
    }
    expect(provenanceMap(fixture.result.extensions, "tools")).toEqual(
      expectedProvenance(expectedTools),
    );
    expect(provenanceMap(fixture.result.extensions, "commands")).toEqual(
      expectedProvenance(expectedCommands),
    );
    expect(
      provenanceMap(fixture.result.extensions, "messageRenderers"),
    ).toEqual(expectedProvenance({ btw: "btw" }));
    expect(provenanceMap(fixture.result.extensions, "entryRenderers")).toEqual(
      expectedProvenance({
        "pipkin.context.compaction-failure.v1": "context",
        "pipkin.context.epoch.v1": "context",
        "pipkin.context.pruning.v1": "context",
        "pipkin.implement.terminal-handoff": "implement",
      }),
    );
    const readonly = fixture.result.extensions.find(
      (extension) => relativeExtensionPath(extension) === safetyPaths[1],
    );
    expect([...readonly!.shortcuts.keys()]).toEqual(["ctrl+r"]);
  });

  it("keeps safety startup/reload ordered and Bash directly declared", async () => {
    const fixture = await loadBundle();
    for (const reason of ["startup", "reload"] as const) {
      const safety = fixture.result.extensions.filter((extension) =>
        safetyPaths.includes(relativeExtensionPath(extension)),
      );
      expect(safety.map(relativeExtensionPath)).toEqual(safetyPaths);
      const { runner, errors } = await createBundleRunner(
        fixture,
        safety,
        reason,
      );
      const calls: string[] = [];
      for (const extension of safety) {
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
        toolCallId: `safety-${reason}`,
        toolName: "fixture",
        input: {},
      });
      expect(calls).toEqual(safetyPaths);
      const bash = safety[0]?.tools.get("bash")?.definition;
      expect(bash).toMatchObject({
        name: "bash",
        exposure: "direct",
        namespace: { name: "execution" },
      });
      expect(bash?.parameters).toHaveProperty("properties.presentation");
      expect(bash?.outputSchema).toBeDefined();
      await runner.emit({ type: "session_shutdown", reason: "reload" });
      expect(errors).toEqual([]);
      await fixture.loader.reload();
      fixture.result = fixture.loader.getExtensions();
      expect(fixture.result.errors).toEqual([]);
    }
  });

  it("owns public inventory, descriptions, renderers, and exposure independently of production Guidance", async () => {
    const fixture = await loadBundle();
    const { runner, errors } = await createBundleRunner(fixture);
    const definitions = runner
      .getAllRegisteredTools()
      .map(({ definition }) => definition);
    expect(definitions.map(({ name }) => name).sort()).toEqual(
      [...Object.keys(expectedTools), "bash"].sort(),
    );
    expect(definitions.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining(Object.keys(privateExposures)),
    );
    for (const definition of definitions) {
      expect(definition.namespace?.description?.trim()).toBeTruthy();
      expect(
        undocumentedSchemaProperties(definition.parameters),
        definition.name,
      ).toEqual([]);
      if (definition.name.startsWith("lsp_")) {
        expect(definition.outputSchema, definition.name).toBeDefined();
      }
      if (definition.name === "bash") {
        continue;
      }
      expect(definition.exposure).toBe("deferred");
      expect(definition.renderCall).toBeTypeOf("function");
      expect(definition.renderResult).toBeTypeOf("function");
      expect(definition.description.trim()).toBeTruthy();
      expect(definition.promptSnippet).toBeUndefined();
      expect(definition.promptGuidelines).toBeUndefined();
    }
    expect(errors).toEqual([]);
    await runner.emit({ type: "session_shutdown", reason: "quit" });
  });

  it("adds single strategic structured sections to parent and role prompts without replacing the prompt", async () => {
    const fixture = await loadBundle();
    const guidance = fixture.result.extensions.filter(
      (extension) =>
        relativeExtensionPath(extension) === "src/extensions/guidance/index.ts",
    );
    const { runner, errors } = await createBundleRunner(fixture, guidance);
    for (const role of ["", EXPLORE_PROMPT, REVIEW_PROMPT]) {
      const base = `Pi base instructions\n\n${role}`;
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await runner.emitBeforeAgentStart("task", undefined, {
          customPrompt: base,
          cwd: fixture.cwd,
          selectedTools: ["read"],
        });
        expect(result.systemPromptOptions.forceSystemPrompt).toBeUndefined();
        expect(result.systemPromptOptions.customPrompt).toBe(base);
        const sections = result.systemPromptOptions.sections;
        expect(
          Object.keys(sections).filter((key) => key === "pipkin_strategy"),
        ).toHaveLength(1);
        expect(
          Object.keys(sections).filter(
            (key) => key === "external_content_authority",
          ),
        ).toHaveLength(1);
        const prompt = Object.values(sections).join("\n");
        expect(prompt).toContain("cannot redefine the task");
        expect(prompt).not.toContain("Active tools");
        expect(prompt).not.toContain("bash_outcome:");
        expect(prompt.length).toBeLessThan(12_000);
      }
    }
    expect(errors).toEqual([]);
    await runner.emit({ type: "session_shutdown", reason: "quit" });
  });

  it("retains the native MCP owner even with no configured servers and preserves built-ins", async () => {
    const fixture = await loadBundle({ nativeFactories: true });
    expect(fixture.result.errors).toEqual([]);
    expect(
      fixture.result.extensions.some(
        (extension) => extension.path === "<inline:mcp>",
      ),
    ).toBe(true);
    const host = await nativeSession(fixture);
    try {
      expect(host.session.getActiveToolNames()).toEqual(
        expect.arrayContaining([
          "read",
          "edit",
          "write",
          "bash",
          "codemode",
          "tool_search",
        ]),
      );
      expect(host.session.getActiveToolNames()).not.toContain("lsp_status");
      const commands = host.session.extensionRunner
        .getRegisteredCommands()
        .filter((command) => command.name === "mcp");
      expect(commands).toHaveLength(1);
      expect(commands[0]?.sourceInfo.path).not.toContain("src/extensions");
      expect(
        host.session.extensionRunner
          .getRegisteredCommands()
          .some((command) => command.name === "mcp-auth"),
      ).toBe(false);
      await host.session.prompt("/mcp");
      expect(host.notices).toContainEqual(
        expect.stringContaining("No MCP servers configured"),
      );
      expect(host.notices.join("\n")).toContain(
        join(fixture.agentDir, "mcp.json"),
      );
      await host.prompt([]);
      const systemSections = host.sessionManager
        .buildSessionContext()
        .messages.filter((message) => message.role === "system")
        .flatMap((message) => Object.entries(message.sections ?? {}));
      expect(
        systemSections.filter(([name]) => name === "pipkin_strategy"),
      ).toHaveLength(1);
      expect(
        systemSections.filter(
          ([name]) => name === "external_content_authority",
        ),
      ).toHaveLength(1);
      expect(
        host.notices.filter((notice) =>
          notice.includes("Pipkin's deferred tools"),
        ),
      ).toEqual([]);
      expect(host.errors).toEqual([]);
    } finally {
      await host.dispose();
    }
  });

  it("discovers/activates a deferred tool, invokes it directly, and calls it from native codemode", async () => {
    const fixture = await loadBundle({ nativeFactories: true });
    const host = await nativeSession(fixture);
    try {
      expect(host.session.getActiveToolNames()).not.toContain("lsp_status");
      expect(
        host.session.extensionRunner
          .getAllRegisteredTools()
          .some(({ definition }) => definition.name === "lsp"),
      ).toBe(false);
      const results = await host.prompt([
        {
          name: "codemode",
          args: {
            code: 'text(await tools.lsp_status({})); text(await tools.lsp_definition({file:"missing.ts",position:{line:1,column:1}}));',
          },
          id: "nested",
        },
        {
          name: "tool_search",
          args: { query: "+lsp_status +lsp_definition" },
          id: "search",
        },
        { name: "lsp_status", args: {}, id: "direct" },
        {
          name: "lsp_definition",
          args: { file: "missing.ts", position: { line: 1, column: 1 } },
          id: "rejected",
        },
      ]);
      expect(host.session.getActiveToolNames()).toContain("lsp_status");
      const rejected = results.find(
        (result) => result.toolCallId === "rejected",
      );
      expect(rejected).toMatchObject({ isError: true });
      expect(rejected?.content).toEqual([
        { type: "text", text: expect.stringContaining('"not_found"') },
      ]);
      expect(
        JSON.stringify(
          results.find((result) => result.toolCallId === "nested")?.content,
        ),
      ).toContain("not_found");
      expect(
        results.find((result) => result.toolCallId === "direct"),
      ).toMatchObject({ isError: false });
      expect(
        results.find((result) => result.toolCallId === "nested"),
      ).toMatchObject({
        isError: false,
        nestedCalls: {
          calls: [
            expect.objectContaining({ name: "lsp_status", status: "ok" }),
            expect.objectContaining({
              name: "lsp_definition",
              status: "error",
            }),
          ],
        },
      });
      expect(host.errors).toEqual([]);
    } finally {
      await host.dispose();
    }
  });

  it("recovers Bash evidence and a process accepted by a codemode script that later throws", async () => {
    const fixture = await loadBundle({ nativeFactories: true });
    const parent = createEventBus();
    const mode = bindSandboxMode(parent, () => false);
    const pending = prepareSandboxChild(parent, fixture.eventBus);
    const host = await nativeSession(fixture);
    try {
      const results = await host.prompt([
        {
          name: "codemode",
          id: "lost-script",
          args: {
            code: `
          const failed = await tools.bash({command:"printf nested-failure; exit 9", presentation:"status"});
          if (failed.ok || failed.execution.exitCode !== 9 || !failed.output.includes("nested-failure")) throw new Error("bad failure data");
          await tools.process_start({command:"printf lost-process",description:"recover lost job"});
          throw new Error("enclosing script failed");
        `,
          },
        },
        {
          name: "codemode",
          id: "recover-script",
          args: {
            code: `
          const jobs = await tools.process_list({});
          if (!jobs.ok || jobs.processes.length !== 1) throw new Error("lost process");
          const job = await tools.process_wait({id:jobs.processes[0].id});
          if (!job.ok || !job.output.includes("lost-process")) throw new Error("lost job output");
          const outputs = await tools.output_list({});
          if (!outputs.ok || outputs.outputs.length !== 2) throw new Error("lost or duplicated captures");
          const failed = outputs.outputs.find(output=>output.sourceTool === "bash");
          const evidence = await tools.read_output({reference:failed.reference});
          if (!evidence.ok || evidence.source.execution.state !== "failed" || evidence.source.execution.exitCode !== 9 || !evidence.content[0].text.includes("nested-failure")) throw new Error("lost failure evidence");
          text("recovered immutable evidence without rerunning");
        `,
          },
        },
      ]);
      expect(
        results.find((result) => result.toolCallId === "lost-script"),
      ).toMatchObject({
        isError: true,
        content: expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining("enclosing script failed"),
          }),
        ]),
      });
      expect(
        results.find((result) => result.toolCallId === "recover-script"),
      ).toMatchObject({
        isError: false,
        content: expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining("recovered immutable evidence"),
          }),
        ]),
      });
      expect(host.errors).toEqual([]);
    } finally {
      await host.dispose();
      pending?.dispose();
      mode.dispose();
    }
  });

  it("uses native MCP discovery and denies hidden or SDK-forbidden tools after dynamic registration", async () => {
    const server = await fakeMcpServer();
    const fixture = await loadBundle({
      nativeFactories: true,
      mcp: {
        fixture: {
          url: server.url,
          exposure: "deferred",
          toolExposure: { forbidden: "hidden" },
        },
      },
    });
    const host = await nativeSession(
      fixture,
      ["+codemode", "+tool_search"],
      [
        "read",
        "bash",
        "codemode",
        "tool_search",
        "lsp_status",
        "mcp__fixture__echo",
        "mcp__fixture__forbidden",
      ],
    );
    try {
      const results = await host.prompt([
        {
          name: "tool_search",
          args: { query: "+mcp__fixture__echo" },
          id: "mcp-search",
        },
        { name: "mcp__fixture__echo", args: {}, id: "mcp-direct" },
        {
          name: "codemode",
          args: {
            code: "text(await tools.mcp__fixture__echo({})); text(ALL_TOOLS.map(t=>t.name));",
          },
          id: "mcp-nested",
        },
        {
          name: "codemode",
          args: { code: "await tools.mcp__fixture__forbidden({});" },
          id: "hidden",
        },
        {
          name: "codemode",
          args: { code: "await tools.record_papercut({});" },
          id: "excluded",
        },
      ]);
      expect(
        results.find((result) => result.toolCallId === "mcp-direct"),
      ).toMatchObject({
        isError: false,
        content: [{ type: "text", text: "native MCP fixture called" }],
      });
      expect(
        results.find((result) => result.toolCallId === "mcp-nested"),
      ).toMatchObject({ isError: false });
      for (const id of ["hidden", "excluded"]) {
        expect(
          results.find((result) => result.toolCallId === id),
        ).toMatchObject({ isError: true });
      }
      expect(server.calls).toEqual(["echo", "echo"]);
      expect(host.errors).toEqual([]);
    } finally {
      await host.dispose();
      await server.close();
    }
  });

  it("reports retired configuration by scope without losing valid settings or changing files", async () => {
    const fixture = await loadBundle({ nativeFactories: true });
    const globalPath = join(fixture.agentDir, "pipkin/config.json");
    const projectPath = join(fixture.cwd, ".pi/pipkin/config.json");
    const global = {
      ...JSON.parse(readFileSync(globalPath, "utf8")),
      implement: { workerConcurrency: 5 },
      sandbox: { writable: [] },
      mcp: {},
    };
    const project = {
      sandbox: { writable: ["./generated"] },
      mcp: { old: {} },
    };
    mkdirSync(dirname(projectPath), { recursive: true });
    writeFileSync(globalPath, JSON.stringify(global));
    writeFileSync(projectPath, JSON.stringify(project));
    const before = [globalPath, projectPath].map((path) =>
      readFileSync(path, "utf8"),
    );
    const host = await nativeSession(fixture);
    try {
      const warnings = host.notices.filter((notice) =>
        notice.startsWith("Pipkin configuration:"),
      );
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain("global mcp is retired");
      expect(warnings[1]).toContain("project mcp is retired");
      for (const warning of warnings) {
        expect(warning).toContain("mcp.json");
        expect(warning).toContain("/mcp");
      }
      await host.prompt([]);
      expect(
        host.notices.filter((notice) =>
          notice.startsWith("Pipkin configuration:"),
        ),
      ).toEqual(warnings);
      const { mcp: _retiredGlobal, ...validGlobal } = global;
      expect(loadPipkinConfig(fixture.agentDir).config).toEqual(validGlobal);
      expect(loadProjectPipkinConfig(fixture.cwd).config).toEqual({
        sandbox: project.sandbox,
      });
      expect(
        [globalPath, projectPath].map((path) => readFileSync(path, "utf8")),
      ).toEqual(before);
      expect(host.errors).toEqual([]);
    } finally {
      await host.dispose();
    }
  });

  it.each(["text", "json"] as const)(
    "reports setup once through normal %s bindings without polluting stdout",
    async (mode) => {
      const fixture = await loadBundle({ nativeFactories: true });
      const configPath = join(fixture.agentDir, "pipkin/config.json");
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      writeFileSync(
        configPath,
        JSON.stringify({ ...config, mcp: mode === "text" ? {} : { old: {} } }),
      );
      const unchangedPaths = [
        configPath,
        join(fixture.agentDir, "mcp.json"),
        join(fixture.agentDir, "mcp-auth.json"),
        join(fixture.agentDir, "pipkin/auth.json"),
        join(fixture.agentDir, "settings.json"),
      ];
      writeFileSync(unchangedPaths[1]!, JSON.stringify({ mcpServers: {} }));
      for (const path of unchangedPaths.slice(2)) {
        writeFileSync(path, "{}");
      }
      const before = unchangedPaths.map((path) => readFileSync(path, "utf8"));
      const host = await nativeSession(
        fixture,
        ["read", "bash"],
        undefined,
        false,
      );
      let stdout = "";
      let stderr = "";
      const out = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk, encodingOrCallback, callback) => {
          stdout += String(chunk);
          const done =
            typeof encodingOrCallback === "function"
              ? encodingOrCallback
              : callback;
          done?.();
          return true;
        });
      const err = vi
        .spyOn(process.stderr, "write")
        .mockImplementation((chunk) => {
          stderr += String(chunk);
          return true;
        });
      try {
        expect(await host.runPrint(mode)).toBe(0);
        expect(
          stderr
            .split("\n")
            .filter((line) => line.includes("Pipkin's deferred tools")),
        ).toHaveLength(1);
        expect(stderr).toContain('"defaultTools":["+codemode","+tool_search"]');
        expect(
          stderr
            .split("\n")
            .filter((line) => line.includes("global mcp is retired")),
        ).toHaveLength(1);
        expect(stderr).toContain("mcp.json");
        expect(stderr).toContain("/mcp");
        if (mode === "json") {
          const events = stdout
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          expect(events[0].type).toBe("session");
          expect(events.some((event) => event.type === "agent_settled")).toBe(
            true,
          );
        } else {
          expect(stdout).toBe("acknowledged\n");
        }
        expect(stdout).not.toContain("Pipkin's deferred tools");
        expect(host.errors).toEqual([]);
        expect(
          unchangedPaths.map((path) => readFileSync(path, "utf8")),
        ).toEqual(before);
      } finally {
        out.mockRestore();
        err.mockRestore();
      }
    },
  );

  it("leaves enabled headless discovery silent and does not inspect untrusted project configuration", async () => {
    const fixture = await loadBundle({ nativeFactories: true });
    const projectPath = join(fixture.cwd, ".pi/pipkin/config.json");
    mkdirSync(dirname(projectPath), { recursive: true });
    writeFileSync(projectPath, JSON.stringify({ mcp: {} }));
    const host = await nativeSession(fixture, undefined, undefined, false);
    host.session.settingsManager.setProjectTrusted(false);
    const err = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const out = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((_chunk, encodingOrCallback, callback) => {
        const done =
          typeof encodingOrCallback === "function"
            ? encodingOrCallback
            : callback;
        done?.();
        return true;
      });
    try {
      expect(await host.runPrint("json")).toBe(0);
      expect(err).not.toHaveBeenCalled();
      expect(host.errors).toEqual([]);
      expect(readFileSync(projectPath, "utf8")).toBe(
        JSON.stringify({ mcp: {} }),
      );
    } finally {
      err.mockRestore();
      out.mockRestore();
    }
  });

  it("warns once when no native servers are configured and both discovery paths are absent", async () => {
    const fixture = await loadBundle({ nativeFactories: true });
    const host = await nativeSession(fixture, [
      "read",
      "bash",
      "edit",
      "write",
    ]);
    try {
      expect(host.notices).toEqual([]);
      await host.prompt([]);
      await host.prompt([]);
      const warnings = host.notices.filter((notice) =>
        notice.includes("Pipkin's deferred tools"),
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(
        '"defaultTools":["+codemode","+tool_search"]',
      );
      expect(host.session.getActiveToolNames()).not.toContain("lsp_status");
      expect(host.errors).toEqual([]);
    } finally {
      await host.dispose();
    }
  });

  it("does not warn when native MCP enables discovery during startup", async () => {
    const server = await fakeMcpServer();
    const fixture = await loadBundle({
      nativeFactories: true,
      mcp: { fixture: { url: server.url, exposure: "deferred" } },
    });
    const host = await nativeSession(fixture, ["read", "bash"]);
    try {
      await host.prompt([]);
      expect(host.session.getActiveToolNames()).toContain("tool_search");
      expect(
        host.notices.filter((notice) =>
          notice.includes("Pipkin's deferred tools"),
        ),
      ).toEqual([]);
    } finally {
      await host.dispose();
      await server.close();
    }
  });

  it("returns registered Browser structured failures directly without result reconstruction", async () => {
    const fixture = await loadBundle();
    const browser = fixture.result.extensions.find(
      (extension) =>
        relativeExtensionPath(extension) === "src/extensions/browser/index.ts",
    )!;
    const { runner, errors } = await createBundleRunner(fixture, [browser]);
    const definition = runner
      .getAllRegisteredTools()
      .find(
        ({ definition }) => definition.name === "browser_navigate",
      )!.definition;
    const input = { url: "file:///tmp/not-allowed" };
    const result = await definition.execute(
      "browser-failure",
      input,
      undefined,
      undefined,
      {} as never,
    );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error: { code: "target" },
        generation: expect.any(Number),
        stateLost: false,
      },
    });
    expect(Check(definition.outputSchema!, result.structuredContent)).toBe(
      true,
    );
    const event = {
      type: "tool_result" as const,
      toolCallId: "browser-failure",
      toolName: "browser_navigate",
      input,
      content: [{ type: "text" as const, text: "raw failure" }],
      details: undefined,
      isError: true,
    };
    await expect(runner.emitToolResult(event)).resolves.toBeUndefined();
    expect(errors).toEqual([]);
    await runner.emit({ type: "session_shutdown", reason: "quit" });
  });

  it("selects Web Fetch structured fields through native codemode and validates the registered schema", async () => {
    const fixture = await loadBundle({ nativeFactories: true });
    const definition = fixture.result.extensions
      .flatMap((extension) => [...extension.tools.values()])
      .find((tool) => tool.definition.name === "web_fetch")!.definition;
    const execute = definition.execute;
    const validate = new Ajv().compile(definition.outputSchema!);
    // Supply a controlled response only for the successful public fixture;
    // forbidden targets still traverse the registered owner and transport.
    const captures: unknown[] = [];
    definition.execute = async (id, input, signal, onUpdate, ctx) => {
      const request = input as WebFetchInput;
      const result =
        request.url === "https://example.com/fixture"
          ? await executeWebFetch(request, signal, onUpdate, {
              transport: {
                profile: { browser: "chrome_147", os: "windows" },
                fetch: async () => {
                  const response = new Response('{"answer":42}', {
                    headers: { "content-type": "application/json" },
                  });
                  Object.defineProperty(response, "url", {
                    value: request.url,
                  });
                  return response;
                },
              },
            })
          : await execute(id, input, signal, onUpdate, ctx);
      expect(
        validate(result.structuredContent),
        JSON.stringify(validate.errors),
      ).toBe(true);
      captures.push(result.structuredContent);
      return result;
    };
    const host = await nativeSession(fixture);
    try {
      const results = await host.prompt([
        {
          name: "tool_search",
          args: { query: "+web_fetch" },
          id: "web-search",
        },
        {
          name: "web_fetch",
          args: { url: "https://example.com/fixture" },
          id: "web-direct",
        },
        {
          name: "codemode",
          args: {
            code: 'const page = await tools.web_fetch({url:"https://example.com/fixture"}); text({format:page.format,answer:JSON.parse(page.text).answer,truncated:page.truncated}); const blocked = await tools.web_fetch({url:"http://127.0.0.1"}); text({ok:blocked.ok,code:blocked.error.code});',
          },
          id: "web-nested",
        },
      ]);
      expect(
        results.find((result) => result.toolCallId === "web-direct"),
      ).toMatchObject({
        isError: false,
        content: [
          { type: "text", text: expect.stringContaining('"answer": 42') },
        ],
      });
      expect(captures).toEqual([
        expect.objectContaining({
          ok: true,
          format: "json",
          status: 200,
          truncated: false,
        }),
        expect.objectContaining({
          ok: true,
          format: "json",
          status: 200,
          truncated: false,
        }),
        { ok: false, error: { code: "target", message: expect.any(String) } },
      ]);
      const nested = results.find(
        (result) => result.toolCallId === "web-nested",
      )!;
      expect(nested.isError).toBe(false);
      const text = nested.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      expect(
        text
          .split("\n")
          .filter((line) => line.startsWith("{"))
          .map((line) => JSON.parse(line)),
      ).toEqual([
        { format: "json", answer: 42, truncated: false },
        { ok: false, code: "target" },
      ]);
      expect(nested.nestedCalls?.calls).toEqual([
        expect.objectContaining({ name: "web_fetch", status: "ok" }),
        expect.objectContaining({ name: "web_fetch", status: "error" }),
      ]);
      expect(host.errors).toEqual([]);
    } finally {
      await host.dispose();
    }
  });

  it("forwards native screenshot images and inspectable Browser errors through codemode", async () => {
    const fixture = await loadBundle({ nativeFactories: true });
    const screenshot = fixture.result.extensions
      .flatMap((extension) => [...extension.tools.values()])
      .find(
        ({ definition }) => definition.name === "browser_screenshot",
      )!.definition;
    // Deterministic transport fixture: Browser owner/schema behavior is covered beside its owner.
    const image = {
      type: "image" as const,
      mimeType: "image/png" as const,
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1foAAAAASUVORK5CYII=",
    };
    screenshot.execute = async () =>
      success(
        {
          ok: true,
          page: {
            tabId: "tab-1",
            url: "about:blank",
            title: "",
            generation: 0,
          },
          generation: 0,
          stateLost: false,
          image,
          width: 1,
          height: 1,
          bytes: Buffer.from(image.data, "base64").length,
        },
        { mode: "screenshot" },
      );
    const host = await nativeSession(fixture);
    try {
      const results = await host.prompt([
        {
          name: "codemode",
          args: {
            code: "const result = await tools.browser_screenshot({}); image(result.image);",
          },
          id: "shot",
        },
        {
          name: "codemode",
          args: {
            code: 'const result = await tools.browser_navigate({url:"file:///tmp/blocked"}); text({ok:result.ok,code:result.error.code});',
          },
          id: "browser-error",
        },
      ]);
      expect(
        results.find((result) => result.toolCallId === "shot"),
      ).toMatchObject({
        isError: false,
        content: expect.arrayContaining([image]),
        nestedCalls: {
          calls: [
            expect.objectContaining({
              name: "browser_screenshot",
              status: "ok",
            }),
          ],
        },
      });
      const failure = results.find(
        (result) => result.toolCallId === "browser-error",
      )!;
      expect(failure.isError).toBe(false);
      expect(JSON.stringify(failure.content)).toContain("target");
      expect(failure.nestedCalls?.calls).toEqual([
        expect.objectContaining({ name: "browser_navigate", status: "error" }),
      ]);
      expect(host.errors).toEqual([]);
    } finally {
      await host.dispose();
    }
  });

  it("persists a native error result for a forbidden web target", async () => {
    const fixture = await loadBundle();
    const host = await nativeSession(fixture, [], ["web_fetch"]);
    try {
      const results = await host.prompt([
        {
          name: "web_fetch",
          args: { url: "http://localhost" },
          id: "blocked-web",
        },
      ]);
      expect(
        results.find((result) => result.toolCallId === "blocked-web"),
      ).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("localhost") }],
      });
    } finally {
      await host.dispose();
    }
  });

  it("captures the public Codex API through Pi's real Jiti loader without fetching", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pipkin-capture-loader-"));
    const extensionPath = join(directory, "capture.ts");
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected network request"));
    try {
      writeFileSync(
        extensionPath,
        `
        import { Type } from "typebox";
        import { createCodexOAuthAdapter } from ${JSON.stringify(join(ROOT, "src/extensions/context/codex-oauth-adapter.ts"))};
        export default async function (pi) {
          const payload = await createCodexOAuthAdapter().capture({
            model: {
              id: "gpt-5-codex", name: "Codex", provider: "openai-codex", api: "openai-codex-responses",
              baseUrl: "https://chatgpt.com/backend-api", reasoning: true, input: ["text"],
              cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 100000, maxTokens: 1000,
            },
            auth: {ok: true, apiKey: "header." + Buffer.from(JSON.stringify({
              "https://api.openai.com/auth": {chatgpt_account_id: "fixture"}
            })).toString("base64url") + ".signature"},
            context: {systemPrompt: "capture only", messages: [{role: "user", content: "synthetic", timestamp: 1}]},
          });
          pi.registerTool({name: "capture_fixture", label: "capture", description: "Fixture", parameters: Type.Object({}),
            execute: async () => ({content: [{type: "text", text: JSON.stringify(payload)}], details: undefined}),
          });
        }
      `,
      );
      const fixture = await loadBundle({ additionalPaths: [extensionPath] });
      expect(fixture.result.errors).toEqual([]);
      const capture = fixture.result.extensions
        .flatMap((extension) => [...extension.tools.values()])
        .find((tool) => tool.definition.name === "capture_fixture")!;
      const result = await capture.definition.execute(
        "fixture",
        {},
        undefined,
        undefined,
        {} as never,
      );
      expect(result.content).toEqual([
        { type: "text", text: expect.stringContaining("synthetic") },
      ]);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
      rmSync(directory, { recursive: true, force: true });
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
      { startSandboxManagedExecution },
      { reserveOutput, outputScope },
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
      import("#context/retained-output"),
      import("#subagents/runtime"),
      import("#subagents/completion"),
      import("#personality/session-name"),
    ]);
    expect(getConfigPath("/tmp/agent")).toBe("/tmp/agent/pipkin/config.json");
    expect(formatCompactTokens(1500)).toBe("1.5k");
    for (const fn of [
      setPipkinStatus,
      createActivityPublisher,
      bindSandboxHost,
      startSandboxManagedExecution,
      reserveOutput,
      outputScope,
      getSubagentRuntime,
      generateSessionName,
    ]) {
      expect(fn).toBeTypeOf("function");
    }
    expect(MANAGED_COMPLETION_FINAL_ACTION).toBe(
      "Call pi_managed_complete exactly once as your final action after all other required work.",
    );
    expect(snapshotGlobalSymbols()).toEqual(before);
  });

  it("keeps Context retained-output ownership side-effect-free and acyclic", () => {
    const retained = readFileSync(
      join(ROOT, "src/extensions/context/retained-output.ts"),
      "utf8",
    );
    expect(retained).not.toMatch(/registerTool|#sandbox|#processes/);
    for (const path of ["sandbox/execution.ts", "processes/runtime.ts"]) {
      expect(
        readFileSync(join(ROOT, "src/extensions", path), "utf8"),
      ).toContain('from "#context/retained-output"');
    }
  });

  it("contains no package-era topology, retired transport, or cross-feature entrypoint imports", () => {
    expect(manifest.workspaces).toBeUndefined();
    expect(JSON.stringify(manifest)).not.toContain("workspace:");
    expect(existsSync(join(ROOT, "packages"))).toBe(false);
    expect(existsSync(join(ROOT, "lib/src"))).toBe(false);
    const files = projectFiles(ROOT);
    expect(files.filter((path) => path.endsWith("package.json"))).toEqual([
      join(ROOT, "package.json"),
    ]);
    expect(
      files.filter((path) => /vitest\.config\.[cm]?[jt]s$/.test(path)),
    ).toEqual([join(ROOT, "vitest.config.ts")]);
    for (const path of files.filter(
      (path) =>
        path.startsWith(join(ROOT, "src")) &&
        /\.[cm]?[jt]s$/.test(path) &&
        !/\.test\.[cm]?[jt]s$/.test(path),
    )) {
      const source = readFileSync(path, "utf8");
      expect(source).not.toMatch(
        /@pi-extensions\/|pi-subagents\/runtime|pi-mcp-adapter|MCP_DIRECT_TOOLS|pipkin\/auth\.json/,
      );
      expect(source).not.toMatch(
        /(?:from|import)\s*\(?["'][^"']*extensions\/[^"']+\/index(?:\.ts|\.js)?["']/,
      );
    }
  });
});
