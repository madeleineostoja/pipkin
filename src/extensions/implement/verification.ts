import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { PromotionLease } from "#context/retained-output";
import { executionSchema } from "#context/retained-output";
import { writeAtomicJson } from "./atomic-json.js";
import { ExecGitClient } from "./git.js";

const text = z.string().trim().min(1).max(4000);
const reportedVerificationSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("inspection"), label: text, evidence: text })
    .strict(),
  z.object({ kind: z.literal("not_run"), label: text, reason: text }).strict(),
]);
const relativeArtifact = z
  .string()
  .regex(/^artifacts\/verification\/[a-f0-9]{64}\.json$/);
export const verificationSchema = z.union([
  reportedVerificationSchema,
  z.object({ kind: z.literal("legacy"), text: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("execution"),
      label: text,
      artifactPath: relativeArtifact,
      outcome: z.enum(["passed", "failed"]),
      execution: executionSchema.refine(
        (execution) =>
          execution.state !== "running" && execution.endedAt !== undefined,
      ),
      sourceTool: z.string().min(1).max(512),
      command: z.string().max(4096).optional(),
      commandTruncated: z.boolean(),
      truncated: z.boolean(),
      outputComplete: z.boolean(),
      droppedBytes: z.number().int().nonnegative(),
      attemptId: z.string().min(1).max(512),
      workerId: z.string().min(1).max(512),
      candidateCommitSha: z.string().min(1),
      candidateCoverage: z.literal("not_attested"),
      capturedAt: z.string().datetime(),
    })
    .strict()
    .refine((record) =>
      record.outcome === "passed"
        ? record.execution.state === "completed" &&
          record.execution.exitCode === 0
        : record.execution.state === "failed" &&
          record.execution.exitCode !== 0,
    ),
]);
export type Verification = z.infer<typeof verificationSchema>;
export type PersistedCompletion<T> = T extends { verification: unknown }
  ? Omit<T, "verification"> & { verification: Verification[] }
  : T;
const workerVerificationSchema = z.union([
  reportedVerificationSchema,
  z
    .object({
      kind: z.literal("execution"),
      label: text,
      outputRef: z.string().min(1).max(160),
      claimedOutcome: z.enum(["passed", "failed"]),
    })
    .strict(),
]);

export async function promoteVerification(args: {
  verification: unknown;
  lease: PromotionLease;
  cwd: string;
  runDirectory: string;
  workerId: string;
}): Promise<Verification[]> {
  const selected = z
    .array(workerVerificationSchema)
    .min(1)
    .max(100)
    .parse(args.verification);
  // Export validates scope and host-assigned attempt ownership. Validate the whole
  // selection before writing anything, never downgrade rejected receipts to prose.
  const records = selected.map((item) => {
    if (item.kind !== "execution") {
      return undefined;
    }
    const record = args.lease.export(item.outputRef);
    if (
      !record.origin.attemptId ||
      record.source.cwdTruncated ||
      !record.source.cwd ||
      resolve(record.source.cwd) !== resolve(args.cwd)
    ) {
      throw new Error(
        "Verification execution belongs to a different worktree or attempt.",
      );
    }
    const passed =
      record.execution.state === "completed" && record.execution.exitCode === 0;
    const failed =
      record.execution.state === "failed" && record.execution.exitCode !== 0;
    if (
      !record.execution.endedAt ||
      (item.claimedOutcome === "passed" ? !passed : !failed)
    ) {
      throw new Error(
        "Verification claim does not match a terminal captured execution.",
      );
    }
    return record;
  });
  const candidateCommitSha = records.some(Boolean)
    ? await new ExecGitClient(args.cwd).head()
    : undefined;
  return selected.map((item, index) => {
    if (item.kind !== "execution") {
      return item;
    }
    const record = records[index]!;
    const key = createHash("sha256")
      .update(JSON.stringify([record.reference, item.label]))
      .digest("hex");
    const artifactPath = `artifacts/verification/${key}.json`;
    const descriptor = verificationSchema.parse({
      kind: "execution",
      label: item.label,
      artifactPath,
      outcome: item.claimedOutcome,
      execution: record.execution,
      sourceTool: record.source.sourceTool,
      ...(record.source.command === undefined
        ? {}
        : { command: record.source.command }),
      commandTruncated: record.source.commandTruncated ?? false,
      truncated: record.truncated,
      outputComplete: record.outputComplete,
      droppedBytes: record.droppedBytes,
      attemptId: record.origin.attemptId,
      workerId: args.workerId,
      candidateCommitSha,
      candidateCoverage: "not_attested",
      capturedAt: record.createdAt,
    });
    mkdirSync(join(args.runDirectory, "artifacts", "verification"), {
      recursive: true,
    });
    writeAtomicJson(join(args.runDirectory, artifactPath), {
      version: 1,
      verification: descriptor,
      output: record.text,
    });
    return descriptor;
  });
}

export function verificationText(record: Verification): string {
  switch (record.kind) {
    case "legacy":
      return `Legacy reported text (no capture): ${record.text}`;
    case "inspection":
      return `Worker-reported inspection — ${record.label}: ${record.evidence}`;
    case "not_run":
      return `Not run — ${record.label}: ${record.reason}`;
    case "execution":
      return `Captured ${record.outcome} — ${record.label}: ${record.artifactPath} · attempt ${record.attemptId} · candidate observed ${record.candidateCommitSha}; later changes are not excluded${record.truncated ? " · output truncated" : ""}${record.commandTruncated ? " · command preview truncated" : ""}`;
  }
}
