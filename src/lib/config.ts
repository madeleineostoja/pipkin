import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { isModelRef } from "./model-ref.js";
import { pipkinProjectDirectory } from "./project-path.js";

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export const MAX_CONFIG_BYTES = 64 * 1024;
export const MAX_SANDBOX_WRITABLE_ENTRIES = 64;
export const MAX_SANDBOX_WRITABLE_LENGTH = 1024;
export const MAX_MCP_SERVER_NAME_LENGTH = 64;
export const MAX_MCP_SERVER_URL_LENGTH = 2_000;
export const MAX_MCP_OAUTH_CLIENT_NAME_LENGTH = 256;
export const MCP_PROJECT_NAME_PREFIX = "project__";

// The adapter resolves these forms at authentication time; Pipkin snapshots
// client identity as a validated literal instead.
const MCP_ENV_INTERPOLATION_PATTERN = /\$\{\w+\}|\$env:\w+|\{env:\w+\}/;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type ModelPresetName = "utility" | "low" | "medium" | "high";
export type ModelPreset = Readonly<{ model: string; thinking: ThinkingLevel }>;
export type ConfigScope = "global" | "project";
export type ConfigIssue = Readonly<{
  path: string;
  message: string;
  scope?: ConfigScope;
}>;
export type SandboxConfig = Readonly<{ writable: readonly string[] }>;
export type McpOAuthConfig = Readonly<{ clientName: string }>;
export type McpServerConfig = Readonly<{
  url: string;
  oauth?: McpOAuthConfig;
}>;
export type McpConfig = Readonly<Record<string, McpServerConfig>>;
export type PipkinConfig = Readonly<{
  models: Readonly<Partial<Record<ModelPresetName, ModelPreset>>>;
  implement: Readonly<{ workerConcurrency: number }>;
  sandbox?: SandboxConfig;
  mcp?: McpConfig;
  nickname?: string;
}>;
export type ProjectPipkinConfig = Readonly<{
  sandbox: SandboxConfig;
  mcp?: McpConfig;
}>;
export type ConfigSnapshot = Readonly<{
  path: string;
  config: PipkinConfig;
  issues: readonly ConfigIssue[];
}>;
export type ProjectConfigSnapshot = Readonly<{
  path: string;
  config: ProjectPipkinConfig;
  issues: readonly ConfigIssue[];
}>;

/** Shared strict shape; scoped parsers retain valid list entries independently. */
export const SandboxConfigSchema = z
  .object({ writable: z.array(z.string()).optional() })
  .strict();

type FileReader = (path: string, encoding: "utf8") => string;
type Issue = (field: string, message: string) => void;

const MODEL_PRESETS = ["utility", "low", "medium", "high"] as const;
const thinkingLevels = new Set<string>(THINKING_LEVELS);
const MAX_ISSUES = 32;

export function getConfigPath(agentDir: string): string {
  return join(agentDir, "pipkin", "config.json");
}

export function getProjectConfigPath(workspaceRoot: string): string {
  return join(pipkinProjectDirectory(workspaceRoot), "config.json");
}

export function loadPipkinConfig(
  agentDir: string,
  readFile: FileReader = readFileSync as FileReader,
): ConfigSnapshot {
  const path = getConfigPath(agentDir);
  return loadFile(path, "global", readFile, parsePipkinValue);
}

export function loadProjectPipkinConfig(
  workspaceRoot: string,
  readFile: FileReader = readFileSync as FileReader,
): ProjectConfigSnapshot {
  const path = getProjectConfigPath(workspaceRoot);
  return loadFile(path, "project", readFile, parseProjectValue);
}

export function parsePipkinConfig(
  raw: string,
  path = "config.json",
): ConfigSnapshot {
  return scopeSnapshot(
    parseJson(raw, path, "global", parsePipkinValue),
    "global",
  );
}

export function parseProjectPipkinConfig(
  raw: string,
  path = "config.json",
): ProjectConfigSnapshot {
  return scopeSnapshot(
    parseJson(raw, path, "project", parseProjectValue),
    "project",
  );
}

export function presetIssue(
  snapshot: ConfigSnapshot,
  name: ModelPresetName,
): ConfigIssue | undefined {
  return snapshot.issues.find(
    (issue) =>
      issue.path === `models.${name}` ||
      issue.path.startsWith(`models.${name}.`),
  );
}

function loadFile<
  T extends { path: string; config: unknown; issues: readonly ConfigIssue[] },
>(
  path: string,
  scope: ConfigScope,
  readFile: FileReader,
  parse: (value: unknown, path: string, initial: ConfigIssue[]) => T,
): T {
  try {
    const raw = readFile(path, "utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_CONFIG_BYTES) {
      return scopeSnapshot(
        parse(undefined, path, [
          {
            path: "config",
            message: `exceeds ${MAX_CONFIG_BYTES} byte limit`,
            scope,
          },
        ]),
        scope,
      );
    }
    return scopeSnapshot(parseJson(raw, path, scope, parse), scope);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return scopeSnapshot(parse({}, path, []), scope);
    }
    return scopeSnapshot(
      parse(undefined, path, [
        {
          path: "config",
          message: `could not be read: ${messageFor(error)}`,
          scope,
        },
      ]),
      scope,
    );
  }
}

function scopeSnapshot<
  T extends { path: string; config: unknown; issues: readonly ConfigIssue[] },
>(snapshot: T, scope: ConfigScope): T {
  return freeze({
    ...snapshot,
    issues: snapshot.issues.map((issue) => ({
      ...issue,
      scope: issue.scope ?? scope,
    })),
  }) as T;
}

function parseJson<
  T extends { path: string; config: unknown; issues: readonly ConfigIssue[] },
>(
  raw: string,
  path: string,
  scope: ConfigScope,
  parse: (value: unknown, path: string, initial: ConfigIssue[]) => T,
): T {
  if (Buffer.byteLength(raw, "utf8") > MAX_CONFIG_BYTES) {
    return parse(undefined, path, [
      {
        path: "config",
        message: `exceeds ${MAX_CONFIG_BYTES} byte limit`,
        scope,
      },
    ]);
  }
  try {
    return parse(JSON.parse(raw), path, []);
  } catch (error) {
    return parse(undefined, path, [
      {
        path: "config",
        message: `contains malformed JSON: ${messageFor(error)}`,
        scope,
      },
    ]);
  }
}

function parsePipkinValue(
  value: unknown,
  path: string,
  initialIssues: ConfigIssue[],
): ConfigSnapshot {
  const { issue, root, issues } = parser(value, initialIssues);
  const modelsValue = root?.models;
  const modelsInput = isRecord(modelsValue) ? modelsValue : undefined;
  if (!modelsInput) {
    issue(
      "models",
      "must be an object with utility, low, medium, and high presets",
    );
  }
  const models: Partial<Record<ModelPresetName, ModelPreset>> = {};
  for (const name of MODEL_PRESETS) {
    const model = parseModelPreset(modelsInput?.[name], name, issue);
    if (model) {
      models[name] = model;
    }
  }
  if (modelsInput) {
    for (const key of Object.keys(modelsInput)) {
      if (!MODEL_PRESETS.includes(key as ModelPresetName)) {
        issue(`models.${key}`, "is not a supported preset");
      }
    }
  }

  let nickname: string | undefined;
  if (root?.nickname !== undefined) {
    nickname = parseNickname(root.nickname, issue);
  }
  let workerConcurrency = 3;
  if (root?.implement !== undefined) {
    if (!isRecord(root.implement)) {
      issue("implement", "must be an object");
    } else {
      for (const key of Object.keys(root.implement)) {
        if (key !== "workerConcurrency") {
          issue(`implement.${key}`, "is not supported");
        }
      }
      if (root.implement.workerConcurrency !== undefined) {
        const concurrency = root.implement.workerConcurrency;
        if (
          typeof concurrency !== "number" ||
          !Number.isInteger(concurrency) ||
          concurrency <= 0
        ) {
          issue("implement.workerConcurrency", "must be a positive integer");
        } else {
          workerConcurrency = Math.min(concurrency, 8);
        }
      }
    }
  }
  const sandbox = parseSandbox(root?.sandbox, issue);
  const mcp = parseMcp(root?.mcp, issue);
  if (root) {
    for (const key of Object.keys(root)) {
      if (
        !(
          ["models", "implement", "nickname", "sandbox", "mcp"] as string[]
        ).includes(key)
      ) {
        issue(key, "is not supported");
      }
    }
  }
  return freeze({
    path,
    config: {
      models,
      implement: { workerConcurrency },
      sandbox,
      ...(mcp ? { mcp } : {}),
      ...(nickname ? { nickname } : {}),
    },
    issues,
  });
}

function parseProjectValue(
  value: unknown,
  path: string,
  initialIssues: ConfigIssue[],
): ProjectConfigSnapshot {
  const { issue, root, issues } = parser(value, initialIssues);
  const sandbox = parseSandbox(root?.sandbox, issue);
  const mcp = parseMcp(root?.mcp, issue);
  if (root) {
    for (const key of Object.keys(root)) {
      if (key !== "sandbox" && key !== "mcp") {
        issue(key, "is not supported in project configuration");
      }
    }
  }
  return freeze({ path, config: { sandbox, ...(mcp ? { mcp } : {}) }, issues });
}

function parser(value: unknown, initialIssues: ConfigIssue[]) {
  const issues = [...initialIssues];
  const scope = initialIssues[0]?.scope;
  const issue: Issue = (field, message) => {
    if (issues.length < MAX_ISSUES) {
      issues.push({ path: field, message, ...(scope ? { scope } : {}) });
    }
  };
  const root = isRecord(value) ? value : undefined;
  if (!root) {
    issue("config", "must be a JSON object");
  }
  return { issue, root, issues };
}

function parseSandbox(value: unknown, issue: Issue): SandboxConfig {
  if (value === undefined) {
    return freeze({ writable: [] });
  }
  if (!isRecord(value)) {
    issue("sandbox", "must be an object");
    return freeze({ writable: [] });
  }
  const supported = new Set<string>(SandboxConfigSchema.keyof().options);
  for (const key of Object.keys(value)) {
    if (!supported.has(key)) {
      issue(`sandbox.${key}`, "is not supported");
    }
  }
  if (value.writable === undefined) {
    return freeze({ writable: [] });
  }
  if (!Array.isArray(value.writable)) {
    issue("sandbox.writable", "must be an array of paths");
    return freeze({ writable: [] });
  }
  const writable: string[] = [];
  const entrySchema = SandboxConfigSchema.shape.writable.unwrap().element;
  for (const [index, entry] of value.writable.entries()) {
    const field = `sandbox.writable.${index}`;
    if (index >= MAX_SANDBOX_WRITABLE_ENTRIES) {
      issue(field, `exceeds ${MAX_SANDBOX_WRITABLE_ENTRIES} entry limit`);
    } else {
      const parsed = entrySchema.safeParse(entry);
      if (!parsed.success) {
        issue(field, "must be a text path");
      } else if (
        parsed.data.length === 0 ||
        parsed.data.length > MAX_SANDBOX_WRITABLE_LENGTH
      ) {
        issue(field, `must be 1 to ${MAX_SANDBOX_WRITABLE_LENGTH} characters`);
      } else {
        writable.push(parsed.data);
      }
    }
  }
  return freeze({ writable });
}

function parseMcp(value: unknown, issue: Issue): McpConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    issue("mcp", "must be an object of server definitions");
    return undefined;
  }

  const servers: Record<string, McpServerConfig> = {};
  for (const [name, definition] of Object.entries(value)) {
    const field = `mcp.${name}`;
    if (
      name.length > MAX_MCP_SERVER_NAME_LENGTH ||
      !/^[a-z][a-z0-9_-]*$/.test(name) ||
      name.startsWith(MCP_PROJECT_NAME_PREFIX)
    ) {
      issue(
        field,
        `name must match [a-z][a-z0-9_-]*, avoid reserved ${MCP_PROJECT_NAME_PREFIX}, and be at most ${MAX_MCP_SERVER_NAME_LENGTH} characters`,
      );
      continue;
    }
    if (!isRecord(definition)) {
      issue(field, "must be an object with url");
      continue;
    }
    let serverValid = true;
    for (const key of Object.keys(definition)) {
      if (key !== "url" && key !== "oauth") {
        issue(`${field}.${key}`, "is not supported");
        serverValid = false;
      }
    }
    let oauth: McpOAuthConfig | undefined;
    if ("oauth" in definition) {
      const oauthField = `${field}.oauth`;
      if (!isRecord(definition.oauth)) {
        issue(oauthField, "must be an object with clientName");
        serverValid = false;
      } else {
        for (const key of Object.keys(definition.oauth)) {
          if (key !== "clientName") {
            issue(`${oauthField}.${key}`, "is not supported");
            serverValid = false;
          }
        }
        if (typeof definition.oauth.clientName !== "string") {
          issue(`${oauthField}.clientName`, "must be text");
          serverValid = false;
        } else {
          const clientName = definition.oauth.clientName.trim();
          if (
            clientName.length === 0 ||
            clientName.length > MAX_MCP_OAUTH_CLIENT_NAME_LENGTH
          ) {
            issue(
              `${oauthField}.clientName`,
              `must be 1 to ${MAX_MCP_OAUTH_CLIENT_NAME_LENGTH} characters`,
            );
            serverValid = false;
          } else if (
            Array.from(clientName).some((character) =>
              /\p{Cc}/u.test(character),
            )
          ) {
            issue(
              `${oauthField}.clientName`,
              "must not contain control characters",
            );
            serverValid = false;
          } else if (MCP_ENV_INTERPOLATION_PATTERN.test(clientName)) {
            issue(
              `${oauthField}.clientName`,
              "must not contain environment interpolation",
            );
            serverValid = false;
          } else {
            oauth = { clientName };
          }
        }
      }
    }
    if (typeof definition.url !== "string") {
      issue(`${field}.url`, "must be an HTTP(S) URL");
      serverValid = false;
    } else if (definition.url.length > MAX_MCP_SERVER_URL_LENGTH) {
      issue(
        `${field}.url`,
        `must be at most ${MAX_MCP_SERVER_URL_LENGTH} characters`,
      );
      serverValid = false;
    } else {
      try {
        const url = new URL(definition.url);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          issue(`${field}.url`, "must be an HTTP(S) URL");
          serverValid = false;
        }
      } catch {
        issue(`${field}.url`, "must be an HTTP(S) URL");
        serverValid = false;
      }
    }
    if (serverValid) {
      servers[name] = {
        url: definition.url as string,
        ...(oauth ? { oauth } : {}),
      };
    }
  }
  return freeze(servers);
}

function parseNickname(value: unknown, issue: Issue): string | undefined {
  if (typeof value !== "string") {
    issue("nickname", "must be a non-empty text value");
    return undefined;
  }
  if (Array.from(value).some((character) => /\p{Cc}/u.test(character))) {
    issue("nickname", "must not contain control characters");
    return undefined;
  }
  const nickname = value.replace(/\s+/g, " ").trim();
  if (!nickname) {
    issue("nickname", "must be a non-empty text value");
    return undefined;
  }
  if (Array.from(nickname).length > 40) {
    issue("nickname", "must be at most 40 characters");
    return undefined;
  }
  return nickname;
}

function parseModelPreset(
  value: unknown,
  name: ModelPresetName,
  issue: Issue,
): ModelPreset | undefined {
  if (!isRecord(value)) {
    issue(`models.${name}`, "must be an object with model and thinking");
    return undefined;
  }
  let valid = true;
  for (const key of Object.keys(value)) {
    if (key !== "model" && key !== "thinking") {
      issue(`models.${name}.${key}`, "is not supported");
      valid = false;
    }
  }
  const { model, thinking } = value;
  if (typeof model !== "string" || !isModelRef(model)) {
    issue(
      `models.${name}`,
      "model must be a non-empty provider/model reference",
    );
    valid = false;
  }
  if (typeof thinking !== "string" || !thinkingLevels.has(thinking)) {
    issue(`models.${name}`, "thinking must be a supported Pi thinking level");
    valid = false;
  }
  return valid
    ? { model: (model as string).trim(), thinking: thinking as ThinkingLevel }
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      freeze(child);
    }
  }
  return value;
}
