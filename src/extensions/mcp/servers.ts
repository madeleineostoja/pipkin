import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { McpConfig, McpServerConfig } from "#lib/config";

export type McpServerOrigin = "global" | "project";
type EffectiveMcpServer = Readonly<
  McpServerConfig & { origin: McpServerOrigin }
>;
export type EffectiveMcpServers = Readonly<Record<string, EffectiveMcpServer>>;

export function mergeMcpServers(
  global: McpConfig | undefined,
  project: McpConfig | undefined,
): EffectiveMcpServers {
  const servers: Record<string, EffectiveMcpServer> = {};
  for (const [name, server] of Object.entries(global ?? {})) {
    servers[name] = effectiveServer(server, "global");
  }
  for (const [name, server] of Object.entries(project ?? {})) {
    servers[name] = effectiveServer(server, "project");
  }
  return Object.freeze(servers);
}

export function adapterMcpServers(
  servers: EffectiveMcpServers,
  projectRoot: string | undefined,
): McpConfig {
  const configured: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(servers)) {
    configured[
      server.origin === "project" && projectRoot
        ? projectAdapterName(projectRoot, name)
        : name
    ] = serverConfig(server);
  }
  return Object.freeze(configured);
}

function effectiveServer(
  server: McpServerConfig,
  origin: McpServerOrigin,
): EffectiveMcpServer {
  return Object.freeze({ ...serverConfig(server), origin });
}

function serverConfig(server: McpServerConfig): McpServerConfig {
  return Object.freeze({
    url: server.url,
    ...(server.oauth
      ? { oauth: Object.freeze({ clientName: server.oauth.clientName }) }
      : {}),
  });
}

export function projectAdapterName(root: string, logicalName: string): string {
  const slug = projectSlug(basename(root));
  const digest = createHash("sha256")
    .update(root, "utf8")
    .digest("hex")
    .slice(0, 12);
  return `project__${slug}_${digest}__${logicalName}`;
}

export function projectSlug(name: string): string {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24)
    .replace(/_+$/, "");
  return normalized || "project";
}
