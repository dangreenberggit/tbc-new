import type { Spec } from '@generated/proto/common';
import type { IndividualSimHost } from '@sim/sim_host';
import { describe, expect, it, vi } from 'vitest';

import { RANKING_FIXTURE } from '../testing/ranking_fixture';
import type { RankedItem } from './engine/rank';
import { progressOf } from './progress_channel';
import { replayRows } from './replay_run';
import type { RunDeps } from './run';

const SETTINGS = { iterations: 1000 };

const fakeHost = () => ({ player: {} }) as unknown as IndividualSimHost<Spec>;

const depsWith = (signal: AbortSignal, onLanded: (row: RankedItem) => void) => {
	const runContext = vi.fn<RunDeps['runContext']>(() => {
		throw new Error('the replay runner must not build a sim runner');
	});
	return { deps: { signal, onLanded, runContext }, runContext };
};

describe('replayRows', () => {
	it('lands every row in order and resolves the whole ranking with its duration', async () => {
		const landed: RankedItem[] = [];
		const { deps, runContext } = depsWith(new AbortController().signal, row => landed.push(row));
		const result = await replayRows(RANKING_FIXTURE, { delayMs: 0 })(fakeHost(), SETTINGS, deps);

		expect(landed.map(r => r.itemId)).toEqual(RANKING_FIXTURE.items.map(r => r.itemId));
		expect(result.complete).toBe(true);
		expect(result.items).toEqual(RANKING_FIXTURE.items);
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
		expect(runContext).not.toHaveBeenCalled();
	});

	it('stops at the batch where Stop lands and resolves the rows landed so far', async () => {
		const controller = new AbortController();
		const landed: RankedItem[] = [];
		const { deps, runContext } = depsWith(controller.signal, row => {
			landed.push(row);
			if (landed.length === 3) controller.abort();
		});
		const result = await replayRows(RANKING_FIXTURE, { delayMs: 0 })(fakeHost(), SETTINGS, deps);

		expect(result.complete).toBe(false);
		expect(result.items.map(r => r.itemId)).toEqual(RANKING_FIXTURE.items.slice(0, 3).map(r => r.itemId));
		expect(landed).toHaveLength(3);
		expect(runContext).not.toHaveBeenCalled();
	});

	it('lands nothing when Stop came before the run', async () => {
		const controller = new AbortController();
		controller.abort();
		const onLanded = vi.fn();
		const { deps } = depsWith(controller.signal, onLanded);
		const result = await replayRows(RANKING_FIXTURE, { delayMs: 0 })(fakeHost(), SETTINGS, deps);

		expect(result).toMatchObject({ complete: false, items: [] });
		expect(onLanded).not.toHaveBeenCalled();
	});

	it('ticks the progress channel up to the row count', async () => {
		const host = fakeHost();
		const { deps } = depsWith(new AbortController().signal, () => {});
		await replayRows(RANKING_FIXTURE, { delayMs: 0 })(host, SETTINGS, deps);

		expect(progressOf(host.player)).toMatchObject({ done: RANKING_FIXTURE.items.length, total: RANKING_FIXTURE.items.length });
	});
});
