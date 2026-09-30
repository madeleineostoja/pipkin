import { describe, expect, it, vi } from "vitest";
import { bindSandboxHost, prepareSandboxChild } from "./runtime.js";

function host() {
  return {} as never;
}

describe("Sandbox runtime handoff", () => {
  it("snapshots parent state and requested write mode once at preparation", () => {
    const parent = host();
    const child = host();
    let enabled = false;
    const parentBinding = bindSandboxHost(parent, () => enabled);
    prepareSandboxChild(parent, child, "repository-read-only");
    enabled = true;
    const childBinding = bindSandboxHost(child, () => true);

    expect(childBinding.inherited).toEqual({
      enabled: false,
      writeMode: "repository-read-only",
    });
    expect(bindSandboxHost(child, () => false).inherited).toBeUndefined();
    childBinding.dispose();
    parentBinding.dispose();
  });

  it("does not prepare inheritance without a parent binding", () => {
    expect(prepareSandboxChild(host(), host())).toBeUndefined();
  });

  it("keeps parallel child handoffs isolated", () => {
    const parent = host();
    const firstChild = host();
    const secondChild = host();
    let enabled = false;
    const parentBinding = bindSandboxHost(parent, () => enabled);
    prepareSandboxChild(parent, firstChild);
    enabled = true;
    prepareSandboxChild(parent, secondChild);

    expect(bindSandboxHost(firstChild, () => true).inherited?.enabled).toBe(
      false,
    );
    expect(bindSandboxHost(secondChild, () => false).inherited?.enabled).toBe(
      true,
    );
    parentBinding.dispose();
  });

  it("disposes idempotently and cannot remove a replacement binding", () => {
    const parent = host();
    const first = bindSandboxHost(parent, () => false);
    const second = bindSandboxHost(parent, () => true);
    first.dispose();
    first.dispose();
    const child = host();

    prepareSandboxChild(parent, child);
    expect(bindSandboxHost(child, () => false).inherited?.enabled).toBe(true);
    second.dispose();
    second.dispose();
    expect(prepareSandboxChild(parent, host())).toBeUndefined();
  });

  it("shares the protocol through separate module loads", async () => {
    const parent = host();
    const child = host();
    const parentBinding = bindSandboxHost(parent, () => false);
    vi.resetModules();
    const reloaded = await import("./runtime.js");

    reloaded.prepareSandboxChild(parent, child);
    expect(reloaded.bindSandboxHost(child, () => true).inherited?.enabled).toBe(
      false,
    );
    parentBinding.dispose();
  });
});
