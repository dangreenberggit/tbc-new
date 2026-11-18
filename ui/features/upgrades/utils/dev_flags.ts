/**
 * The Upgrades tab's dev-only URL flags, read in this one file so `model/` never
 * sees `location`. `?upgrades-runner=replay:<name>` streams a saved ranking through
 * the real run path; `?upgrades-dev&cap=N&iterations=M` seeds a short live run.
 * `?upgrades-fixture=<name>` is read by the dev-server fixture plugin's script.
 */

export type DevFlags = {
	replay?: string;
	cap?: number;
	iterations?: number;
	/** `?upgrades-dev`: show the dev-only controls. */
	dev?: boolean;
};

/**
 * Fixtures are on for the dev server, or with `VITE_TBC_TAB_FIXTURES=1`. A production
 * build without that variable replaces the reads with `false` and drops each branch as
 * dead code. `FixtureFileInput` reads the env itself, so its body is dropped even if
 * the bundler does not remove dead code across modules.
 */
export const FIXTURES_ENABLED: boolean = import.meta.env.DEV || import.meta.env.VITE_TBC_TAB_FIXTURES === '1';

const REPLAY_PREFIX = 'replay:';

const positiveInteger = (raw: string | null): number | undefined => {
	if (raw === null || !/^\d+$/.test(raw)) return undefined;
	const value = Number(raw);
	return value > 0 ? value : undefined;
};

export function readDevFlags(search: string): DevFlags {
	const params = new URLSearchParams(search);
	const flags: DevFlags = {};

	const runner = params.get('upgrades-runner');
	if (runner?.startsWith(REPLAY_PREFIX) && runner.length > REPLAY_PREFIX.length) {
		flags.replay = runner.slice(REPLAY_PREFIX.length);
	}

	// A stray `cap` or `iterations` on a shared link must not change a run.
	if (params.has('upgrades-dev')) {
		flags.dev = true;
		const cap = positiveInteger(params.get('cap'));
		if (cap !== undefined) flags.cap = cap;
		const iterations = positiveInteger(params.get('iterations'));
		if (iterations !== undefined) flags.iterations = iterations;
	}

	return flags;
}

export const DEV_FLAGS: DevFlags = FIXTURES_ENABLED ? readDevFlags(location.search) : {};
