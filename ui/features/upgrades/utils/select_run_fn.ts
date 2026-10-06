import { replayRows } from '../model/replay_run';
import { rankForPlayer, type RunFn } from '../model/run';
import { type DevFlags, FIXTURES_ENABLED } from './dev_flags';
import { fetchFixture } from './fixture';

/** Streams a recorded fixture's rows through the real run path. The fetch happens when Run is pressed, never during render. */
export const replayFixture =
	(name: string): RunFn =>
	async (host, settings, deps) =>
		replayRows((await fetchFixture(name)).ranking)(host, settings, deps);

export const selectRunFn = (flags: DevFlags): RunFn => (FIXTURES_ENABLED && flags.replay ? replayFixture(flags.replay) : rankForPlayer);
