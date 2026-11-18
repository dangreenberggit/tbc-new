/**
 * Bounded concurrency for rank.ts's candidate loop. ui/sim/wasm/bulk_sim/batch.ts uses
 * `async`'s `queue` instead; this pool puts each result at its task's index whatever the
 * finish order and reports the lowest-index error, so the outcome does not depend on
 * concurrency.
 */

/** A unit of work; `promisePool` runs it exactly once, on dispatch. */
export type PoolTask<T> = () => Promise<T>;

/**
 * Runs `tasks` with at most `n` in flight. On a rejection it rejects with the
 * lowest-index error and dispatches nothing more; in-flight tasks are not cancelled
 * (Stop aborts through `rankUpgrades`' `AbortSignal`).
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
				// Lowest index wins, not the first to reject, so the error does not
				// depend on pool size or sim latency.
				if (index < firstErrorIndex) {
					firstErrorIndex = index;
					firstError = err;
				}
				hasError = true;
				return;
			}
		}
	}

	// A non-finite `n` would make the length NaN: zero workers, and a sparse array
	// returned as success.
	const requested = Number.isFinite(n) ? Math.trunc(n) : 1;
	const workerCount = Math.max(1, Math.min(requested, tasks.length));
	await Promise.all(Array.from({ length: workerCount }, () => worker()));

	if (hasError) throw firstError;
	return results;
}
