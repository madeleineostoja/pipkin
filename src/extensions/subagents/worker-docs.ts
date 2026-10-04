import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createMcpExtension,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  type LoadedMcpConfig,
  type McpExposure,
  type McpServerConfig,
} from "@earendil-works/pi-coding-agent";

const operations = ["resolve-library-id", "query-docs"] as const;
function workerDocToolName(operation: (typeof operations)[number]): string {
  return `mcp__context7__${operation.replaceAll("-", "_")}`;
}
export const WORKER_DOC_TOOLS = operations.map(workerDocToolName);
const unavailable =
  "Worker documentation unavailable: invalid Context7 configuration. Fix native mcp.json and authenticate in the parent with /mcp if needed.";

function selectedEntry(path: string): { present: boolean; value?: unknown } {
  try {
    const config = JSON.parse(readFileSync(path, "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    return {
      present: Object.hasOwn(config.mcpServers ?? {}, "context7"),
      value: config.mcpServers?.context7,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { present: false };
    }
    throw new Error(unavailable);
  }
}

function exposure(config: McpServerConfig, operation: string): McpExposure {
  const overrides = config.toolExposure ?? {};
  if (Object.hasOwn(overrides, operation)) {
    return overrides[operation]!;
  }
  for (const [pattern, value] of Object.entries(overrides)) {
    const regex = pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    if (new RegExp(`^${regex}$`).test(operation)) {
      return value;
    }
  }
  return config.exposure ?? "codemode";
}

export function loadWorkerDocs(
  pi: ExtensionAPI,
  agentDir: string,
  cwd: string,
  trusted: boolean,
): LoadedMcpConfig {
  try {
    const project = trusted
      ? selectedEntry(join(cwd, ".pi", "mcp.json"))
      : { present: false };
    const selected = project.present
      ? project
      : selectedEntry(join(agentDir, "mcp.json"));
    if (!selected.present) {
      return { servers: [], errors: [] };
    }
    // Public registration performs native validation, without connecting: the
    // worker MCP factory never consumes extension-registered servers.
    pi.registerMcpServer("context7", selected.value as McpServerConfig);
    let config: McpServerConfig;
    try {
      config = pi
        .getMcpServers()
        .find((server) => server.name === "context7")!.config;
    } finally {
      pi.unregisterMcpServer("context7");
    }
    if (config.enabled === false) {
      return {
        servers: [],
        errors: ["Worker documentation unavailable: Context7 is disabled."],
      };
    }
    const toolExposure = Object.fromEntries(
      operations.map((operation) => [
        operation,
        exposure(config, operation) === "hidden" ? "hidden" : "deferred",
      ]),
    ) as Record<string, McpExposure>;
    if (operations.every((operation) => toolExposure[operation] === "hidden")) {
      return {
        servers: [],
        errors: [
          "Worker documentation unavailable: Context7 documentation tools are hidden.",
        ],
      };
    }
    return {
      servers: [
        {
          name: "context7",
          config: { ...config, exposure: "hidden", toolExposure },
          source: join(
            project.present ? join(cwd, ".pi") : agentDir,
            "mcp.json",
          ),
          scope: project.present ? "project" : "global",
        },
      ],
      errors: [],
    };
  } catch {
    return { servers: [], errors: [unavailable] };
  }
}

export function createWorkerDocsExtension(agentDir: string): ExtensionFactory {
  return (pi) => {
    let reported = false;
    const on = ((
      event: string,
      handler: (value: never, ctx: ExtensionContext) => unknown,
    ) =>
      pi.on(
        event as "session_start",
        (value, ctx) =>
          handler(value as never, {
            ...ctx,
            ui: {
              ...ctx.ui,
              notify: () => {
                if (reported) {
                  return;
                }
                reported = true;
                pi.sendMessage({
                  customType: "pipkin:worker-documentation",
                  display: false,
                  content:
                    "Worker documentation unavailable or still connecting. Check the native Context7 entry and authenticate with /mcp in the parent if sign-in is required. Other worker tools remain available.",
                });
              },
            },
          }) as void | Promise<void>,
      )) as ExtensionAPI["on"];
    return createMcpExtension({
      loadConfig: (ctx) =>
        loadWorkerDocs(pi, agentDir, ctx.cwd, ctx.isProjectTrusted()),
    })({
      ...pi,
      // No worker command can sign in, sign out, or change native configuration.
      registerCommand: () => {},
      on,
      getMcpServers: () => [],
      registerTool: (tool) => {
        const approved = operations.some(
          (operation) =>
            tool.label === `context7/${operation}` &&
            tool.namespace?.name === "mcp__context7" &&
            tool.name === workerDocToolName(operation),
        );
        pi.registerTool({
          ...tool,
          exposure: approved ? tool.exposure : "hidden",
        });
      },
    });
  };
}
