/**
 * Background work for one query box (the search modal, the `@@` list): debounced jobs such as the semantic merge and
 * the Zotero lookup, which belong to the query on screen. Every new query supersedes the old one's jobs, whether or not
 * it schedules any itself: pending ones are cancelled, and ones already in flight see `isCurrent(token)` turn false.
 * Closing the box (`cancel`) does the same.
 */
export class QueryJobs {
  private generation = 0;
  private timers = new Set<unknown>();
  private setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private clearTimeoutFn: (id: unknown) => void;

  constructor(
    setTimeoutFn: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms),
    clearTimeoutFn: (id: unknown) => void = (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  ) {
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
  }

  /** Cancel the previous query's jobs; returns the token for this query's. */
  restart(): number {
    this.cancel();
    return this.generation;
  }

  cancel(): void {
    this.generation++;
    for (const id of this.timers) this.clearTimeoutFn(id);
    this.timers.clear();
  }

  /** False once the query that `token` belongs to has been superseded or the box closed: drop the result. */
  isCurrent(token: number): boolean {
    return token === this.generation;
  }

  /** Run `job` after `ms` (a debounce), unless the query changes first. */
  after(ms: number, job: () => unknown): void {
    const id = this.setTimeoutFn(() => {
      this.timers.delete(id);
      job();
    }, ms);
    this.timers.add(id);
  }
}
