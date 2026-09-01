import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireCheckoutLease,
  CheckoutLeaseBusyError,
  checkoutPaths,
} from "./store.js";

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "pipkin-implement-"));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const directory of roots) {
    rmSync(directory, { recursive: true, force: true });
  }
  roots.length = 0;
});

describe("checkout-local store lease", () => {
  it("keeps leases and state roots checkout-local", async () => {
    const first = root();
    const second = root();
    expect(checkoutPaths(first).root).toBe(
      join(resolve(first), CONFIG_DIR_NAME, "pipkin", "implement"),
    );
    expect(checkoutPaths(first).root).not.toBe(checkoutPaths(second).root);

    execFileSync("git", ["init", "-q"], { cwd: first });
    execFileSync("git", ["init", "-q"], { cwd: second });
    const lease = await acquireCheckoutLease({
      checkoutRoot: first,
      runId: "run-1",
      gitDir: join(first, ".git"),
      timeoutMs: 1_000,
    });
    try {
      expect(
        readFileSync(join(first, ".git", "info", "exclude"), "utf8"),
      ).toContain(`/${CONFIG_DIR_NAME}/pipkin/implement/`);
      const blocked = await acquireCheckoutLease({
        checkoutRoot: first,
        runId: "run-2",
        gitDir: join(first, ".git"),
        timeoutMs: 25,
      }).catch((error: unknown) => error);
      expect(blocked).toBeInstanceOf(CheckoutLeaseBusyError);
      expect(blocked).toMatchObject({
        owner: {
          runId: "run-1",
          pid: process.pid,
        },
      });
      expect((blocked as Error).message).toContain(
        "Last recorded owner: Implement run run-1",
      );
      const independent = await acquireCheckoutLease({
        checkoutRoot: second,
        runId: "run-2",
        gitDir: join(second, ".git"),
        timeoutMs: 1_000,
      });
      await independent.release();
    } finally {
      await lease.release();
      await lease.release();
    }
  });
});
