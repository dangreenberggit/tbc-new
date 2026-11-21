/**
 * The tab's run state and the pure functions that move it along a run's life, so a
 * run's linked fields (id, landed rows, result) change together. The store's
 * actions call them; `run_session.ts` holds the abort controller and run id counter.
 */

import type { EpWeightsPreset } from './data/data';
import type { PartialRanking, RankedItem, Ranking } from './engine/rank';
import type { SpecId } from './engine/types';
import type { GearSetOption } from './settings_pool';

export type RunSettings = {
	iterations: number;
	/**
	 * The pool filters: excluded sources and, with `prune`, only the selected gear sets'
	 * items, applied through `effectivePool`. The gear set keys are for the assumptions line.
	 */
	excludedSources?: readonly string[];
	selectedGearSetKeys?: readonly string[];
	selectedGearSetItemIds?: readonly number[];
	prune?: boolean;
};

/** The iteration count used when the field is empty or zero. */
export const TAB_DEFAULT_ITERATIONS = 3000;

export const runIterations = (iterations: number): number => (iterations > 0 ? Math.floor(iterations) : TAB_DEFAULT_ITERATIONS);

/** `durationMs` is absent when the run function reports no time; the tab then shows none. */
export type FinishedRanking = Ranking & { durationMs?: number };
export type StoppedRanking = PartialRanking & { durationMs: number };
export type RunResult = FinishedRanking | StoppedRanking;

/** The one runner a live run uses (`createRunContext`). */
export type RunnerName = 'WorkerPoolSimRunner';

/**
 * What a run function resolves with: the result and, for a live run, the runner
 * that measured it and the EP-weights preset it ranked with (`runSettled`).
 */
export type RunOutcome = RunResult & { runner?: RunnerName; epWeightsPreset?: EpWeightsPreset };

/**
 * The ranking holds no gear, and the set bonuses a row's swap breaks are worked out
 * from the gear it was measured on. The result is stale once an `inputsSignature`
 * built now differs (`run_inputs.ts`). `selectedGearSets` is a copy because a later
 * phase change picks other gear sets.
 */
export type MeasuredOn = {
	wornItemIds?: readonly number[];
	specId?: SpecId;
	inputsSignature?: string;
	runner?: RunnerName;
	selectedGearSets?: readonly GearSetOption[];
};

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

export const IDLE_RUN: RunState = { status: 'idle' };

type RunningState = Extract<RunState, { status: 'running' }>;

const withRunner = (measuredOn: MeasuredOn | undefined, runner: RunnerName | undefined): MeasuredOn | undefined =>
	runner ? { ...measuredOn, runner } : measuredOn;

/**
 * An older run's rows, Stop and result can still arrive after a new run started. Every function
 * below returns the state unchanged for such a call, so the store writes nothing.
 */
const isCurrentRun = (state: RunState, runId: number): state is RunningState => state.status === 'running' && state.runId === runId;

export const runStarted = (runId: number, startedAt: number, measuredOn?: MeasuredOn): RunState => ({
	status: 'running',
	runId,
	startedAt,
	landedRows: [],
	stopping: false,
	measuredOn,
});

export const rowLanded = (state: RunState, runId: number, row: RankedItem): RunState =>
	isCurrentRun(state, runId) ? { ...state, landedRows: [...state.landedRows, row] } : state;

export const stopRequested = (state: RunState, runId: number): RunState => (isCurrentRun(state, runId) ? { ...state, stopping: true } : state);

/**
 * A partial ranking is what Stop returns, so it settles as stopped and a complete one as done. The runner moves into
 * `measuredOn` and the EP-weights preset is dropped: it is for the log only.
 */
export function runSettled(state: RunState, runId: number, outcome: RunOutcome): RunState {
	if (!isCurrentRun(state, runId)) return state;
	const { runner, epWeightsPreset: _forTheLogOnly, ...result } = outcome;
	const measuredOn = withRunner(state.measuredOn, runner);
	return result.complete ? { status: 'done', runId, result, measuredOn } : { status: 'stopped', runId, result, measuredOn };
}

export const runFailed = (state: RunState, runId: number, message: string): RunState =>
	isCurrentRun(state, runId) ? { status: 'error', runId, message } : state;

/** A stopped ranking also lists the candidates Stop never reached; they are left out. */
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

export const measuredOnOf = (run: RunState): MeasuredOn | undefined =>
	run.status === 'running' || run.status === 'done' || run.status === 'stopped' ? run.measuredOn : undefined;
