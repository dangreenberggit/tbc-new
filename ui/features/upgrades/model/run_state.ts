/**
 * The tab's run state and the pure functions that move it along a run's life, so a
 * run's linked fields (id, landed rows, result) change together. The store's
 * actions call them; `run_session.ts` holds the abort controller and run id counter.
 */

import type { EpWeightsSet } from './data/data';
import type { PartialRanking, RankedItem, Ranking } from './engine/rank';
import type { SpecId } from './engine/types';
import type { SetOption } from './settings_pool';

export type RunSettings = {
	iterations: number;
	/** Keep the first N candidates of the EP ordering that the player does not wear; undefined is no cap. */
	candidateCap?: number;
	/**
	 * The pool filters: excluded sources and, with `prune`, only the selected sets'
	 * items, applied through `effectivePool`. The set keys are for the assumptions line.
	 */
	excludedSources?: readonly string[];
	guaranteedSetKeys?: readonly string[];
	guaranteedSetItemIds?: readonly number[];
	prune?: boolean;
};

/** The iteration count used when the field is empty or zero. */
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
 * What a run function resolves with: the result and, for a live run, the runner
 * that measured it and the EP-weights set it ranked with (`runSettled`).
 */
export type RunOutcome = RunResult & { runner?: RunnerName; epWeightsSet?: EpWeightsSet };

/**
 * The ranking holds no gear, and the set bonuses a row's swap breaks are worked out
 * from the gear it was measured on. The result is stale once an `inputsSignature`
 * built now differs (`run_inputs.ts`). `selectedSets` is a copy because a later
 * phase change picks other sets.
 */
export type MeasuredOn = {
	wornItemIds?: readonly number[];
	specId?: SpecId;
	inputsSignature?: string;
	runner?: RunnerName;
	selectedSets?: readonly SetOption[];
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
 * An older run's rows, Stop and result can still arrive after a new run started or a fixture loaded. Every function
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

/** Replaces a run in flight, whose late rows are then dropped. */
export const fixtureLoaded = (runId: number, ranking: Ranking, measuredOn?: MeasuredOn): RunState => ({
	status: 'done',
	runId,
	result: ranking,
	measuredOn,
});

export const rowLanded = (state: RunState, runId: number, row: RankedItem): RunState =>
	isCurrentRun(state, runId) ? { ...state, landedRows: [...state.landedRows, row] } : state;

export const stopRequested = (state: RunState, runId: number): RunState => (isCurrentRun(state, runId) ? { ...state, stopping: true } : state);

/**
 * A partial ranking is what Stop returns, so it settles as stopped and a complete one as done. The runner moves into
 * `measuredOn` and the EP-weights set is dropped, so a ranking the fixture recorder saves carries neither.
 */
export function runSettled(state: RunState, runId: number, outcome: RunOutcome): RunState {
	if (!isCurrentRun(state, runId)) return state;
	const { runner, epWeightsSet: _forTheLogOnly, ...result } = outcome;
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

/** The finished ranking on screen, which the fixture recorder saves. */
export const shownRanking = (run: RunState): FinishedRanking | undefined => (run.status === 'done' ? run.result : undefined);
