import { randomUUID, createHash } from "node:crypto";
import {
  mkdirSync,
  chmodSync,
  fchmodSync,
  writeFileSync,
  linkSync,
  unlinkSync,
  readdirSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { stripVTControlCharacters } from "node:util";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export {
  Presentation,
  BashResultSchema,
  ErrorSchema,
  PageParams,
  PageFields,
  RetentionFields,
} from "./output-contract.ts";

const MAX_TEXT = 1024 * 1024;
const MAX_METADATA = 16 * 1024;
const MAX_ENCODED = 8 * 1024 * 1024;
const id = z.string().regex(/^[a-f0-9]{64}$|^[a-f0-9-]{36}$/);
const identity = z.string().min(1).max(512);
const iso = z.string().datetime();
export const executionSchema = z
  .object({
    state: z.enum([
      "running",
      "completed",
      "failed",
      "cancelled",
      "timed_out",
      "stopped",
    ]),
    exitCode: z.number().int().nullable(),
    signal: z.string().max(64).nullable().optional(),
    startedAt: iso,
    endedAt: iso.optional(),
  })
  .strict();
export type Execution = z.infer<typeof executionSchema>;
const originSchema = z
  .object({
    scopeId: id,
    sessionId: identity,
    sessionFile: z.string().max(4096).nullable(),
    anchor: identity.nullable(),
    anchorFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    ephemeral: z.boolean(),
    parentScopeId: id.optional(),
    attemptId: identity.optional(),
  })
  .strict();
const sourceSchema = z
  .object({
    sourceTool: identity,
    callId: identity,
    jobId: identity.optional(),
    command: z.string().max(4096).optional(),
    cwd: z.string().max(4096).optional(),
    description: z.string().max(512).optional(),
    commandTruncated: z.boolean().optional(),
    cwdTruncated: z.boolean().optional(),
  })
  .strict();
export type CaptureSource = z.infer<typeof sourceSchema>;
const recordSchema = z
  .object({
    version: z.literal(1),
    reference: z.string().max(160),
    origin: originSchema,
    source: sourceSchema,
    createdAt: iso,
    execution: executionSchema,
    text: z.string().refine((text) => Buffer.byteLength(text) <= MAX_TEXT),
    truncated: z.boolean(),
    outputComplete: z.boolean(),
    droppedBytes: z.number().int().nonnegative(),
  })
  .strict();
export type OutputRecord = z.infer<typeof recordSchema>;
export type OutputSummary = {
  reference: string;
  sourceTool: string;
  createdAt: string;
  state: Execution["state"];
  jobId?: string;
  truncated: boolean;
};
export type Retention =
  | { retention: "retained"; outputRef: string }
  | {
      retention: "failed";
      error: { code: "persistence_failed"; message: string };
    };
export type CaptureData = {
  execution: Execution;
  text: string;
  truncated: boolean;
  outputComplete: boolean;
  droppedBytes?: number;
};
export type OutputHost = ExtensionAPI["events"];
const LOOKUP = "pipkin:context:output-lookup";
const CHILD = "pipkin:context:output-child";

export function boundedPreview(
  value: string,
  maxBytes = 2048,
): { text: string; truncated: boolean } {
  let text = "",
    bytes = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char);
    if (bytes + size > maxBytes) {
      return { text, truncated: true };
    }
    text += char;
    bytes += size;
  }
  return { text, truncated: false };
}
export function metadataPreview(value: string): {
  text: string;
  truncated: boolean;
} {
  const safe = stripVTControlCharacters(value).replace(/\p{C}/gu, " ");
  const bounded = boundedPreview(safe);
  return { text: bounded.text, truncated: bounded.truncated || safe !== value };
}
function boundedSource(source: CaptureSource): CaptureSource {
  const command =
    source.command === undefined ? undefined : metadataPreview(source.command);
  const cwd =
    source.cwd === undefined ? undefined : metadataPreview(source.cwd);
  return sourceSchema.parse({
    ...source,
    ...(command
      ? { command: command.text, commandTruncated: command.truncated }
      : {}),
    ...(cwd ? { cwd: cwd.text, cwdTruncated: cwd.truncated } : {}),
  });
}
function decode(value: unknown, reference: string): OutputRecord {
  const record = recordSchema.parse(value);
  const parts = parseOutputReference(reference);
  const expectedScope = record.origin.ephemeral
    ? record.origin.scopeId
    : createHash("sha256")
        .update(
          JSON.stringify([record.origin.sessionId, record.origin.sessionFile]),
        )
        .digest("hex");
  if (
    !parts ||
    record.reference !== reference ||
    (record.origin.anchor === null) !==
      (record.origin.anchorFingerprint === null) ||
    record.origin.scopeId !== parts.scopeId ||
    expectedScope !== parts.scopeId ||
    (!record.origin.ephemeral && record.origin.sessionFile === null) ||
    Buffer.byteLength(JSON.stringify({ ...record, text: undefined })) >
      MAX_METADATA
  ) {
    throw new Error("Invalid output ownership or metadata");
  }
  return record;
}
export function parseOutputReference(
  reference: string,
): { scopeId: string; key: string } | undefined {
  const match = /^out:v1:([a-f0-9]{64}|[a-f0-9-]{36}):([a-f0-9-]{36})$/.exec(
    reference,
  );
  return match ? { scopeId: match[1]!, key: match[2]! } : undefined;
}
// Raw entries are copied into forks. Hash their canonical persisted value, not
// a session-local ID or origin pathname, so inherited evidence stays portable.
export function entryFingerprint(entry: { id: string }): string {
  const canonical = JSON.stringify(entry, (_key, value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    return value;
  });
  return createHash("sha256").update(canonical).digest("hex");
}
export function transcriptReference(entry: { id: string }): string {
  return `transcript:v1:${Buffer.from(entry.id).toString("base64url")}:${entryFingerprint(entry)}`;
}
export function transcriptEntryIdentity(
  reference: string,
): { id: string; fingerprint: string } | undefined {
  const match = /^transcript:v1:([A-Za-z0-9_-]{1,683}):([a-f0-9]{64})$/.exec(
    reference,
  );
  if (!match) {
    return undefined;
  }
  const decoded = Buffer.from(match[1]!, "base64url").toString("utf8");
  return decoded && Buffer.from(decoded).toString("base64url") === match[1]
    ? { id: decoded, fingerprint: match[2]! }
    : undefined;
}

export class OutputScope {
  readonly origin: z.infer<typeof originSchema>;
  #closed = false;
  #disposed = false;
  #holders = 0;
  #captures = 0;
  #drainers = new Set<() => void>();
  constructor(
    readonly root: string,
    origin: z.infer<typeof originSchema>,
  ) {
    this.origin = Object.freeze(originSchema.parse(origin));
  }
  reserve(ctx: ExtensionContext, source: CaptureSource): CaptureHandle {
    if (this.#closed) {
      throw new Error("Context: output admission is closed");
    }
    if (
      ctx.sessionManager.getSessionId() !== this.origin.sessionId ||
      (ctx.sessionManager.getSessionFile() ?? null) !== this.origin.sessionFile
    ) {
      throw new Error(
        "Context: output scope does not match the active session",
      );
    }
    const branch = ctx.sessionManager.getBranch();
    const entry = branch.at(-1);
    const anchor = entry?.id ?? null;
    if (anchor === null && ctx.sessionManager.getEntries().length !== 0) {
      throw new Error(
        "Context: an unanchored capture requires an entryless scope",
      );
    }
    return this.handle(
      Object.freeze({
        ...this.origin,
        anchor,
        anchorFingerprint: entry ? entryFingerprint(entry) : null,
      }),
      Object.freeze(boundedSource(source)),
    );
  }
  private handle(
    origin: OutputRecord["origin"],
    source: CaptureSource,
  ): CaptureHandle {
    const release = this.hold("capture");
    let finished = false;
    return {
      origin,
      source,
      snapshot: (data) => {
        if (finished) {
          throw new Error("Context: capture released");
        }
        return this.persist(origin, source, data);
      },
      commit: async (data) => {
        if (finished) {
          throw new Error("Context: capture released");
        }
        try {
          return await this.persist(origin, source, data);
        } finally {
          finished = true;
          release();
        }
      },
      release: () => {
        if (!finished) {
          finished = true;
          release();
        }
      },
    };
  }
  private async persist(
    origin: OutputRecord["origin"],
    source: CaptureSource,
    data: CaptureData,
  ): Promise<Retention> {
    let temporary: string | undefined;
    let ownsTemporary = false;
    try {
      const key = randomUUID();
      const reference = `out:v1:${origin.scopeId}:${key}`;
      const record = decode(
        {
          version: 1,
          reference,
          origin,
          source,
          createdAt: new Date().toISOString(),
          ...data,
          droppedBytes: data.droppedBytes ?? 0,
        },
        reference,
      );
      const directory = join(this.root, origin.scopeId);
      mkdirSync(this.root, { recursive: true, mode: 0o700 });
      chmodSync(this.root, 0o700);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      temporary = join(directory, `.${key}.tmp`);
      const fd = openSync(temporary, "wx", 0o600);
      ownsTemporary = true;
      try {
        fchmodSync(fd, 0o600);
        writeFileSync(fd, JSON.stringify(record));
      } finally {
        closeSync(fd);
      }
      linkSync(temporary, join(directory, `${key}.json`));
      return { retention: "retained", outputRef: reference };
    } catch {
      return {
        retention: "failed",
        error: {
          code: "persistence_failed",
          message: "Context could not persist execution output.",
        },
      };
    } finally {
      if (temporary && ownsTemporary) {
        try {
          unlinkSync(temporary);
        } catch {}
      }
    }
  }
  authorized(record: OutputRecord, ctx: ExtensionContext): boolean {
    if (
      record.origin.ephemeral &&
      record.origin.scopeId !== this.origin.scopeId
    ) {
      return false;
    }
    if (record.origin.anchor === null) {
      return (
        record.origin.scopeId === this.origin.scopeId &&
        ctx.sessionManager.getSessionId() === this.origin.sessionId &&
        (ctx.sessionManager.getSessionFile() ?? null) ===
          this.origin.sessionFile &&
        ctx.sessionManager.getEntries().length === 0
      );
    }
    return ctx.sessionManager
      .getBranch()
      .some(
        (entry) =>
          entry.id === record.origin.anchor &&
          entryFingerprint(entry) === record.origin.anchorFingerprint,
      );
  }
  read(reference: string, ctx: ExtensionContext): OutputRecord | undefined {
    const record = this.load(reference);
    return record && this.authorized(record, ctx) ? record : undefined;
  }
  private load(reference: string): OutputRecord | undefined {
    const parsed = parseOutputReference(reference);
    if (!parsed) {
      return undefined;
    }
    let fd: number | undefined;
    try {
      fd = openSync(join(this.root, parsed.scopeId, `${parsed.key}.json`), "r");
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_ENCODED) {
        return undefined;
      }
      const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_ENCODED + 1));
      let bytes = 0;
      while (bytes < buffer.length) {
        const read = readSync(fd, buffer, bytes, buffer.length - bytes, null);
        if (!read) {
          break;
        }
        bytes += read;
      }
      if (bytes > MAX_ENCODED) {
        return undefined;
      }
      return decode(
        JSON.parse(buffer.subarray(0, bytes).toString("utf8")),
        reference,
      );
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) {
        closeSync(fd);
      }
    }
  }
  list(
    ctx: ExtensionContext,
    offset = 0,
    limit = 25,
  ): {
    outputs: OutputSummary[];
    count: number;
    nextOffset?: number;
    truncated: false;
  } {
    validatePage(offset, limit);
    const records: OutputSummary[] = [];
    let directories: string[];
    try {
      directories = readdirSync(this.root);
    } catch {
      directories = [];
    }
    for (const scopeId of directories) {
      if (!id.safeParse(scopeId).success) {
        continue;
      }
      let files: string[];
      try {
        files = readdirSync(join(this.root, scopeId));
      } catch {
        continue;
      }
      for (const file of files) {
        if (!/^[a-f0-9-]{36}\.json$/.test(file)) {
          continue;
        }
        const record = this.read(`out:v1:${scopeId}:${file.slice(0, -5)}`, ctx);
        if (record) {
          records.push({
            reference: record.reference,
            sourceTool: record.source.sourceTool,
            createdAt: record.createdAt,
            state: record.execution.state,
            ...(record.source.jobId ? { jobId: record.source.jobId } : {}),
            truncated: record.truncated,
          });
        }
      }
    }
    records.sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) ||
        a.reference.localeCompare(b.reference),
    );
    return {
      outputs: records.slice(offset, offset + limit),
      count: records.length,
      ...(offset + limit < records.length
        ? { nextOffset: offset + limit }
        : {}),
      truncated: false,
    };
  }
  promotionLease(): PromotionLease {
    if (this.#closed) {
      throw new Error("Context: output admission is closed");
    }
    const release = this.hold("promotion");
    let released = false;
    return {
      export: (reference) => {
        if (released) {
          throw new Error("Context: promotion lease released");
        }
        const record = this.load(reference);
        if (
          !record ||
          record.origin.scopeId !== this.origin.scopeId ||
          record.origin.attemptId !== this.origin.attemptId
        ) {
          throw new Error("Context: output not found");
        }
        return record;
      },
      release: () => {
        if (!released) {
          released = true;
          release();
        }
      },
    };
  }
  private hold(kind: "capture" | "promotion"): () => void {
    if (this.#disposed) {
      throw new Error("Context: output scope disposed");
    }
    this.#holders++;
    if (kind === "capture") {
      this.#captures++;
    }
    return () => {
      this.#holders--;
      if (kind === "capture") {
        this.#captures--;
      }
      this.cleanup();
    };
  }
  close(): void {
    this.#closed = true;
  }
  drain(): Promise<void> {
    return this.#captures === 0
      ? Promise.resolve()
      : new Promise((resolve) => this.#drainers.add(resolve));
  }
  release(): void {
    this.#closed = true;
    this.#disposed = true;
    this.cleanup();
  }
  private cleanup(): void {
    if (this.#captures === 0) {
      for (const resolve of this.#drainers) {
        resolve();
      }
      this.#drainers.clear();
    }
    if (this.#holders !== 0) {
      return;
    }
    if (this.#disposed && this.origin.ephemeral) {
      rmSync(join(this.root, this.origin.scopeId), {
        recursive: true,
        force: true,
      });
    }
  }
}
export type CaptureHandle = Readonly<{
  origin: OutputRecord["origin"];
  source: CaptureSource;
  commit: (data: CaptureData) => Promise<Retention>;
  snapshot: (data: CaptureData) => Promise<Retention>;
  release: () => void;
}>;
export type PromotionLease = {
  export: (reference: string) => OutputRecord;
  release: () => void;
};
export function validatePage(offset: number, limit: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 25
  ) {
    throw new Error("Invalid output pagination");
  }
}
export function createOutputScope(
  root: string,
  ctx: ExtensionContext,
  provenance?: { parentScopeId: string; attemptId: string },
): OutputScope {
  const sessionId = ctx.sessionManager.getSessionId();
  const sessionFile = ctx.sessionManager.getSessionFile() ?? null;
  const ephemeral = sessionFile === null || provenance !== undefined;
  const scopeId = ephemeral
    ? randomUUID()
    : createHash("sha256")
        .update(JSON.stringify([sessionId, sessionFile]))
        .digest("hex");
  return new OutputScope(root, {
    scopeId,
    sessionId,
    sessionFile,
    anchor: null,
    anchorFingerprint: null,
    ephemeral,
    ...provenance,
  });
}
export function bindOutputScope(
  host: OutputHost,
  scope: OutputScope,
): () => void {
  return host.on(LOOKUP, (value) =>
    (value as { resolve: (scope: OutputScope) => void }).resolve(scope),
  );
}
export function outputScope(host: OutputHost): OutputScope {
  let scope: OutputScope | undefined;
  host.emit(LOOKUP, {
    resolve: (value: OutputScope) => {
      scope ??= value;
    },
  });
  if (!scope) {
    throw new Error("Context: retained output is unavailable");
  }
  return scope;
}
export function reserveOutput(
  host: OutputHost,
  ctx: ExtensionContext,
  source: CaptureSource,
): CaptureHandle {
  return outputScope(host).reserve(ctx, source);
}
export function prepareOutputChild(
  parent: OutputScope,
  childHost: OutputHost,
  attemptId: string,
): { takeLease: () => PromotionLease; dispose: () => void } {
  identity.parse(attemptId);
  const parentLease = parent.promotionLease();
  let child: OutputScope | undefined;
  let lease: PromotionLease | undefined;
  const off = childHost.on(CHILD, (value) => {
    const request = value as {
      ctx: ExtensionContext;
      resolve: (scope: OutputScope) => void;
    };
    child ??= createOutputScope(parent.root, request.ctx, {
      parentScopeId: parent.origin.scopeId,
      attemptId,
    });
    lease ??= child.promotionLease();
    request.resolve(child);
  });
  return {
    takeLease: () => {
      if (!lease) {
        throw new Error("Context: child not initialized");
      }
      return lease;
    },
    dispose: () => {
      off();
      try {
        lease?.release();
      } finally {
        try {
          child?.release();
        } finally {
          parentLease.release();
        }
      }
    },
  };
}
export function inheritedOutputScope(
  host: OutputHost,
  ctx: ExtensionContext,
): OutputScope | undefined {
  let scope: OutputScope | undefined;
  host.emit(CHILD, {
    ctx,
    resolve: (value: OutputScope) => {
      scope ??= value;
    },
  });
  return scope;
}
