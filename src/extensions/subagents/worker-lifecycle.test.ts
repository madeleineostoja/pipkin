import { createServer } from "node:http";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAgentSession,
  createEventBus,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createManagedSessionHarness } from "#test/managed-session";
import {
  bindOutputScope,
  createOutputScope,
  outputScope,
} from "#context/retained-output";
import { SubagentRuntime } from "./runtime.js";
import { bindSandboxHost } from "#sandbox/runtime";

async function docsServer(authRequired = false) {
  const calls: string[] = [];
  const server = createServer(async (request, response) => {
    if (authRequired) {
      response.writeHead(401).end();
      return;
    }
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
    let result: unknown = {};
    if (rpc.method === "initialize") {
      result = {
        protocolVersion: rpc.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "docs-fixture", version: "1" },
      };
    }
    if (rpc.method === "tools/list") {
      result = {
        tools: [
          "resolve-library-id",
          "query-docs",
          "unrecognized",
          "late_denied",
        ].map((name) => ({
          name,
          description: name,
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        })),
      };
    }
    if (rpc.method === "tools/call") {
      calls.push(rpc.params.name);
      result = { content: [{ type: "text", text: "documentation fixture" }] };
    }
    response
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return {
    calls,
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("native worker lifecycle", () => {
  it("releases prepared scope leases when SDK initialization fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipkin-worker-init-"));
    const bus = createEventBus();
    const ctx = {
      sessionManager: SessionManager.inMemory(root),
      model: { provider: "fixture", id: "model" },
    } as never;
    const scope = createOutputScope(root, ctx);
    const off = bindOutputScope(bus, scope);
    const timestamp = new Date().toISOString();
    await scope
      .reserve(ctx, { sourceTool: "fixture", callId: "parent" })
      .commit({
        execution: {
          state: "completed",
          exitCode: 0,
          startedAt: timestamp,
          endedAt: timestamp,
        },
        text: "parent capture",
        truncated: false,
        outputComplete: true,
      });
    const runtime = new SubagentRuntime(
      { events: bus, getActiveTools: () => [] } as never,
      {
        createSession: async () => {
          throw new Error("fixture initialization failed");
        },
      },
    );
    try {
      const result = await runtime.runManagedAgent({
        type: "General",
        prompt: "work",
        cwd: root,
        ctx,
      });
      expect(result).toMatchObject({
        status: "failed",
        cleanupComplete: true,
        error: "fixture initialization failed",
      });
      scope.release();
      expect(existsSync(join(root, scope.origin.scopeId))).toBe(false);
    } finally {
      await runtime.dispose();
      off();
      scope.release();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("loads the full bundle and native discovery/codemode, denies guessed and late tools, and promotes output after producer shutdown", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipkin-worker-native-"));
    const server = await docsServer();
    const mcpPath = join(getAgentDir(), "mcp.json");
    writeFileSync(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          context7: { url: server.url },
          figma: { url: "http://127.0.0.1:1/must-not-connect" },
        },
      }),
    );
    const bus = createEventBus();
    const sandbox = bindSandboxHost(bus, () => false);
    const parentManager = SessionManager.inMemory(root);
    const parentScope = createOutputScope(join(root, "outputs"), {
      sessionManager: parentManager,
    } as never);
    const off = bindOutputScope(bus, parentScope);
    const harness = await createManagedSessionHarness([]);
    let child!: AgentSession;
    let childScopeId!: string;
    let outputRef!: string;
    let sourceAttempt!: string;
    let promoted = false;
    let previousRef: string | undefined;
    let previousScopeId: string | undefined;
    const runtime = new SubagentRuntime(
      {
        events: bus,
        getActiveTools: () => [
          "read",
          "bash",
          "output_list",
          "read_output",
          "probe",
          "edit",
          "write",
          "agent_start",
          "codemode",
          "tool_search",
        ],
      } as never,
      {
        createSession: async (options) => {
          expect(new Set(options!.tools).size).toBe(options!.tools!.length);
          const created = await createAgentSession({
            ...options,
            modelRuntime: harness.modelRuntime,
            customTools: [
              ...(options?.customTools ?? []),
              {
                name: "probe",
                label: "probe",
                description: "Inspect real native worker capabilities.",
                parameters: Type.Object({}),
                async execute(
                  _call,
                  _params,
                  _signal,
                  _update,
                  ctx: ExtensionToolContext,
                ) {
                  const names = ctx.tools.map((tool) => tool.name);
                  expect(names).toEqual(
                    expect.arrayContaining([
                      "read",
                      "bash",
                      "output_list",
                      "read_output",
                      "mcp__context7__query_docs",
                    ]),
                  );
                  for (const denied of [
                    "edit",
                    "write",
                    "agent_start",
                    "agent_list",
                    "agent_inspect",
                    "agent_wait",
                    "agent_stop",
                    "agent_steer",
                    "explore",
                    "late_denied",
                    "mcp__context7__unrecognized",
                    "mcp__context7__late_denied",
                    "pi_managed_complete",
                  ]) {
                    expect(names).not.toContain(denied);
                    expect((await ctx.executeTool(denied, {})).isError).toBe(
                      true,
                    );
                  }
                  const scope = outputScope(
                    (options!.resourceLoader as any).eventBus,
                  );
                  if (previousRef) {
                    expect(scope.read(previousRef, ctx)).toBeUndefined();
                    expect(scope.origin.scopeId).not.toBe(previousScopeId);
                  }
                  childScopeId = scope.origin.scopeId;
                  sourceAttempt = scope.origin.attemptId!;
                  expect(scope.origin.parentScopeId).toBe(
                    parentScope.origin.scopeId,
                  );
                  const output = await ctx.executeTool("bash", {
                    command: "printf 'retained worker output'",
                  });
                  outputRef = (
                    output.result.structuredContent as { outputRef: string }
                  ).outputRef;
                  expect(scope.read(outputRef, ctx)?.text).toContain(
                    "retained worker output",
                  );
                  expect(
                    parentScope.read(outputRef, {
                      sessionManager: parentManager,
                    } as never),
                  ).toBeUndefined();
                  return {
                    content: [{ type: "text", text: "probe passed" }],
                    details: undefined,
                  };
                },
              },
            ],
          });
          child = created.session;
          const extensions =
            options!.resourceLoader!.getExtensions().extensions;
          expect(
            extensions.some((extension) =>
              extension.path.endsWith("subagents/index.ts"),
            ),
          ).toBe(true);
          expect(
            extensions.some((extension) =>
              extension.path.endsWith("implement/index.ts"),
            ),
          ).toBe(true);
          return created;
        },
      },
    );
    harness.faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("tool_search", { query: "resolve-library-id query-docs" }),
      ]),
      fauxAssistantMessage([
        fauxToolCall("mcp__context7__resolve_library_id", {}),
      ]),
      fauxAssistantMessage([
        fauxToolCall("codemode", {
          code: "const docs = await tools.mcp__context7__query_docs({}); text(docs.content[0].text); text(ALL_TOOLS.map(t => t.name));",
        }),
      ]),
      fauxAssistantMessage([fauxToolCall("probe", {})]),
      fauxAssistantMessage("finished"),
    ]);
    try {
      const final = await runtime.runPublicAgent({
        type: "Explore",
        prompt: "exercise fixtures",
        cwd: root,
        ctx: {
          cwd: root,
          model: harness.model,
          modelRegistry: harness.modelRegistry,
        } as never,
        finalizeOutput: async (snapshot, lease) => {
          expect(snapshot.status).toBe("completed");
          expect(outputScope(bus)).toBe(parentScope);
          const record = lease.export(outputRef);
          expect(record.text).toContain("retained worker output");
          expect(record.origin.attemptId).toBe(sourceAttempt);
          expect(existsSync(join(parentScope.root, childScopeId))).toBe(true);
          promoted = true;
        },
      });
      expect(
        child.messages.filter(
          (message) => message.role === "toolResult" && message.isError,
        ),
      ).toEqual([]);
      expect(final).toMatchObject({
        status: "completed",
        cleanupComplete: true,
      });
      expect(
        child.messages.some(
          (message) =>
            message.role === "custom" &&
            message.customType === "pipkin:worker-documentation",
        ),
      ).toBe(false);
      expect(promoted).toBe(true);
      expect(server.calls).toEqual(["resolve-library-id", "query-docs"]);
      const toolResults = child.messages.filter(
        (message) => message.role === "toolResult",
      );
      expect(toolResults.every((message) => !message.isError)).toBe(true);
      expect(child.getAllTools().map((tool) => tool.name)).not.toContain(
        "mcp__context7__unrecognized",
      );
      expect(existsSync(join(parentScope.root, childScopeId))).toBe(false);
      expect(readdirSync(parentScope.root)).toEqual([]);
      previousRef = outputRef;
      previousScopeId = childScopeId;
      harness.faux.setResponses([
        fauxAssistantMessage([fauxToolCall("probe", {})]),
        fauxAssistantMessage("second"),
      ]);
      const failedHandoff = await runtime.runPublicAgent({
        type: "Explore",
        prompt: "second scope",
        cwd: root,
        ctx: {
          cwd: root,
          model: harness.model,
          modelRegistry: harness.modelRegistry,
        } as never,
        finalizeOutput: async (_snapshot, lease) => {
          expect(lease.export(outputRef).origin.scopeId).toBe(childScopeId);
          throw new Error("fixture promotion failure");
        },
      });
      expect(failedHandoff).toMatchObject({
        status: "failed",
        cleanupComplete: true,
        error: "Worker output handoff failed.",
      });
      expect(existsSync(join(parentScope.root, childScopeId))).toBe(false);
      expect(readdirSync(parentScope.root)).toEqual([]);
    } finally {
      await runtime.dispose();
      off();
      parentScope.release();
      sandbox.dispose();
      await server.close();
      rmSync(mcpPath, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("degrades auth-required documentation without a worker login or credential mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipkin-worker-auth-"));
    const server = await docsServer(true);
    const authPath = join(getAgentDir(), "mcp-auth.json");
    writeFileSync(authPath, "{}\n");
    const mcpPath = join(getAgentDir(), "mcp.json");
    writeFileSync(
      mcpPath,
      JSON.stringify({ mcpServers: { context7: { url: server.url } } }),
    );
    const harness = await createManagedSessionHarness([]);
    const bus = createEventBus();
    const sandbox = bindSandboxHost(bus, () => false);
    const parent = createOutputScope(join(root, "outputs"), {
      sessionManager: SessionManager.inMemory(root),
    } as never);
    const off = bindOutputScope(bus, parent);
    let child!: AgentSession;
    const runtime = new SubagentRuntime(
      { events: bus, getActiveTools: () => ["read"] } as never,
      {
        createSession: async (options) => {
          const created = await createAgentSession({
            ...options,
            modelRuntime: harness.modelRuntime,
          });
          child = created.session;
          return created;
        },
      },
    );
    harness.faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("codemode", {
          code: 'text(await searchTools("Context7 documentation"));',
        }),
      ]),
      fauxAssistantMessage("Research continues without documentation."),
    ]);
    try {
      const snapshot = await runtime.runPublicAgent({
        type: "Explore",
        prompt: "research",
        cwd: root,
        ctx: {
          cwd: root,
          model: harness.model,
          modelRegistry: harness.modelRegistry,
        } as never,
      });
      expect(snapshot.status, snapshot.error).toBe("completed");
      expect(child.messages).toContainEqual(
        expect.objectContaining({
          role: "custom",
          customType: "pipkin:worker-documentation",
          content: expect.stringContaining(
            "authenticate with /mcp in the parent",
          ),
        }),
      );
      expect(child.extensionRunner.getCommand("mcp")).toBeUndefined();
      expect(readFileSync(authPath, "utf8")).toBe("{}\n");
      expect(server.calls).toEqual([]);
    } finally {
      await runtime.dispose();
      off();
      parent.release();
      sandbox.dispose();
      await server.close();
      rmSync(mcpPath, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
