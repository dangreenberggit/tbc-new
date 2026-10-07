/**
 * The tab's one run, outside React (ticket 564): the run in flight, the id
 * that tells its callbacks from a superseded run's, and the tab's workers.
 * It writes the run state to the tab's store; the hook that owns it only
 * creates it once and disposes it on unmount.
 */

import type { Spec } from '@generated/proto/common';
import type { IndividualSimHost } from '@sim/sim_host';

import { equippedItemIds } from './adapters/player_gear_source';
import type { RunnerEnv } from './adapters/worker_pool_sim_runner';
import { type AssumptionsContext, assumptionsLine, substitutionConsoleLines } from './assumptions';
import type { Ranking } from './engine/rank';
import { clearProgress } from './progress_channel';
import { createRunContext, type RunContext, type RunFn, specIdFor } from './run';
import { type MeasuredOn, type RunSettings, settledAction } from './run_reducer';
import { dispatchRun, type UpgradesStore } from './upgrades_store';

/**
 * What the session takes from the browser and the UI layer, which `model/`
 * may not import: the worker pool's browser values (`utils/runner_env.ts`)
 * and the wording of a failed run (`utils/format.ts`).
 */
export type RunSessionEnv = {
	runner: RunnerEnv;
	describeError: (error: unknown) => string;
};

export type RunSession = {
	/**
	 * A click handler: a run starts only from the user's Run. The caller passes
	 * the inputs signature (`run_inputs.ts`), because the tab's settings live
	 * with the caller.
	 */
	start: (settings: RunSettings, inputsSignature: string) => void;
	stop: () => void;
	loadFixture: (ranking: Ranking, inputsSignature: string) => void;
	dispose: () => void;
};

/**
 * The page's gear and spec now. Read at the click, because the progress
 * dialog blocks gear edits until the run settles, so this is the gear the
 * engine reads; and read when a fixture loads, which sets the page gear first.
 */
const measuredOnPage = (host: IndividualSimHost<Spec>, inputsSignature: string): MeasuredOn => ({
	wornItemIds: equippedItemIds(host.player),
	specId: specIdFor(host.player.getSpec()),
	inputsSignature,
});

/**
 * The run's assumptions for whoever diagnoses a bad ranking (ticket 318), and
 * the full text of each dropped-candidate reason the page cuts to one line
 * (ticket 311). Logged once when a ranking arrives, never from a render.
 */
const logAssumptions = (result: Pick<Ranking, 'assumptions' | 'substitutions'>, context: AssumptionsContext) => {
	console.info(assumptionsLine(result, context));
	for (const line of substitutionConsoleLines(result.substitutions)) console.warn(line);
};

/**
 * The worker pool is built on the first run that asks for it and kept for the
 * tab's lifetime, as the old tab did: each worker is a WASM instantiation, and
 * the store inside the context reuses sims across runs.
 */
export function createRunSession(store: UpgradesStore, host: IndividualSimHost<Spec>, runFn: RunFn, env: RunSessionEnv): RunSession {
	let controller: AbortController | null = null;
	// From the store, which outlives a session: a remount mid-run builds a new session, and the old run's late
	// callbacks must still read as superseded.
	const stored = store.getState().run;
	let runId = stored.status === 'idle' ? 0 : stored.runId;
	let context: RunContext | null = null;

	const start = (settings: RunSettings, inputsSignature: string) => {
		controller?.abort();
		const current = new AbortController();
		controller = current;
		const id = ++runId;

		clearProgress(host.player);
		const measuredOn = measuredOnPage(host, inputsSignature);
		dispatchRun(store, { type: 'started', runId: id, startedAt: Date.now(), measuredOn });
		runFn(host, settings, {
			signal: current.signal,
			onLanded: row => dispatchRun(store, { type: 'landed', runId: id, row }),
			runContext: () => (context ??= createRunContext(env.runner)),
		}).then(
			result => {
				dispatchRun(store, settledAction(id, result));
				// A superseded run's result is dropped by the reducer, so it is not logged either.
				if (id === runId) logAssumptions(result, { specId: measuredOn.specId, settings });
			},
			(error: unknown) => dispatchRun(store, { type: 'failed', runId: id, message: env.describeError(error) }),
		);
	};

	/** Nothing is cancelled mid-sim: the engine finishes the step in flight and returns the rows so far (option (a), ticket 559). */
	const stop = () => {
		if (!controller) return;
		controller.abort();
		dispatchRun(store, { type: 'stopping', runId });
	};

	const loadFixture = (ranking: Ranking, inputsSignature: string) => {
		controller?.abort();
		const measuredOn = measuredOnPage(host, inputsSignature);
		dispatchRun(store, { type: 'fixtureLoaded', runId: ++runId, ranking, measuredOn });
		logAssumptions(ranking, { specId: measuredOn.specId });
	};

	/**
	 * Leaves the session usable: StrictMode unmounts and remounts every
	 * component once in development, so this runs before the first Run, and
	 * the next `start` builds new workers. The run id keeps counting, so a
	 * callback of the aborted run still reads as superseded.
	 */
	const dispose = () => {
		controller?.abort();
		context?.terminate();
		context = null;
	};

	return { start, stop, loadFixture, dispose };
}
