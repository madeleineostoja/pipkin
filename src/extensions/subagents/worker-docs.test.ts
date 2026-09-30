import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DefaultResourceLoader,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { loadWorkerDocs } from "./worker-docs.js";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pipkin-worker-docs-"));
  const cwd = join(root, "project"),
    agentDir = join(root, "agent");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  mkdirSync(agentDir);
  let pi!: ExtensionAPI;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    extensionFactories: [
      (api) => {
        pi = api;
      },
    ],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.reload();
  function config(scope: "global" | "project", entry: unknown) {
    writeFileSync(
      join(scope === "global" ? agentDir : join(cwd, ".pi"), "mcp.json"),
      JSON.stringify({
        mcpServers: {
          context7: entry,
          figma: { url: "https://unrelated.invalid" },
        },
      }),
    );
  }
  return {
    pi,
    cwd,
    agentDir,
    config,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
describe("worker Context7 selection", () => {
  it("provisions nothing without an entry, ignores untrusted project config, and replaces a global entry wholesale", async () => {
    const f = await fixture();
    try {
      expect(loadWorkerDocs(f.pi, f.agentDir, f.cwd, false)).toEqual({
        servers: [],
        errors: [],
      });
      f.config("global", {
        url: "https://global.invalid",
        headers: { Authorization: "${TOKEN}" },
      });
      // An untrusted file must not even be parsed.
      writeFileSync(join(f.cwd, ".pi", "mcp.json"), "invalid JSON");
      expect(
        loadWorkerDocs(f.pi, f.agentDir, f.cwd, false).servers[0]?.config,
      ).toMatchObject({ url: "https://global.invalid" });
      expect(loadWorkerDocs(f.pi, f.agentDir, f.cwd, true)).toMatchObject({
        servers: [],
        errors: [expect.any(String)],
      });
      f.config("project", {
        command: "native-command",
        args: ["${ARG}"],
        env: { VALUE: "!native-command" },
      });
      const selected = loadWorkerDocs(f.pi, f.agentDir, f.cwd, true);
      expect(selected.servers).toHaveLength(1);
      expect(selected.servers[0]).toMatchObject({
        name: "context7",
        scope: "project",
        config: {
          command: "native-command",
          exposure: "hidden",
          toolExposure: {
            "resolve-library-id": "deferred",
            "query-docs": "deferred",
          },
        },
      });
      expect(selected.servers[0]?.config).not.toHaveProperty("headers");
      expect(f.pi.getMcpServers()).toEqual([]);
    } finally {
      f.close();
    }
  });
  it("does not fall back on invalid/disabled selection, and intersects explicit and wildcard hidden choices", async () => {
    const f = await fixture();
    try {
      f.config("global", { url: "https://global.invalid" });
      f.config("project", { url: 42 });
      expect(loadWorkerDocs(f.pi, f.agentDir, f.cwd, true).servers).toEqual([]);
      f.config("project", { url: "https://project.invalid", enabled: false });
      expect(loadWorkerDocs(f.pi, f.agentDir, f.cwd, true).servers).toEqual([]);
      f.config("project", {
        url: "https://project.invalid",
        toolExposure: { "*": "hidden", "query-docs": "direct" },
      });
      expect(
        loadWorkerDocs(f.pi, f.agentDir, f.cwd, true).servers[0]?.config
          .toolExposure,
      ).toEqual({ "resolve-library-id": "hidden", "query-docs": "deferred" });
      f.config("project", {
        url: "https://project.invalid",
        exposure: "hidden",
      });
      expect(loadWorkerDocs(f.pi, f.agentDir, f.cwd, true)).toMatchObject({
        servers: [],
        errors: [expect.stringContaining("hidden")],
      });
    } finally {
      f.close();
    }
  });
});
