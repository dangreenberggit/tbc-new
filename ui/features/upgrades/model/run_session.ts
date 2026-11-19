/**
 * The tab's one run, kept outside React: the run in flight, the id that tells its
 * callbacks from an older run's, and the `RunContext`. It writes run state to the
 * store; the hook that owns it only creates it and disposes it on unmount.
 */

import type { Spec } from '@generated/proto/common';
import type { IndividualSimHost } from '@sim/sim_host';
import { toastManager } from '@ui-kit/Toast';

import { equippedItemIds } from './adapters/player_gear_source';
import type { RunnerEnv } from './adapters/worker_pool_sim_runner';
import { type AssumptionsContext, assumptionsLine, noteConsoleLines } from './assumptions';
import { RankError, type Ranking } from './engine/rank';
import { clearProgress } from './progress_channel';
import { createRunContext, type RunContext, type RunFn, specIdFor } from './run';
import type { MeasuredOn, RunSettings } from './run_state';
import type { GearSetOption } from './settings_pool';
import type { UpgradesStore } from './upgrades_store';

/**
 * What the session takes from the browser and the UI layer, which `model/` may not
 * import: the worker pool's browser values and the wording of a failed run.
 */
export type RunSessionEnv = {
	runner: RunnerEnv;
	describeError: (error: unknown) => string;
};

export type RunSession = {
	/**
	 * A run starts only from the user's Run click. The settings live with the caller,
	 * so it passes the inputs signature (`run_inputs.ts`) and the gear sets picked.
	 */
	start: (settings: RunSettings, inputsSignature: string, selectedGearSets: readonly GearSetOption[]) => void;
	stop: () => void;
	loadFixture: (ranking: Ranking, inputsSignature: string, selectedGearSets: readonly GearSetOption[]) => void;
	dispose: () => void;
};

/**
 * Read at the click: the progress dialog blocks gear edits until the run settles,
 * so this is the gear the engine reads. A fixture sets the page gear before this.
 */
const measuredOnPage = (host: IndividualSimHost<Spec>, inputsSignature: string, selectedGearSets: readonly GearSetOption[]): MeasuredOn => ({
	wornItemIds: equippedItemIds(host.player),
	specId: specIdFor(host.player.getSpec()),
	inputsSignature,
	selectedGearSets,
});

/**
 * For diagnosing a bad ranking: the full text of each reason the page shortens to
 * one line, and each failed call's error. Logged once per ranking, never from a render.
 */
const logAssumptions = (result: Pick<Ranking, 'assumptions' | 'cutoff' | 'substitutions'>, context: AssumptionsContext) => {
	console.info(assumptionsLine(result, context));
	for (const line of noteConsoleLines(result.substitutions)) console.warn(line);
};

/**
 * A failed run's own message, shown as the bulk sim shows one (`runBulkBatch`,
 * `ui/features/bulk/model/run.ts`) and skipped after Stop as it is on cancel. A run
 * that goes on past failed sims shows the first one's error, once.
 */
const toastErrorMessage = (error: unknown) => {
	const errorMessage = error instanceof Error ? error.message : typeof error === 'string' ? error : undefined;
	if (errorMessage) toastManager.add({ variant: 'error', body: errorMessage });
};

/** The `RunContext` is built on first use and kept for the session, as its cache reuses sims across runs. */
export function createRunSession(store: UpgradesStore, host: IndividualSimHost<Spec>, runFn: RunFn, env: RunSessionEnv): RunSession {
	let controller: AbortController | null = null;
	// From the store, which outlives a session: a remount mid-run builds a new session, and the old run's late
	// callbacks must still be ignored.
	const stored = store.getState().run;
	let runId = stored.status === 'idle' ? 0 : stored.runId;
	let context: RunContext | null = null;

	const start = (settings: RunSettings, inputsSignature: string, selectedGearSets: readonly GearSetOption[]) => {
		controller?.abort();
		const current = new AbortController();
		controller = current;
		const id = ++runId;

		clearProgress(host.player);
		const measuredOn = measuredOnPage(host, inputsSignature, selectedGearSets);
		store.getState().startRun(id, Date.now(), measuredOn);
		runFn(host, settings, {
			signal: current.signal,
			onLanded: row => store.getState().landRow(id, row),
			getRunContext: () => (context ??= createRunContext(env.runner)),
		}).then(
			result => {
				store.getState().settleRun(id, result);
				// The store drops an older run's result, so it is not logged either.
				if (id !== runId) return;
				// The set the run says it ranked with; a replay names none, as it ranked nothing.
				logAssumptions(result, { epWeightsPreset: result.epWeightsPreset, settings, host });
				// The notes list's order: the first line whose call failed.
				if (!current.signal.aborted) toastErrorMessage(result.substitutions.find(s => s.error?.trim())?.error);
			},
			(error: unknown) => {
				if (id === runId) {
					console.error('[upgrades] the run failed', error);
					// A spec with no Upgrades data is the tab's own error, not a sim's, and the status line says so.
					const noSpecData = error instanceof RankError && error.kind === 'not-implemented';
					if (!current.signal.aborted && !noSpecData) toastErrorMessage(error);
				}
				store.getState().failRun(id, env.describeError(error));
			},
		);
	};

	/** Nothing is cancelled mid-sim: the engine finishes the step in flight and returns the rows so far. */
	const stop = () => {
		if (!controller) return;
		controller.abort();
		store.getState().requestStop(runId);
	};

	const loadFixture = (ranking: Ranking, inputsSignature: string, selectedGearSets: readonly GearSetOption[]) => {
		controller?.abort();
		const measuredOn = measuredOnPage(host, inputsSignature, selectedGearSets);
		store.getState().loadFixture(++runId, ranking, measuredOn);
		// A fixture records no EP-weights preset, and the page's talents now need not be the ones it was ranked with.
		logAssumptions(ranking, { host });
	};

	/**
	 * Aborts the run and nothing more: StrictMode's dev remount runs this before the
	 * first Run, so the session must stay usable, and the run id keeps counting so the
	 * aborted run's callbacks are still ignored.
	 */
	const dispose = () => {
		controller?.abort();
	};

	return { start, stop, loadFixture, dispose };
}
