import { describe, expect, it } from 'vitest';

import { RANKING_FIXTURE } from '../testing/ranking_fixture';
import type { PartialRanking } from './engine/rank';
import { DEFAULT_ITERATIONS, IDLE_RUN, runReducer, runSettings, type RunState, settledAction, shownRanking, visibleRows } from './run_reducer';

const [rowA, rowB] = RANKING_FIXTURE.items;
const partial: PartialRanking = { ...RANKING_FIXTURE, items: [rowA!], complete: false };

const running = (runId = 1): RunState => runReducer(IDLE_RUN, { type: 'started', runId, startedAt: 1000 });

describe('runReducer', () => {
	it('starts a run from idle with no landed rows', () => {
		expect(running()).toEqual({ status: 'running', runId: 1, startedAt: 1000, landedRows: [], stopping: false });
	});

	it('marks the run as stopping when Stop is pressed, keeping its landed rows', () => {
		const state = runReducer(runReducer(running(), { type: 'landed', runId: 1, row: rowA! }), { type: 'stopping', runId: 1 });
		expect(state).toMatchObject({ status: 'running', landedRows: [rowA], stopping: true });
	});

	it('ignores a Stop meant for a superseded run', () => {
		const state = running(2);
		expect(runReducer(state, { type: 'stopping', runId: 1 })).toBe(state);
	});

	it('enters stopped, not error, when a stopping run settles with its partial ranking', () => {
		const stopping = runReducer(running(), { type: 'stopping', runId: 1 });
		const result = { ...partial, durationMs: 800 };
		expect(runReducer(stopping, settledAction(1, result))).toEqual({ status: 'stopped', runId: 1, result });
	});

	it('appends each landed row of the current run, in order', () => {
		let state = running();
		state = runReducer(state, { type: 'landed', runId: 1, row: rowA! });
		state = runReducer(state, { type: 'landed', runId: 1, row: rowB! });
		expect(state).toMatchObject({ status: 'running', landedRows: [rowA, rowB] });
	});

	it('ignores a landed row from a superseded run', () => {
		const state = running(2);
		expect(runReducer(state, { type: 'landed', runId: 1, row: rowA! })).toBe(state);
	});

	it('enters done with the finished ranking', () => {
		const result = { ...RANKING_FIXTURE, durationMs: 2500 };
		expect(runReducer(running(), { type: 'finished', runId: 1, result })).toEqual({ status: 'done', runId: 1, result });
	});

	it('enters stopped with the partial ranking', () => {
		const result = { ...partial, durationMs: 800 };
		expect(runReducer(running(), { type: 'stopped', runId: 1, result })).toEqual({ status: 'stopped', runId: 1, result });
	});

	it('keeps what the run was measured against from its start to its result, done or stopped', () => {
		const measuredOn = { wornItemIds: [1, 2, 3], specId: 'ret' as const };
		const started = runReducer(IDLE_RUN, { type: 'started', runId: 1, startedAt: 1000, measuredOn });
		const landed = runReducer(started, { type: 'landed', runId: 1, row: rowA! });

		expect(runReducer(landed, { type: 'finished', runId: 1, result: RANKING_FIXTURE })).toMatchObject({ status: 'done', measuredOn });
		expect(runReducer(landed, { type: 'stopped', runId: 1, result: { ...partial, durationMs: 800 } })).toMatchObject({ status: 'stopped', measuredOn });
	});

	it('keeps what a loaded fixture was measured against', () => {
		const measuredOn = { wornItemIds: [4, 5], specId: 'feral' as const };
		expect(runReducer(IDLE_RUN, { type: 'fixtureLoaded', runId: 3, ranking: RANKING_FIXTURE, measuredOn })).toMatchObject({ status: 'done', measuredOn });
	});

	it('enters error with the message', () => {
		expect(runReducer(running(), { type: 'failed', runId: 1, message: 'sim failed' })).toEqual({
			status: 'error',
			runId: 1,
			message: 'sim failed',
		});
	});

	it('ignores a late result from a superseded run', () => {
		const state = running(2);
		const result = { ...RANKING_FIXTURE, durationMs: 1 };
		expect(runReducer(state, { type: 'finished', runId: 1, result })).toBe(state);
		expect(runReducer(state, { type: 'stopped', runId: 1, result: { ...partial, durationMs: 1 } })).toBe(state);
		expect(runReducer(state, { type: 'failed', runId: 1, message: 'late' })).toBe(state);
	});

	it('ignores a result when no run is in flight', () => {
		const result = { ...RANKING_FIXTURE, durationMs: 1 };
		expect(runReducer(IDLE_RUN, { type: 'finished', runId: 1, result })).toBe(IDLE_RUN);
	});

	it('starts a new run from a finished one', () => {
		const done = runReducer(running(), { type: 'finished', runId: 1, result: { ...RANKING_FIXTURE, durationMs: 1 } });
		expect(runReducer(done, { type: 'started', runId: 2, startedAt: 5000 })).toEqual({
			status: 'running',
			runId: 2,
			startedAt: 5000,
			landedRows: [],
			stopping: false,
		});
	});

	it('enters done with no duration when a fixture loads, since nothing ran', () => {
		expect(runReducer(IDLE_RUN, { type: 'fixtureLoaded', runId: 3, ranking: RANKING_FIXTURE })).toEqual({
			status: 'done',
			runId: 3,
			result: RANKING_FIXTURE,
		});
	});

	it('lets a loaded fixture replace a run in flight, whose late rows are then dropped', () => {
		const loaded = runReducer(running(1), { type: 'fixtureLoaded', runId: 2, ranking: RANKING_FIXTURE });
		expect(loaded).toMatchObject({ status: 'done', runId: 2 });
		expect(runReducer(loaded, { type: 'landed', runId: 1, row: rowA! })).toBe(loaded);
	});
});

describe('runSettings', () => {
	it('keeps a positive whole iteration count and the cap', () => {
		expect(runSettings(750, 10)).toEqual({ iterations: 750, candidateCap: 10 });
	});

	it('falls back to the default for an empty or zero field', () => {
		expect(runSettings(0)).toEqual({ iterations: DEFAULT_ITERATIONS, candidateCap: undefined });
	});
});

describe('settledAction', () => {
	it('finishes a run whose ranking is complete', () => {
		const result = { ...RANKING_FIXTURE, durationMs: 5 };
		expect(settledAction(4, result)).toEqual({ type: 'finished', runId: 4, result });
	});

	it('stops a run whose ranking is partial', () => {
		const result = { ...partial, durationMs: 5 };
		expect(settledAction(4, result)).toEqual({ type: 'stopped', runId: 4, result });
	});
});

describe('visibleRows', () => {
	it('shows nothing before a run', () => {
		expect(visibleRows(IDLE_RUN)).toEqual([]);
	});

	it('shows the landed rows while running', () => {
		const state = runReducer(running(), { type: 'landed', runId: 1, row: rowA! });
		expect(visibleRows(state)).toEqual([rowA]);
	});

	it('shows every row of a finished ranking', () => {
		const done = runReducer(running(), { type: 'finished', runId: 1, result: { ...RANKING_FIXTURE, durationMs: 1 } });
		expect(visibleRows(done)).toEqual(RANKING_FIXTURE.items);
	});

	it('leaves out the rows Stop never simmed', () => {
		const unsimmed = { ...rowB!, simmed: false as const };
		const result = { ...partial, items: [rowA!, unsimmed], durationMs: 1 };
		expect(visibleRows(runReducer(running(), { type: 'stopped', runId: 1, result }))).toEqual([rowA]);
	});
});

describe('shownRanking', () => {
	it('is the finished ranking, and nothing for any other state', () => {
		const result = { ...RANKING_FIXTURE, durationMs: 1 };
		expect(shownRanking(runReducer(running(), { type: 'finished', runId: 1, result }))).toBe(result);
		expect(shownRanking(running())).toBeUndefined();
		expect(shownRanking(IDLE_RUN)).toBeUndefined();
	});
});
