/**
 * promisePool — bounded concurrency over a fixed batch of tasks.
 *
 * Pure and I/O-free: it knows nothing about sims, candidates or gear. The
 * candidate loop in rank.ts is the only caller today (PLAN.md §5 M1), and
 * keeping this generic is what let 7.9 test it without a SimRunner fixture.
 */

/** A unit of work; `promisePool` runs it exactly once, on dispatch. */
export type PoolTask<T> = () => Promise<T>;

/**
 * Runs `tasks` with at most `n` in flight at once. Results land at the same
 * index as their task, regardless of completion order — a caller keying
 * downstream state on array position (candidate cap, ordering) must not see
 * results reshuffled by which one happened to finish first.
 *
 * On any task's rejection, the returned promise rejects with that same
 * error. In-flight tasks are not cancelled — there is no cooperative
 * cancellation primitive here (Stop uses `AbortSignal` at the `rankUpgrades`
 * level instead) — but no further tasks are dispatched once a rejection has
 * been observed.
 */
export async function promisePool<T>(
  tasks: readonly PoolTask<T>[],
  n: number
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;
  let firstError: unknown;
  let firstErrorIndex = Number.POSITIVE_INFINITY;
  let hasError = false;

  async function worker(): Promise<void> {
    for (;;) {
      if (hasError) return;
      const index = nextIndex;
      if (index >= tasks.length) return;
      nextIndex += 1;
      const task = tasks[index]!;
      try {
        results[index] = await task();
      } catch (err) {
        // Lowest index wins, not whichever rejected first in wall-clock
        // order: with two tasks failing in one drain, a time-ordered winner
        // makes the surfaced error depend on pool size and sim latency, and
        // the caller's "same error at any concurrency" guarantee is exactly
        // what a bounded pool is supposed to preserve.
        if (index < firstErrorIndex) {
          firstErrorIndex = index;
          firstError = err;
        }
        hasError = true;
        return;
      }
    }
  }

  // `Math.min(NaN, len)` is NaN and `Array.from({length: NaN})` is empty, so
  // a non-finite `n` would spawn zero workers, run nothing, and return a
  // sparse array as if it had succeeded. No caller passes one today; this
  // exists so the silent-success path cannot be reintroduced by one.
  const requested = Number.isFinite(n) ? Math.trunc(n) : 1;
  const workerCount = Math.max(1, Math.min(requested, tasks.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (hasError) throw firstError;
  return results;
}
