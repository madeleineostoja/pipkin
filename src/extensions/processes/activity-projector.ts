import { stripVTControlCharacters } from "node:util";
import {
  ACTIVITY_DETAIL_BYTE_LIMIT,
  ACTIVITY_TEXT_BYTE_LIMIT,
  createActivityPublisher,
  type ActivityPublisher,
} from "#ui/activity";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { ProcessSnapshot, ProcessRuntime } from "./runtime.js";

type Notify = (message: string, level: "warning") => void;

export class ProcessActivityProjector {
  #publisher: ActivityPublisher | undefined;
  #unsubscribe: (() => void) | undefined;
  #activityIds = new Map<string, string>();
  #published = new Set<string>();
  #started = new Set<string>();
  #notifiedFailures = new Set<string>();
  #nextActivityId = 1;

  constructor(
    private readonly runtime: ProcessRuntime,
    private readonly events: EventBus,
  ) {}

  start(notify?: Notify): void {
    this.dispose();
    this.#publisher = createActivityPublisher(this.events, "processes");
    this.#unsubscribe = this.runtime.subscribe((snapshots) =>
      this.publish(snapshots, notify),
    );
    this.publish(this.runtime.snapshots(), notify);
  }

  dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#publisher?.dispose();
    this.#publisher = undefined;
    this.#activityIds.clear();
    this.#published.clear();
    this.#started.clear();
    this.#notifiedFailures.clear();
    this.#nextActivityId = 1;
  }

  private publish(
    snapshots: readonly ProcessSnapshot[],
    notify: Notify | undefined,
  ): void {
    const publisher = this.#publisher;
    if (!publisher) {
      return;
    }
    const processIds = new Set(snapshots.map((snapshot) => snapshot.id));
    const next = new Set<string>();
    for (const processId of this.#published) {
      if (
        !processIds.has(processId) ||
        terminal(snapshotFor(snapshots, processId))
      ) {
        const activityId = this.#activityIds.get(processId);
        if (activityId) {
          publisher.remove(activityId);
        }
      }
    }
    for (const processId of this.#activityIds.keys()) {
      if (!processIds.has(processId)) {
        this.#activityIds.delete(processId);
        this.#started.delete(processId);
        this.#notifiedFailures.delete(processId);
      }
    }
    for (const snapshot of snapshots) {
      if (snapshot.status === "running") {
        this.#started.add(snapshot.id);
        const activityId = this.#activityId(snapshot.id);
        next.add(snapshot.id);
        publisher.upsert({
          id: activityId,
          label: "Process",
          title: bounded(snapshot.description),
          detail: bounded(
            `$ ${snapshot.command}`,
            480,
            ACTIVITY_DETAIL_BYTE_LIMIT,
          ),
          state: "running",
          ...(timestamp(snapshot.startedAt) === undefined
            ? {}
            : { startedAt: timestamp(snapshot.startedAt) }),
          updatedAt: timestamp(snapshot.startedAt) ?? Date.now(),
        });
      } else if (
        snapshot.status === "failed" &&
        this.#started.has(snapshot.id) &&
        !this.#notifiedFailures.has(snapshot.id)
      ) {
        this.#notifiedFailures.add(snapshot.id);
        notify?.(
          `Managed process failed: ${bounded(snapshot.description)}`,
          "warning",
        );
      }
    }
    this.#published = next;
  }

  #activityId(processId: string): string {
    const existing = this.#activityIds.get(processId);
    if (existing) {
      return existing;
    }
    const activityId = `entry-${this.#nextActivityId++}`;
    this.#activityIds.set(processId, activityId);
    return activityId;
  }
}

function snapshotFor(
  snapshots: readonly ProcessSnapshot[],
  id: string,
): ProcessSnapshot | undefined {
  return snapshots.find((snapshot) => snapshot.id === id);
}

function terminal(snapshot: ProcessSnapshot | undefined): boolean {
  return snapshot !== undefined && snapshot.status !== "running";
}

function timestamp(value: string | undefined): number | undefined {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function bounded(
  value: string,
  length = 240,
  byteLimit = ACTIVITY_TEXT_BYTE_LIMIT,
): string {
  const compact = stripVTControlCharacters(value)
    .replace(/\p{C}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const characters = Array.from(compact);
  if (characters.length <= length && Buffer.byteLength(compact) <= byteLimit) {
    return compact || "Managed process";
  }
  const retained = characters.slice(0, length - 1);
  while (
    retained.length > 0 &&
    Buffer.byteLength(`${retained.join("")}…`) > byteLimit
  ) {
    retained.pop();
  }
  return `${retained.join("")}…`;
}
