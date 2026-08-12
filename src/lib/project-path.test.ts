import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const piPackage = "@earendil-works/pi-coding-agent";

afterEach(() => {
  vi.doUnmock(piPackage);
  vi.resetModules();
});

describe("pipkinProjectDirectory", () => {
  it("uses Pi's current project configuration directory", async () => {
    const { CONFIG_DIR_NAME } = await import(piPackage);
    const { pipkinProjectDirectory } = await import("./project-path.js");
    const project = "project/../checkout";

    expect(pipkinProjectDirectory(project)).toBe(
      join(resolve(project), CONFIG_DIR_NAME, "pipkin"),
    );
  });

  it("follows Pi's configuration-directory export", async () => {
    vi.doMock(piPackage, () => ({ CONFIG_DIR_NAME: ".pi-test" }));
    const { pipkinProjectDirectory } = await import("./project-path.js");

    expect(pipkinProjectDirectory("checkout")).toBe(
      join(resolve("checkout"), ".pi-test", "pipkin"),
    );
  });
});
