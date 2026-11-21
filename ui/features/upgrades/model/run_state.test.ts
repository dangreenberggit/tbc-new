import { describe, expect, it } from 'vitest';

import { RANKING_FIXTURE } from '../testing/ranking_fixture';
import type { PartialRanking } from './engine/rank';
import {
	IDLE_RUN,
	measuredOnOf,
	rowLanded,
	runFailed,
	runIterations,
	runSettled,
	runStarted,
	type RunState,
	stopRequested,
	TAB_DEFAULT_ITERATIONS,
	visibleRows,
} from './run_state';

const [rowA, rowB] = RANKING_FIXTURE.items;
const partial: PartialRanking = { ...RANKING_FIXTURE, items: [rowA!], complete: false };

const running = (runId = 1): RunState => runStarted(runId, 1000);

describe('the run transitions', () => {
	it('starts a run from idle with no landed rows', () => {
		expect(running()).toEqual({ status: 'running', runId: 1, startedAt: 1000, landedRows: [], stopping: false });
	});

	it('marks the run as stopping when Stop is pressed, keeping its landed rows', () => {
		const state = stopRequested(rowLanded(running(), 1, rowA!), 1);
		expect(state).toMatchObject({ status: 'running', landedRows: [rowA], stopping: true });
	});

	it('ignores a Stop meant for a superseded run', () => {
		const state = running(2);
		expect(stopRequested(state, 1)).toBe(state);
	});

	it('enters stopped, not error, when a stopping run settles with its partial ranking', () => {
		const stopping = stopRequested(running(), 1);
		const result = { ...partial, durationMs: 800 };
		expect(runSettled(stopping, 1, result)).toEqual({ status: 'stopped', runId: 1, result });
	});

	it('appends each landed row of the current run, in order', () => {
		let state = running();
		state = rowLanded(state, 1, rowA!);
		state = rowLanded(state, 1, rowB!);
		expect(state).toMatchObject({ status: 'running', landedRows: [rowA, rowB] });
	});

	it('ignores a landed row from a superseded run', () => {
		const state = running(2);
		expect(rowLanded(state, 1, rowA!)).toBe(state);
	});

	it('enters done with the finished ranking', () => {
		const result = { ...RANKING_FIXTURE, durationMs: 2500 };
		expect(runSettled(running(), 1, result)).toEqual({ status: 'done', runId: 1, result });
	});

	it('enters stopped with the partial ranking', () => {
		const result = { ...partial, durationMs: 800 };
		expect(runSettled(running(), 1, result)).toEqual({ status: 'stopped', runId: 1, result });
	});

	it('keeps what the run was measured against from its start to its result, done or stopped', () => {
		const measuredOn = { wornItemIds: [1, 2, 3], specId: 'ret' as const };
		const started = runStarted(1, 1000, measuredOn);
		const landed = rowLanded(started, 1, rowA!);

		expect(runSettled(landed, 1, RANKING_FIXTURE)).toMatchObject({ status: 'done', measuredOn });
		expect(runSettled(landed, 1, { ...partial, durationMs: 800 })).toMatchObject({ status: 'stopped', measuredOn });
	});

	it('enters error with the message', () => {
		expect(runFailed(running(), 1, 'sim failed')).toEqual({
			status: 'error',
			runId: 1,
			message: 'sim failed',
		});
	});

	it('ignores a late result from a superseded run', () => {
		const state = running(2);
		const result = { ...RANKING_FIXTURE, durationMs: 1 };
		expect(runSettled(state, 1, result)).toBe(state);
		expect(runSettled(state, 1, { ...partial, durationMs: 1 })).toBe(state);
		expect(runFailed(state, 1, 'late')).toBe(state);
	});

	it('ignores a result when no run is in flight', () => {
		const result = { ...RANKING_FIXTURE, durationMs: 1 };
		expect(runSettled(IDLE_RUN, 1, result)).toBe(IDLE_RUN);
	});

	it('keeps the inputs signature a run started with through to its result', () => {
		const started = runStarted(1, 0, { inputsSignature: 'sig' });
		const done = runSettled(started, 1, RANKING_FIXTURE);
		expect(done).toMatchObject({ status: 'done', measuredOn: { inputsSignature: 'sig' } });
	});

	it('records the runner when a live run settles, and none for a run that named none', () => {
		const started = runStarted(1, 0, { inputsSignature: 'sig' });
		const live = runSettled(started, 1, { ...RANKING_FIXTURE, runner: 'WorkerPoolSimRunner' });
		expect(live).toMatchObject({ measuredOn: { inputsSignature: 'sig', runner: 'WorkerPoolSimRunner' } });
		const stopped = runSettled(started, 1, { ...partial, durationMs: 1, runner: 'WorkerPoolSimRunner' });
		expect(stopped).toMatchObject({ status: 'stopped', measuredOn: { runner: 'WorkerPoolSimRunner' } });
		const unnamed = runSettled(started, 1, RANKING_FIXTURE);
		expect(unnamed.status === 'done' && unnamed.measuredOn).toEqual({ inputsSignature: 'sig' });
	});
});

describe('runIterations', () => {
	it('keeps a positive whole iteration count', () => {
		expect(runIterations(750)).toBe(750);
	});

	it('falls back to the default for an empty or zero field', () => {
		expect(runIterations(0)).toBe(TAB_DEFAULT_ITERATIONS);
	});
});

describe('runSettled', () => {
	it('moves the runner off the result, so a recorded ranking never carries it', () => {
		const result = { ...RANKING_FIXTURE, durationMs: 5 };
		const settled = runSettled(running(4), 4, { ...result, runner: 'WorkerPoolSimRunner' });
		expect(settled).toEqual({ status: 'done', runId: 4, result, measuredOn: { runner: 'WorkerPoolSimRunner' } });
		expect(settled.status === 'done' && 'runner' in settled.result).toBe(false);
	});

	it('drops the EP-weights preset from the result, so a recorded ranking never carries it', () => {
		const result = { ...RANKING_FIXTURE, durationMs: 5 };
		const settled = runSettled(running(4), 4, { ...result, runner: 'WorkerPoolSimRunner', epWeightsPreset: 'hunter-sv' });
		expect(settled).toEqual({ status: 'done', runId: 4, result, measuredOn: { runner: 'WorkerPoolSimRunner' } });
	});
});

describe('visibleRows', () => {
	it('shows nothing before a run', () => {
		expect(visibleRows(IDLE_RUN)).toEqual([]);
	});

	it('shows the landed rows while running', () => {
		const state = rowLanded(running(), 1, rowA!);
		expect(visibleRows(state)).toEqual([rowA]);
	});

	it('shows every row of a finished ranking', () => {
		const done = runSettled(running(), 1, { ...RANKING_FIXTURE, durationMs: 1 });
		expect(visibleRows(done)).toEqual(RANKING_FIXTURE.items);
	});

	it('leaves out the rows Stop never simmed', () => {
		const unsimmed = { ...rowB!, simmed: false as const };
		const result = { ...partial, items: [rowA!, unsimmed], durationMs: 1 };
		expect(visibleRows(runSettled(running(), 1, result))).toEqual([rowA]);
	});
});

describe('measuredOnOf', () => {
	it('is what the run or the result on screen was measured on, and nothing before a run or after an error', () => {
		const measuredOn = { inputsSignature: 'page' };
		const started = runStarted(1, 0, measuredOn);
		expect(measuredOnOf(started)).toBe(measuredOn);
		const done = runSettled(started, 1, { ...RANKING_FIXTURE, durationMs: 1, runner: 'WorkerPoolSimRunner' });
		expect(measuredOnOf(done)).toEqual({ inputsSignature: 'page', runner: 'WorkerPoolSimRunner' });
		expect(measuredOnOf(IDLE_RUN)).toBeUndefined();
		expect(measuredOnOf(runFailed(started, 1, 'no'))).toBeUndefined();
	});
});
