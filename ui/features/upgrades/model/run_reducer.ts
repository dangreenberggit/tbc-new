/**
 * The Upgrades tab's run state: one reducer, so the linked fields of a run
 * (its id, its landed rows, its result) change together. Pure; the hook that
 * owns it holds the abort controller and the run id counter.
 */

import type { PartialRanking, RankedItem, Ranking } from './engine/rank';
import type { SpecId } from './engine/types';

/** What one click of Run asks for. */
export type RunSettings = {
	iterations: number;
	/** Keep the first N candidates of the EP ordering; undefined is no cap. */
	candidateCap?: number;
	/**
	 * The three pool filters the old tab offered (sources, selected sets,
	 * prune). P1 has no control for them and `rankForPlayer` passes the whole
	 * pool; P2 brings the controls and the filter.
	 */
	excludedSources?: readonly string[];
	guaranteedSetKeys?: readonly string[];
	prune?: boolean;
};

/** The old tab's iteration count, used when the field is empty or zero. */
export const DEFAULT_ITERATIONS = 3000;

export const runSettings = (iterations: number, candidateCap?: number): RunSettings => ({
	iterations: iterations > 0 ? Math.floor(iterations) : DEFAULT_ITERATIONS,
	candidateCap,
});

/** `durationMs` is absent on a ranking loaded from a fixture: nothing ran, so there is no time to show. */
export type FinishedRanking = Ranking & { durationMs?: number };
export type StoppedRanking = PartialRanking & { durationMs: number };
export type RunResult = FinishedRanking | StoppedRanking;

/**
 * The gear and spec a ranking was measured against. The ranking holds no
 * gear, and a row's own set breaks are worked out from the gear it was
 * measured on, not the gear worn now (ticket 536).
 */
export type MeasuredOn = { wornItemIds?: readonly number[]; specId?: SpecId };

export type RunState =
	| { status: 'idle' }
	/**
	 * `stopping`: Stop was pressed. The engine finishes the step in flight and
	 * then returns what it has, so the run stays `running` until it settles.
	 */
	| { status: 'running'; runId: number; startedAt: number; landedRows: readonly RankedItem[]; stopping: boolean; measuredOn?: MeasuredOn }
	| { status: 'done'; runId: number; result: FinishedRanking; measuredOn?: MeasuredOn }
	| { status: 'stopped'; runId: number; result: StoppedRanking; measuredOn?: MeasuredOn }
	| { status: 'error'; runId: number; message: string };

export type RunAction =
	| { type: 'started'; runId: number; startedAt: number; measuredOn?: MeasuredOn }
	| { type: 'landed'; runId: number; row: RankedItem }
	| { type: 'stopping'; runId: number }
	| { type: 'finished'; runId: number; result: FinishedRanking }
	| { type: 'stopped'; runId: number; result: StoppedRanking }
	| { type: 'failed'; runId: number; message: string }
	| { type: 'fixtureLoaded'; runId: number; ranking: Ranking; measuredOn?: MeasuredOn };

export const IDLE_RUN: RunState = { status: 'idle' };

const isCurrentRun = (state: RunState, runId: number): state is Extract<RunState, { status: 'running' }> => state.status === 'running' && state.runId === runId;

export function runReducer(state: RunState, action: RunAction): RunState {
	switch (action.type) {
		case 'started':
			return { status: 'running', runId: action.runId, startedAt: action.startedAt, landedRows: [], stopping: false, measuredOn: action.measuredOn };
		case 'fixtureLoaded':
			return { status: 'done', runId: action.runId, result: action.ranking, measuredOn: action.measuredOn };
		case 'landed':
			// A superseded run's rows can still arrive after a new run started.
			if (!isCurrentRun(state, action.runId)) return state;
			return { ...state, landedRows: [...state.landedRows, action.row] };
		case 'stopping':
			if (!isCurrentRun(state, action.runId)) return state;
			return { ...state, stopping: true };
		case 'finished':
			if (!isCurrentRun(state, action.runId)) return state;
			return { status: 'done', runId: action.runId, result: action.result, measuredOn: state.measuredOn };
		case 'stopped':
			if (!isCurrentRun(state, action.runId)) return state;
			return { status: 'stopped', runId: action.runId, result: action.result, measuredOn: state.measuredOn };
		case 'failed':
			if (!isCurrentRun(state, action.runId)) return state;
			return { status: 'error', runId: action.runId, message: action.message };
	}
}

/** The action a run's settled result dispatches: a partial ranking is what Stop returns. */
export const settledAction = (runId: number, result: RunResult): RunAction =>
	result.complete ? { type: 'finished', runId, result } : { type: 'stopped', runId, result };

/** The rows the table shows for `run`. A stopped ranking also lists the candidates Stop never reached. */
export function visibleRows(run: RunState): readonly RankedItem[] {
	switch (run.status) {
		case 'running':
			return run.landedRows;
		case 'done':
			return run.result.items;
		case 'stopped':
			return run.result.items.filter(row => row.simmed !== false);
		default:
			return [];
	}
}

/** The finished ranking on screen, which the fixture recorder saves. */
export const shownRanking = (run: RunState): FinishedRanking | undefined => (run.status === 'done' ? run.result : undefined);
