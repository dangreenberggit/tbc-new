/**
 * promisePool: bounded concurrency over a fixed batch of tasks, for the
 * candidate loop in rank.ts. wowsims' ui/sim/wasm/bulk_sim/batch.ts bounds its
 * candidate fan-out with `async`'s `queue`; this exists because results land at
 * their task's index regardless of finish order, and on failure the
 * lowest-index error is reported, so the outcome does not depend on
 * concurrency.
 */

/** A unit of work; `promisePool` runs it exactly once, on dispatch. */
export type PoolTask<T> = () => Promise<T>;

/**
 * Runs `tasks` with at most `n` in flight at once. Results land at their
 * task's index, so callers can key state (candidate cap, ordering) on array
 * position.
 *
 * On a rejection the returned promise rejects with the lowest-index error.
 * In-flight tasks are not cancelled (Stop uses an `AbortSignal` at the
 * `rankUpgrades` level), but no further tasks are dispatched.
 */
export async function promisePool<T>(tasks: readonly PoolTask<T>[], n: number): Promise<T[]> {
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
				// Lowest index wins, not the first to reject in wall-clock order, so
				// the reported error does not depend on pool size or sim latency.
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
	// sparse array as if it had succeeded.
	const requested = Number.isFinite(n) ? Math.trunc(n) : 1;
	const workerCount = Math.max(1, Math.min(requested, tasks.length));
	await Promise.all(Array.from({ length: workerCount }, () => worker()));

	if (hasError) throw firstError;
	return results;
}
