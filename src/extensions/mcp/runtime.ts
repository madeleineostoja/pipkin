import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getConfigPath,
  getProjectConfigPath,
  loadPipkinConfig,
  loadProjectPipkinConfig,
  type ConfigSnapshot,
  type ProjectConfigSnapshot,
} from "#lib/config";
import { type McpAdapterOptions, createMcpAdapter } from "pi-mcp-adapter";
import { registerUnconfiguredMcpCommand } from "./command.js";
import { translateMcpConfig } from "./config.js";
import {
  resolveMcpProjectRoot,
  type McpProjectRootDependencies,
} from "./project-root.js";
import { registerContainedMcpAdapter } from "./registration.js";
import { adapterMcpServers, mergeMcpServers } from "./servers.js";

type McpAdapterFactory = (
  options: McpAdapterOptions,
) => (pi: ExtensionAPI) => void;

type McpSessionDependencies = Readonly<{
  loadGlobal?: (agentDir: string) => ConfigSnapshot;
  loadProject?: (root: string) => ProjectConfigSnapshot;
  resolveProjectRoot?: (
    cwd: string,
    dependencies?: McpProjectRootDependencies,
  ) => string | undefined;
  rootDependencies?: McpProjectRootDependencies;
  createAdapter?: McpAdapterFactory;
}>;

function seedMetadataCache(agentDir: string): void {
  const cachePath = join(agentDir, "mcp-cache.json");
  if (existsSync(cachePath)) {
    return;
  }

  mkdirSync(agentDir, { recursive: true });
  try {
    // pi-mcp-adapter@2.31.0 otherwise bootstraps every server on its first run,
    // including servers explicitly configured as lazy.
    writeFileSync(cachePath, '{"version":1,"servers":{}}', { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
}

export function registerMcpSession(
  input: { pi: ExtensionAPI; agentDir: string } & McpSessionDependencies,
): void {
  const loadGlobal = input.loadGlobal ?? loadPipkinConfig;
  const loadProject = input.loadProject ?? loadProjectPipkinConfig;
  const resolveProjectRoot = input.resolveProjectRoot ?? resolveMcpProjectRoot;
  let registration: ReturnType<typeof registerContainedMcpAdapter> | undefined;

  input.pi.on("session_start", async (event, ctx) => {
    registration?.dispose();
    registration = undefined;

    const global = loadGlobal(input.agentDir);
    const trusted = ctx.isProjectTrusted();
    let project: ProjectConfigSnapshot | undefined;
    let root: string | undefined;
    if (trusted) {
      root = resolveProjectRoot(ctx.cwd, input.rootDependencies);
      if (root) {
        try {
          project = loadProject(root);
        } catch {
          // A broken project read must not discard the global snapshot.
        }
      }
    }

    const effective = adapterMcpServers(
      mergeMcpServers(global.config.mcp, project?.config.mcp),
      project ? root : undefined,
    );
    const options = translateMcpConfig(effective);
    if (!options) {
      registerUnconfiguredMcpCommand({
        pi: input.pi,
        globalPath: global.path || getConfigPath(input.agentDir),
        ...(trusted && root ? { projectPath: getProjectConfigPath(root) } : {}),
        projectResolutionFailed: trusted && !root,
      });
      return;
    }

    seedMetadataCache(input.agentDir);
    process.env.MCP_DIRECT_TOOLS = "__none__";
    registration = registerContainedMcpAdapter({
      pi: input.pi,
      options,
      createAdapter: input.createAdapter ?? createMcpAdapter,
    });
    await registration.start(event, ctx);
    input.pi.on("session_shutdown", () => registration?.dispose());
  });
}

export type { McpSessionDependencies };
