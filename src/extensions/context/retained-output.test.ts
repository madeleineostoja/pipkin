import {
  createEventBus,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  statSync,
  readdirSync,
} from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createOutputScope,
  bindOutputScope,
  reserveOutput,
  prepareOutputChild,
  inheritedOutputScope,
  type CaptureData,
} from "./retained-output.ts";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture(file: string | null = "/session.jsonl", entries = ["anchor"]) {
  const root = mkdtempSync(join(tmpdir(), "outputs-"));
  roots.push(root);
  let branch = entries.map((id) => ({ id }));
  const ctx = {
    sessionManager: {
      getSessionId: () => "session",
      getSessionFile: () => file,
      getBranch: () => branch,
      getEntries: () => branch,
    },
  } as never;
  const scope = createOutputScope(root, ctx);
  return {
    root,
    ctx,
    scope,
    branch: (ids: string[]) => {
      branch = ids.map((id) => ({ id }));
    },
  };
}
const data: CaptureData = {
  execution: {
    state: "failed",
    exitCode: 1,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
  },
  text: "diagnostic\n",
  truncated: false,
  outputComplete: true,
};
const source = { sourceTool: "bash", callId: "call" };
async function capture(f: ReturnType<typeof fixture>) {
  const result = await f.scope.reserve(f.ctx, source).commit(data);
  expect(result.retention).toBe("retained");
  if (result.retention !== "retained") {
    throw new Error("capture failed");
  }
  return result.outputRef;
}
describe("retained output scopes", () => {
  it("authorizes inherited raw ancestry across resume/forks, not siblings; freezes late settlement", async () => {
    const f = fixture();
    const pending = f.scope.reserve(f.ctx, source);
    f.branch(["other"]);
    const result = await pending.commit(data);
    if (result.retention !== "retained") {
      throw new Error("capture failed");
    }
    expect(f.scope.read(result.outputRef, f.ctx)).toBeUndefined();
    const fork = {
      sessionManager: {
        getSessionId: () => "fork",
        getSessionFile: () => "/fork.jsonl",
        getBranch: () => [{ id: "anchor" }, { id: "compaction" }],
        getEntries: () => [{ id: "anchor" }],
      },
    } as never;
    const resumed = createOutputScope(f.root, fork);
    expect(resumed.read(result.outputRef, fork)?.execution.state).toBe(
      "failed",
    );
    expect(resumed.list(fork).count).toBe(1);
    expect(f.scope.list(f.ctx)).toMatchObject({ outputs: [], count: 0 });
    f.scope.close();
    f.scope.release();
    expect(resumed.read(result.outputRef, fork)?.text).toBe(data.text);
  });
  it("rejects different raw entries sharing an anchor ID before list pagination", async () => {
    const f = fixture();
    const reference = await capture(f);
    for (const sessionId of ["unrelated", "session"]) {
      const ctx = {
        sessionManager: {
          getSessionId: () => sessionId,
          getSessionFile: () => "/other.jsonl",
          getBranch: () => [
            { id: "anchor", type: "message", timestamp: "different" },
          ],
          getEntries: () => [{ id: "anchor" }],
        },
      } as never;
      const other = createOutputScope(f.root, ctx);
      expect(other.read(reference, ctx)).toBeUndefined();
      expect(other.list(ctx, 0, 1)).toEqual({
        outputs: [],
        count: 0,
        truncated: false,
      });
    }
  });
  it("uses exact entryless ephemeral identity rather than cwd or session-wide access", async () => {
    const f = fixture(null, []);
    const reference = await capture(f);
    expect(f.scope.read(reference, f.ctx)).toBeDefined();
    const unrelated = createOutputScope(f.root, f.ctx);
    expect(unrelated.read(reference, f.ctx)).toBeUndefined();
    f.branch(["later"]);
    expect(f.scope.read(reference, f.ctx)).toBeUndefined();
    f.scope.release();
    expect(readdirSync(f.root)).toEqual([]);
  });
  it("enforces immutable files, permissions, ownership, decoded/encoded bounds and persistence failures", async () => {
    const f = fixture();
    const ref = await capture(f);
    const directory = join(f.root, f.scope.origin.scopeId);
    const file = join(directory, readdirSync(directory)[0]!);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const original = f.scope.read(ref, f.ctx)!;
    for (const corrupt of [
      { ...original, version: 2 },
      { ...original, origin: { ...original.origin, scopeId: "0".repeat(64) } },
    ]) {
      writeFileSync(file, JSON.stringify(corrupt));
      expect(f.scope.read(ref, f.ctx)).toBeUndefined();
    }
    writeFileSync(
      file,
      JSON.stringify({
        ...original,
        text: "😀".repeat(262145),
      }),
    );
    expect(f.scope.read(ref, f.ctx)).toBeUndefined();
    writeFileSync(file, "x".repeat(8 * 1024 * 1024 + 1));
    expect(f.scope.read(ref, f.ctx)).toBeUndefined();
    const badRoot = join(f.root, "not-a-directory");
    writeFileSync(badRoot, "x");
    const bad = createOutputScope(badRoot, f.ctx);
    expect(await bad.reserve(f.ctx, source).commit(data)).toEqual({
      retention: "failed",
      error: { code: "persistence_failed", message: expect.any(String) },
    });
  });
  it("closes admission without blocking held captures and retains ephemeral promotion until release", async () => {
    const parent = fixture(null);
    const bus = createEventBus();
    const grant = prepareOutputChild(parent.scope, bus, "host-attempt");
    const child = inheritedOutputScope(bus, parent.ctx)!;
    const off = bindOutputScope(bus, child);
    const handle = reserveOutput(bus, parent.ctx, source);
    child.close();
    child.release();
    expect(() => child.reserve(parent.ctx, source)).toThrow("closed");
    let drained = false;
    const drain = child.drain().then(() => {
      drained = true;
    });
    const result = await handle.commit(data);
    await drain;
    expect(drained).toBe(true);
    if (result.retention !== "retained") {
      throw new Error("capture failed");
    }
    expect(grant.takeLease().export(result.outputRef).origin.attemptId).toBe(
      "host-attempt",
    );
    const parentLease = parent.scope.promotionLease();
    expect(() => parentLease.export(result.outputRef)).toThrow("not found");
    parentLease.release();
    grant.dispose();
    off();
    await drain;
    expect(readdirSync(parent.root)).toEqual([]);
  });
  it("bounds metadata and lists authorized records before pagination", async () => {
    const f = fixture();
    for (let i = 0; i < 3; i++) {
      await f.scope
        .reserve(f.ctx, { ...source, command: "😀".repeat(2048) })
        .commit(data);
    }
    const page = f.scope.list(f.ctx, 0, 1);
    expect(page).toMatchObject({ count: 3, nextOffset: 1 });
    expect(
      f.scope.read(page.outputs[0]!.reference, f.ctx)?.source.commandTruncated,
    ).toBe(true);
    expect(() => f.scope.list(f.ctx, 0, 26)).toThrow();
    f.branch(["sibling"]);
    expect(f.scope.list(f.ctx, 0, 1)).toEqual({
      outputs: [],
      count: 0,
      truncated: false,
    });
  });
  it("resolves durable evidence after real resume, compaction, and fork even without the origin transcript file", async () => {
    const f = fixture();
    const manager = SessionManager.create("/tmp", join(f.root, "sessions"));
    const before = manager.appendMessage({
      role: "user",
      content: "before",
      timestamp: Date.now(),
    });
    manager.appendMessage(fauxAssistantMessage("first"));
    manager.appendMessage({
      role: "user",
      content: "execute",
      timestamp: Date.now(),
    });
    manager.appendLabelChange(before, "bookmark");
    const anchor = manager.appendMessage(fauxAssistantMessage("source"));
    const originalParent = manager.getEntry(anchor)!.parentId;
    const ctx = { sessionManager: manager } as never;
    const scope = createOutputScope(f.root, ctx);
    const result = await scope.reserve(ctx, source).commit(data);
    if (result.retention !== "retained") {
      throw new Error("capture failed");
    }
    const originFile = manager.getSessionFile()!;
    scope.close();
    scope.release();
    const resumed = SessionManager.open(originFile);
    resumed.appendCompaction("summary", anchor, 1000);
    const resumedCtx = { sessionManager: resumed } as never;
    expect(
      createOutputScope(f.root, resumedCtx).read(result.outputRef, resumedCtx)
        ?.text,
    ).toBe(data.text);
    resumed.createBranchedSession(resumed.getLeafId()!);
    const forkCtx = { sessionManager: resumed } as never;
    const forkScope = createOutputScope(f.root, forkCtx);
    expect(resumed.getEntry(anchor)!.parentId).not.toBe(originalParent);
    expect(forkScope.read(result.outputRef, forkCtx)).toBeDefined();
    expect(forkScope.list(forkCtx, 0, 1)).toMatchObject({
      count: 1,
      outputs: [{ reference: result.outputRef }],
    });
    const earlier = SessionManager.open(originFile);
    earlier.createBranchedSession(before);
    const earlyCtx = { sessionManager: earlier } as never;
    expect(
      createOutputScope(f.root, earlyCtx).read(result.outputRef, earlyCtx),
    ).toBeUndefined();
    rmSync(originFile);
    expect(forkScope.read(result.outputRef, forkCtx)).toBeDefined();
  });

  it("uses actual SessionManager raw branch entries", async () => {
    const f = fixture();
    const session = SessionManager.inMemory("/tmp");
    const anchor = session.appendMessage({
      role: "user",
      content: "hi",
      timestamp: Date.now(),
    });
    const ctx = { sessionManager: session } as never;
    const scope = createOutputScope(f.root, ctx);
    const result = await scope.reserve(ctx, source).commit(data);
    if (result.retention !== "retained") {
      throw new Error("capture failed");
    }
    session.branch(anchor);
    expect(scope.read(result.outputRef, ctx)).toBeDefined();
    session.resetLeaf();
    expect(scope.read(result.outputRef, ctx)).toBeUndefined();
    expect(() => scope.reserve(ctx, source)).toThrow("entryless");
  });
});
