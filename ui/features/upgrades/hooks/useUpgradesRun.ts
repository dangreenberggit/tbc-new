import { useSimHost } from '@sim/context/SimHostContext';
import { useEffect, useReducer, useRef } from 'react';

import { equippedItemIds } from '../model/adapters/player_gear_source';
import type { Ranking } from '../model/engine/rank';
import { clearProgress } from '../model/progress_channel';
import { createRunContext, type RunContext, type RunFn, specIdFor } from '../model/run';
import { IDLE_RUN, type MeasuredOn, runReducer, type RunSettings, type RunState, settledAction } from '../model/run_reducer';
import { describeRunError } from '../utils/format';
import { RUNNER_ENV } from '../utils/runner_env';

export type UpgradesRun = {
	run: RunState;
	/** A click handler: a run starts only from the user's Run. */
	start: (settings: RunSettings) => void;
	stop: () => void;
	dispatchFixture: (ranking: Ranking) => void;
};

/**
 * The page's gear and spec now. Read at the click, because the progress
 * dialog blocks gear edits until the run settles, so this is the gear the
 * engine reads; and read when a fixture loads, which sets the page gear first.
 */
const measuredOnPage = (host: ReturnType<typeof useSimHost>): MeasuredOn => ({
	wornItemIds: equippedItemIds(host.player),
	specId: specIdFor(host.player.getSpec()),
});

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

	const start = (settings: RunSettings) => {
		const current = session.current;
		current.controller?.abort();
		const controller = new AbortController();
		current.controller = controller;
		const runId = ++current.runId;

		clearProgress(host.player);
		dispatch({ type: 'started', runId, startedAt: Date.now(), measuredOn: measuredOnPage(host) });
		runFn(host, settings, {
			signal: controller.signal,
			onLanded: row => dispatch({ type: 'landed', runId, row }),
			runContext: () => (current.context ??= createRunContext(RUNNER_ENV)),
		}).then(
			result => dispatch(settledAction(runId, result)),
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

	const dispatchFixture = (ranking: Ranking) => {
		const current = session.current;
		current.controller?.abort();
		dispatch({ type: 'fixtureLoaded', runId: ++current.runId, ranking, measuredOn: measuredOnPage(host) });
	};

	return { run, start, stop, dispatchFixture };
}
