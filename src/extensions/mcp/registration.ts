import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { McpAdapterOptions } from "pi-mcp-adapter";
import {
  renderMcpCall,
  renderMcpResult,
  renderMcpScriptCall,
} from "./presentation.js";

const ALLOWED_TOOLS = new Set(["mcp", "mcpScript"]);
const ALLOWED_COMMANDS = new Set(["mcp", "mcp-auth"]);

type AdapterFactory = (
  options: McpAdapterOptions,
) => (pi: ExtensionAPI) => void;

type Registration = Readonly<{
  start: (event: unknown, ctx: unknown) => Promise<void>;
  dispose: () => void;
}>;

export function registerContainedMcpAdapter(input: {
  pi: ExtensionAPI;
  options: McpAdapterOptions;
  createAdapter: AdapterFactory;
}): Registration {
  const { pi, options, createAdapter } = input;
  const eventUnsubscribers = new Set<() => void>();
  const startHandlers: ((event: unknown, ctx: unknown) => unknown)[] = [];
  const registeredTools = new Set<string>();
  const registeredCommands = new Set<string>();

  const events = Object.create(pi.events) as typeof pi.events;
  events.on = (channel, handler) => {
    const unsubscribe = pi.events.on(channel, handler);
    eventUnsubscribers.add(unsubscribe);
    return () => {
      eventUnsubscribers.delete(unsubscribe);
      unsubscribe();
    };
  };

  const facade = Object.create(pi) as ExtensionAPI;
  const mutableFacade = facade as unknown as {
    events: typeof pi.events;
    on: typeof pi.on;
    registerTool: (definition: unknown) => void;
    registerCommand: (name: string, definition: unknown) => void;
    registerFlag: (name: string, definition: unknown) => void;
  };
  mutableFacade.events = events;
  mutableFacade.on = ((
    channel: string,
    handler: (event: unknown, ctx: unknown) => unknown,
  ) => {
    if (channel === "session_start") {
      startHandlers.push(handler);
      return;
    }
    pi.on(channel as never, handler as never);
  }) as typeof pi.on;
  mutableFacade.registerTool = (definition) => {
    const tool = definition as Record<string, unknown>;
    const name = tool.name;
    if (typeof name !== "string" || !ALLOWED_TOOLS.has(name)) {
      return;
    }
    const {
      promptSnippet: _promptSnippet,
      promptGuidelines: _promptGuidelines,
      renderShell: _renderShell,
      renderCall: _renderCall,
      renderResult: _renderResult,
      ...contained
    } = tool;
    registeredTools.add(name);
    (pi.registerTool as (value: unknown) => void)(
      name === "mcpScript"
        ? {
            ...contained,
            description:
              "Run trusted JavaScript that composes multiple MCP calls in one request. For one MCP operation, use mcp instead.",
            renderCall: renderMcpScriptCall,
            renderResult: renderMcpResult,
          }
        : {
            ...contained,
            renderCall: renderMcpCall,
            renderResult: renderMcpResult,
          },
    );
  };
  mutableFacade.registerCommand = (name, definition) => {
    if (!ALLOWED_COMMANDS.has(name)) {
      return;
    }
    registeredCommands.add(name);
    (pi.registerCommand as (name: string, value: unknown) => void)(
      name,
      definition,
    );
  };
  mutableFacade.registerFlag = (name, _definition) => {
    if (name !== "mcp-config") {
      throw new Error(`Unexpected MCP adapter flag registration: ${name}`);
    }
  };

  createAdapter(options)(facade);
  for (const name of ALLOWED_TOOLS) {
    if (!registeredTools.has(name)) {
      throw new Error(`MCP adapter did not register required tool: ${name}`);
    }
  }
  for (const name of ALLOWED_COMMANDS) {
    if (!registeredCommands.has(name)) {
      throw new Error(`MCP adapter did not register required command: ${name}`);
    }
  }

  let started = false;
  let disposed = false;
  return {
    async start(event, ctx) {
      if (started || disposed) {
        return;
      }
      started = true;
      for (const handler of startHandlers) {
        await handler(event, ctx);
      }
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const unsubscribe of eventUnsubscribers) {
        unsubscribe();
      }
      eventUnsubscribers.clear();
    },
  };
}
