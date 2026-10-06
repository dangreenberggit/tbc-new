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
	 * The pool filters the old tab offered: excluded sources, and with `prune`
	 * only the items of the selected sets. `rankForPlayer` applies them through
	 * `effectivePool`; the set keys are for the assumptions line only.
	 */
	excludedSources?: readonly string[];
	guaranteedSetKeys?: readonly string[];
	guaranteedSetItemIds?: readonly number[];
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

/** The one runner a live run uses (`createRunContext`). */
export type RunnerName = 'WorkerPoolSimRunner';

/**
 * What a run function resolves with: the result and, for a live run, the
 * runner that measured it. The runner moves to `MeasuredOn` when the run
 * settles, so the ranking a fixture recorder saves never carries it.
 */
export type RunOutcome = RunResult & { runner?: RunnerName };

/**
 * What a ranking was measured against. The ranking holds no gear, and a row's
 * own set breaks are worked out from the gear it was measured on, not the gear
 * worn now (ticket 536). `inputsSignature` is the page and settings when the
 * run started or the fixture loaded (`run_inputs.ts`); the result is stale
 * once the same signature built now differs. `runner` is set only by a live
 * run, never by a fixture or a replay.
 */
export type MeasuredOn = { wornItemIds?: readonly number[]; specId?: SpecId; inputsSignature?: string; runner?: RunnerName };

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
	| { type: 'finished'; runId: number; result: FinishedRanking; runner?: RunnerName }
	| { type: 'stopped'; runId: number; result: StoppedRanking; runner?: RunnerName }
	| { type: 'failed'; runId: number; message: string }
	| { type: 'fixtureLoaded'; runId: number; ranking: Ranking; measuredOn?: MeasuredOn };

export const IDLE_RUN: RunState = { status: 'idle' };

const withRunner = (measuredOn: MeasuredOn | undefined, runner: RunnerName | undefined): MeasuredOn | undefined =>
	runner ? { ...measuredOn, runner } : measuredOn;

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
			return { status: 'done', runId: action.runId, result: action.result, measuredOn: withRunner(state.measuredOn, action.runner) };
		case 'stopped':
			if (!isCurrentRun(state, action.runId)) return state;
			return { status: 'stopped', runId: action.runId, result: action.result, measuredOn: withRunner(state.measuredOn, action.runner) };
		case 'failed':
			if (!isCurrentRun(state, action.runId)) return state;
			return { status: 'error', runId: action.runId, message: action.message };
	}
}

/** The action a run's settled result dispatches: a partial ranking is what Stop returns. */
export function settledAction(runId: number, outcome: RunOutcome): RunAction {
	if (outcome.complete) {
		const { runner, ...result } = outcome;
		return { type: 'finished', runId, result, runner };
	}
	const { runner, ...result } = outcome;
	return { type: 'stopped', runId, result, runner };
}

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

/** What the run in flight or the result on screen was measured on. */
export const measuredOnOf = (run: RunState): MeasuredOn | undefined =>
	run.status === 'running' || run.status === 'done' || run.status === 'stopped' ? run.measuredOn : undefined;

/** The finished ranking on screen, which the fixture recorder saves. */
export const shownRanking = (run: RunState): FinishedRanking | undefined => (run.status === 'done' ? run.result : undefined);
