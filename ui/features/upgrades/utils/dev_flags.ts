/**
 * The Upgrades tab's dev-only URL flags, read in this one file so `model/`
 * never sees `location` and no component reads the query itself.
 *
 * `?upgrades-fixture=<name>` renders a saved ranking with no sim run;
 * `?upgrades-runner=replay:<name>` streams that ranking through the real run
 * path; `?upgrades-dev&cap=N&iterations=M` seeds a short live run.
 */

export type DevFlags = {
	fixture?: string;
	replay?: string;
	cap?: number;
	iterations?: number;
	/** `?upgrades-dev`: show the dev-only controls. */
	dev?: boolean;
};

/**
 * The only reader of the `__TBC_TAB_FIXTURES__` define. Vitest has no
 * `define`, and an undeclared global read under `typeof` does not throw, so
 * the guard keeps every test importable; a production build replaces the
 * constant with `false`, so each branch on this value is dropped as dead code.
 */
export const FIXTURES_ENABLED: boolean = typeof __TBC_TAB_FIXTURES__ !== 'undefined' && __TBC_TAB_FIXTURES__;

const REPLAY_PREFIX = 'replay:';

const positiveInteger = (raw: string | null): number | undefined => {
	if (raw === null || !/^\d+$/.test(raw)) return undefined;
	const value = Number(raw);
	return value > 0 ? value : undefined;
};

export function readDevFlags(search: string): DevFlags {
	const params = new URLSearchParams(search);
	const flags: DevFlags = {};

	const fixture = params.get('upgrades-fixture');
	if (fixture) flags.fixture = fixture;

	const runner = params.get('upgrades-runner');
	if (runner?.startsWith(REPLAY_PREFIX) && runner.length > REPLAY_PREFIX.length) {
		flags.replay = runner.slice(REPLAY_PREFIX.length);
	}

	// A stray `cap` or `iterations` on a shared link must not change a run, so
	// both need the explicit `upgrades-dev` switch.
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
