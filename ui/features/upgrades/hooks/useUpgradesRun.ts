import { useSimHost } from '@sim/context/SimHostContext';
import { useEffect, useReducer, useRef } from 'react';

import type { Ranking } from '../model/engine/rank';
import { clearProgress } from '../model/progress_channel';
import { createRunContext, type RunContext, type RunFn } from '../model/run';
import { IDLE_RUN, runReducer, type RunSettings, type RunState, settledAction } from '../model/run_reducer';
import { describeRunError } from '../utils/format';
import { RUNNER_ENV } from '../utils/runner_env';

export type UpgradesRun = {
	run: RunState;
	/** A click handler: a run starts only from the user's Run. */
	start: (settings: RunSettings) => void;
	stop: () => void;
	dispatchFixture: (ranking: Ranking) => void;
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

	const start = (settings: RunSettings) => {
		const current = session.current;
		current.controller?.abort();
		const controller = new AbortController();
		current.controller = controller;
		const runId = ++current.runId;

		clearProgress(host.player);
		dispatch({ type: 'started', runId, startedAt: Date.now() });
		runFn(host, settings, {
			signal: controller.signal,
			onLanded: row => dispatch({ type: 'landed', runId, row }),
			runContext: () => (current.context ??= createRunContext(RUNNER_ENV)),
		}).then(
			result => dispatch(settledAction(runId, result)),
			(error: unknown) => dispatch({ type: 'failed', runId, message: describeRunError(error) }),
		);
	};

	const stop = () => session.current.controller?.abort();

	const dispatchFixture = (ranking: Ranking) => {
		const current = session.current;
		current.controller?.abort();
		dispatch({ type: 'fixtureLoaded', runId: ++current.runId, ranking });
	};

	return { run, start, stop, dispatchFixture };
}
