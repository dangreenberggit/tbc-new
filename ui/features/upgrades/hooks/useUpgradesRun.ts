import { useSimHost } from '@sim/context/SimHostContext';
import { useEffect, useState } from 'react';

import type { RunFn } from '../model/run';
import { createRunSession, type RunSession, type RunSessionEnv } from '../model/run_session';
import { describeRunError } from '../utils/format';
import { RUNNER_ENV } from '../utils/runner_env';
import { useUpgradesStoreApi } from './useUpgradesStore';

export type UpgradesRun = Pick<RunSession, 'start' | 'stop' | 'loadFixture'>;

const SESSION_ENV: RunSessionEnv = { runner: RUNNER_ENV, describeError: describeRunError };

/**
 * The tab's one run, written to the page's tab store; read it with
 * `useUpgradesStore(selectRun)`. The session is created once, from the first
 * render's host, store and run function, which are fixed for the page's
 * lifetime, and it is disposed on unmount (abort the run).
 */
export function useUpgradesRun(runFn: RunFn): UpgradesRun {
	const host = useSimHost();
	const store = useUpgradesStoreApi();
	const [session] = useState(() => createRunSession(store, host, runFn, SESSION_ENV));
	useEffect(() => () => session.dispose(), [session]);
	return session;
}
