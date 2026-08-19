/**
 * "At most N of these at once", by waiting rather than by cancelling.
 *
 * Hatchet's own concurrency option cannot express this against the engine we
 * run. It offers three strategies, and all three resolve a contended limit by
 * killing something: CANCEL_IN_PROGRESS and CANCEL_NEWEST say so in the name,
 * and GROUP_ROUND_ROBIN preempts a running task to rotate the next one in. That
 * last one is what a first cut used, and the result was worse than no limit at
 * all: a preempted Distill call kept running — the SDK says plainly that
 * "JavaScript cannot force-kill user code" — while Hatchet started a second
 * copy of it. One symbol generated its briefing three times over six minutes.
 *
 * So the wait happens here instead. Tasks queue in Hatchet as before; this only
 * decides how many of them proceed past the gate at once.
 *
 * The limit is per worker process, not per tenant. With the single worker this
 * deploys as, that is the same thing. It stops being the same thing the moment
 * a second worker is started, and the ceiling becomes N per worker — worth
 * knowing before scaling out, since the reason Distill is capped at one is a
 * machine at home that answers one request at a time.
 */

export class Gate {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {
    if (limit < 1) throw new Error(`Gate limit must be at least 1, got ${limit}`);
  }

  /** Run `fn` once a slot is free, releasing it however `fn` ends. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /** How many are waiting for a slot — for logging, not for decisions. */
  get queued(): number {
    return this.waiting.length;
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    // Hand the slot straight over rather than decrementing and letting the
    // waiter re-check: between those two steps another caller could take it.
    if (next) next();
    else this.active--;
  }
}
