export const EPOCH_KINDS = ["known-cold", "warm", "tail"] as const;
export type EpochKind = (typeof EPOCH_KINDS)[number];

export const ELISION_REASONS = [
  "superseded-read",
  "duplicate-read",
  "covered-read",
  "after-consumption-bash",
  "standard-stale",
] as const;
export type ElisionReason = (typeof ELISION_REASONS)[number];

export const PRUNING_TYPE = "pipkin.context.pruning.v1";

export type PruningMilestone = {
  kind: EpochKind;
  count: number;
  estimatedTokensSaved: number;
  reasons: Partial<Record<ElisionReason, number>>;
};

export type PruningState = {
  warmEpochEntryId?: string;
  warmedMarkerId?: string;
  pending?: { leafId: string | null; milestone: PruningMilestone };
  reportedInvalidEntry: boolean;
  reportedAppendFailure: boolean;
};

export function createPruningState(): PruningState {
  return {
    reportedInvalidEntry: false,
    reportedAppendFailure: false,
  };
}

export function isPruningMilestone(value: unknown): value is PruningMilestone {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["kind", "count", "estimatedTokensSaved", "reasons"]) &&
    isEpochKind(value.kind) &&
    isPositiveSafeInteger(value.count) &&
    isPositiveSafeInteger(value.estimatedTokensSaved) &&
    isRecord(value.reasons) &&
    hasOnlyKeys(value.reasons, ELISION_REASONS) &&
    Object.values(value.reasons).every(isPositiveSafeInteger) &&
    Object.values(value.reasons).reduce<number>(
      (sum, count) => sum + (count as number),
      0,
    ) === value.count
  );
}

export function isEpochKind(value: unknown): value is EpochKind {
  return typeof value === "string" && EPOCH_KINDS.includes(value as EpochKind);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
