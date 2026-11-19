/**
 * A dev-only run that replays a saved ranking through the real run path without a
 * sim: rows land a few at a time, progress ticks, Stop ends it with the rows so far.
 * It never calls `deps.getRunContext`, so it builds no WASM workers.
 */

import type { Ranking } from './engine/rank';
import { emitProgress } from './progress_channel';
import type { RunFn } from './run';

export type ReplayPacing = {
	rowsPerBatch?: number;
	/** The default lands a 467-row ranking in about 4 s. */
	batchDelayMs?: number;
};

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function replayRows(ranking: Ranking, { rowsPerBatch = 3, batchDelayMs = 25 }: ReplayPacing = {}): RunFn {
	return async (host, _settings, deps) => {
		const startedAt = Date.now();
		const rows = ranking.items;
		let landed = 0;
		const tick = () =>
			emitProgress(host.player, {
				activity: 'candidates',
				stage: 'simming',
				done: landed,
				total: rows.length,
				doneAtLastCandidate: null,
				concurrency: 1,
				replicableRowCount: 0,
			});

		while (landed < rows.length && !deps.signal.aborted) {
			for (const row of rows.slice(landed, landed + rowsPerBatch)) {
				deps.onLanded(row);
				landed += 1;
				// Stop can land inside a batch; the rows after it were never "simmed".
				if (deps.signal.aborted) break;
			}
			tick();
			if (landed < rows.length && !deps.signal.aborted) await wait(batchDelayMs);
		}

		const durationMs = Date.now() - startedAt;
		if (landed < rows.length) {
			return { ...ranking, items: rows.slice(0, landed), complete: false, durationMs };
		}
		return { ...ranking, durationMs };
	};
}
