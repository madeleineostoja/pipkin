type LiveCall = {
  startedAt: number;
  invalidate?: () => void;
};

/** Presentation clock only; elapsed time does not establish tool liveness. */
export class CodemodeProgress {
  #calls = new Map<string, LiveCall>();
  #timer: ReturnType<typeof setInterval> | undefined;

  start(id: string): void {
    this.#calls.set(id, { startedAt: performance.now() });
    if (this.#timer === undefined) {
      this.#timer = setInterval(() => {
        for (const call of this.#calls.values()) {
          call.invalidate?.();
        }
      }, 1000);
      this.#timer.unref?.();
    }
  }

  elapsed(id: string, invalidate: () => void): number | undefined {
    const call = this.#calls.get(id);
    if (!call) {
      return undefined;
    }
    call.invalidate = invalidate;
    return performance.now() - call.startedAt;
  }

  finish(id: string): void {
    this.#calls.delete(id);
    if (this.#calls.size === 0) {
      this.clear();
    }
  }

  clear(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    this.#calls.clear();
  }
}
