/**
 * At most `limit` calls in any `windowMs`, waiting rather than failing.
 *
 * For APIs that count requests per rolling minute and refuse the next one: a
 * refusal costs the data it was fetching, a wait costs only time, and the
 * nightly run has the time. Waiters are served in the order they arrived, so a
 * burst drains in order rather than by whichever timer fires first.
 */
export class RateWindow {
  private readonly sent: number[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** Forget the calls counted so far. */
  reset(): void {
    this.sent.length = 0;
  }

  /** Resolves when a call may be made, and counts it. */
  take(): Promise<void> {
    const turn = this.queue.then(async () => {
      for (;;) {
        const t = this.now();
        while (this.sent.length && t - this.sent[0] >= this.windowMs) this.sent.shift();
        if (this.sent.length < this.limit) {
          this.sent.push(t);
          return;
        }
        await this.sleep(this.windowMs - (t - this.sent[0]));
      }
    });
    this.queue = turn.catch(() => { /* a failed turn must not stall the queue */ });
    return turn;
  }
}
