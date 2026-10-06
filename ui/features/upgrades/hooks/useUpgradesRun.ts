import { useSimHost } from '@sim/context/SimHostContext';
import { useEffect, useReducer, useRef } from 'react';

import { equippedItemIds } from '../model/adapters/player_gear_source';
import { type AssumptionsContext, assumptionsLine, substitutionConsoleLines } from '../model/assumptions';
import type { Ranking } from '../model/engine/rank';
import { clearProgress } from '../model/progress_channel';
import { createRunContext, type RunContext, type RunFn, specIdFor } from '../model/run';
import { IDLE_RUN, type MeasuredOn, runReducer, type RunSettings, type RunState, settledAction } from '../model/run_reducer';
import { describeRunError } from '../utils/format';
import { RUNNER_ENV } from '../utils/runner_env';

export type UpgradesRun = {
	run: RunState;
	/**
	 * A click handler: a run starts only from the user's Run. The caller passes
	 * the inputs signature (`run_inputs.ts`), because the tab's settings live
	 * with the caller.
	 */
	start: (settings: RunSettings, inputsSignature: string) => void;
	stop: () => void;
	dispatchFixture: (ranking: Ranking, inputsSignature: string) => void;
};

/**
 * The page's gear and spec now. Read at the click, because the progress
 * dialog blocks gear edits until the run settles, so this is the gear the
 * engine reads; and read when a fixture loads, which sets the page gear first.
 */
const measuredOnPage = (host: ReturnType<typeof useSimHost>, inputsSignature: string): MeasuredOn => ({
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

/** What outlives a render: the run in flight, the id that tells its callbacks from a superseded run's, and the tab's workers. */
type RunSession = { controller: AbortController | null; runId: number; context: RunContext | null };

/**
 * The tab's one run. The worker pool is built on the first run that asks for
 * it and kept for the tab's lifetime, as the old tab did: each worker is a WASM
 * instantiation, and the store inside the context reuses sims across runs.
 */
export function useUpgradesRun(runFn: RunFn): UpgradesRun {
	const host = useSimHost();
	const [run, dispatch] = useReducer(runReducer, IDLE_RUN);
	const session = useRef<RunSession>({ controller: null, runId: 0, context: null });

	useEffect(() => {
		const current = session.current;
		return () => {
			current.controller?.abort();
			current.context?.terminate();
			current.context = null;
		};
	}, []);

	const start = (settings: RunSettings, inputsSignature: string) => {
		const current = session.current;
		current.controller?.abort();
		const controller = new AbortController();
		current.controller = controller;
		const runId = ++current.runId;

		clearProgress(host.player);
		const measuredOn = measuredOnPage(host, inputsSignature);
		dispatch({ type: 'started', runId, startedAt: Date.now(), measuredOn });
		runFn(host, settings, {
			signal: controller.signal,
			onLanded: row => dispatch({ type: 'landed', runId, row }),
			runContext: () => (current.context ??= createRunContext(RUNNER_ENV)),
		}).then(
			result => {
				dispatch(settledAction(runId, result));
				// A superseded run's result is dropped by the reducer, so it is not logged either.
				if (runId === current.runId) logAssumptions(result, { specId: measuredOn.specId, settings });
			},
			(error: unknown) => dispatch({ type: 'failed', runId, message: describeRunError(error) }),
		);
	};

	/** Nothing is cancelled mid-sim: the engine finishes the step in flight and returns the rows so far (option (a), ticket 559). */
	const stop = () => {
		const current = session.current;
		if (!current.controller) return;
		current.controller.abort();
		dispatch({ type: 'stopping', runId: current.runId });
	};

	const dispatchFixture = (ranking: Ranking, inputsSignature: string) => {
		const current = session.current;
		current.controller?.abort();
		const measuredOn = measuredOnPage(host, inputsSignature);
		dispatch({ type: 'fixtureLoaded', runId: ++current.runId, ranking, measuredOn });
		logAssumptions(ranking, { specId: measuredOn.specId });
	};

	return { run, start, stop, dispatchFixture };
}
