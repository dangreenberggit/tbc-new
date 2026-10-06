import { describe, expect, it } from 'vitest';

import { RANKING_FIXTURE } from '../testing/ranking_fixture';
import type { PartialRanking } from './engine/rank';
import { IDLE_RUN, runReducer, type RunState } from './run_reducer';

const [rowA, rowB] = RANKING_FIXTURE.items;
const partial: PartialRanking = { ...RANKING_FIXTURE, items: [rowA!], complete: false };

const running = (runId = 1): RunState => runReducer(IDLE_RUN, { type: 'started', runId, startedAt: 1000 });

describe('runReducer', () => {
	it('starts a run from idle with no landed rows', () => {
		expect(running()).toEqual({ status: 'running', runId: 1, startedAt: 1000, landedRows: [] });
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
		});
	});

	it('enters done with a zero duration when a fixture loads', () => {
		expect(runReducer(IDLE_RUN, { type: 'fixtureLoaded', runId: 3, ranking: RANKING_FIXTURE })).toEqual({
			status: 'done',
			runId: 3,
			result: { ...RANKING_FIXTURE, durationMs: 0 },
		});
	});

	it('lets a loaded fixture replace a run in flight, whose late rows are then dropped', () => {
		const loaded = runReducer(running(1), { type: 'fixtureLoaded', runId: 2, ranking: RANKING_FIXTURE });
		expect(loaded).toMatchObject({ status: 'done', runId: 2 });
		expect(runReducer(loaded, { type: 'landed', runId: 1, row: rowA! })).toBe(loaded);
	});
});
