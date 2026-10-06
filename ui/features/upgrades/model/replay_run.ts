/**
 * A dev-only run that replays a saved ranking through the real run path:
 * rows land a few at a time, progress ticks, Stop ends it with the rows so
 * far, all without a sim. It never calls `deps.runContext`, so a replay
 * builds no WASM workers.
 */

import type { Ranking } from './engine/rank';
import { emitProgress } from './progress_channel';
import type { RunFn } from './run';

export type ReplayPacing = {
	/** Rows landed per step. */
	batchSize?: number;
	/** Wait between steps; the default lands a 467-row ranking in about 4 s. */
	delayMs?: number;
};

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function replayRows(ranking: Ranking, { batchSize = 3, delayMs = 25 }: ReplayPacing = {}): RunFn {
	return async (host, _settings, deps) => {
		const startedAt = Date.now();
		const rows = ranking.items;
		let landed = 0;
		const tick = () =>
			emitProgress(host.player, {
				phase: 'candidates',
				stage: 'simming',
				done: landed,
				total: rows.length,
				boundary: null,
				concurrency: 1,
				qualifyingRows: 0,
			});

		while (landed < rows.length && !deps.signal.aborted) {
			for (const row of rows.slice(landed, landed + batchSize)) {
				deps.onLanded(row);
				landed += 1;
				// Stop can land inside a batch; the rows after it were never "simmed".
				if (deps.signal.aborted) break;
			}
			tick();
			if (landed < rows.length && !deps.signal.aborted) await wait(delayMs);
		}

		const durationMs = Date.now() - startedAt;
		if (landed < rows.length) {
			return { ...ranking, items: rows.slice(0, landed), complete: false, durationMs };
		}
		return { ...ranking, durationMs };
	};
}
