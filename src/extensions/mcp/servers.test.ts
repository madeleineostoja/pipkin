import { describe, expect, it } from "vitest";
import { parsePipkinConfig, parseProjectPipkinConfig } from "#lib/config";
import {
  adapterMcpServers,
  mergeMcpServers,
  projectAdapterName,
  projectSlug,
} from "./servers.ts";

describe("MCP server identities", () => {
  it("keeps global names and qualifies project overrides", () => {
    const root = "/checkouts/My Project!";
    const effective = mergeMcpServers(
      {
        docs: {
          url: "https://global.test",
          oauth: { clientName: "Global Client" },
        },
        shared: { url: "https://shared.test" },
      },
      {
        docs: {
          url: "https://project.test",
          oauth: { clientName: "Project Client" },
        },
      },
    );
    const adapter = adapterMcpServers(effective, root);
    const projectName = projectAdapterName(root, "docs");
    expect(adapter).toEqual({
      [projectName]: {
        url: "https://project.test",
        oauth: { clientName: "Project Client" },
      },
      shared: { url: "https://shared.test" },
    });
    expect(Object.isFrozen(effective.docs?.oauth)).toBe(true);
    expect(Object.isFrozen(adapter[projectName]?.oauth)).toBe(true);
  });

  it("retains a global server when an invalid project override is omitted", () => {
    const global = parsePipkinConfig(
      JSON.stringify({ mcp: { docs: { url: "https://global.test" } } }),
    );
    const project = parseProjectPipkinConfig(
      JSON.stringify({ mcp: { docs: { url: "ftp://project.test" } } }),
    );

    expect(mergeMcpServers(global.config.mcp, project.config.mcp)).toEqual({
      docs: { url: "https://global.test", origin: "global" },
    });
    expect(project.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "mcp.docs.url", scope: "project" }),
      ]),
    );
    expect(global.issues.every((issue) => issue.scope === "global")).toBe(true);
  });

  it("creates exact bounded names from canonical roots", () => {
    expect(projectSlug("___My Project!!!___")).toBe("my_project");
    expect(projectSlug("abcdefghijklmnopqrstuvw-z")).toBe(
      "abcdefghijklmnopqrstuvw",
    );
    expect(projectSlug("___")).toBe("project");
    expect(projectAdapterName("/checkouts/___My Project!!!___", "docs")).toBe(
      "project__my_project_60efcc9a673d__docs",
    );

    const root = "/checkouts/abcdefghijklmnopqrstuvwxyz_ignored";
    const maximum = projectAdapterName(root, "a".repeat(64));
    expect(maximum).toMatch(
      /^project__abcdefghijklmnopqrstuvwx_dffd841e11de__a{64}$/,
    );
    expect(maximum).toHaveLength(112);
    expect(projectAdapterName("/one/repo", "docs")).not.toBe(
      projectAdapterName("/two/repo", "docs"),
    );
  });
});
