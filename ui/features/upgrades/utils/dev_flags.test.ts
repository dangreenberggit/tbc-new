import { afterEach, describe, expect, it, vi } from 'vitest';

import { readDevFlags } from './dev_flags';

describe('readDevFlags', () => {
	it('reads nothing from an empty query', () => {
		expect(readDevFlags('')).toEqual({});
	});

	it('reads the replay runner, the cap and the iterations', () => {
		expect(readDevFlags('?upgrades-dev&cap=10&iterations=500&upgrades-runner=replay:x')).toEqual({
			replay: 'x',
			cap: 10,
			iterations: 500,
			dev: true,
		});
	});

	it('ignores cap and iterations without upgrades-dev', () => {
		expect(readDevFlags('?cap=10&iterations=500')).toEqual({});
	});

	it('ignores a cap or iteration count that is not a positive whole number', () => {
		expect(readDevFlags('?upgrades-dev&cap=0&iterations=abc')).toEqual({ dev: true });
		expect(readDevFlags('?upgrades-dev&cap=-3&iterations=2.5')).toEqual({ dev: true });
	});

	it('ignores a runner other than replay, and a replay with no name', () => {
		expect(readDevFlags('?upgrades-runner=live')).toEqual({});
		expect(readDevFlags('?upgrades-runner=replay:')).toEqual({});
	});
});

describe('DEV_FLAGS', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.resetModules();
		window.history.replaceState(null, '', '/');
	});

	/** `FIXTURES_ENABLED` and `DEV_FLAGS` are read once at module load, so each switch value needs a fresh module. */
	const importWith = async (dev: boolean, harness: string) => {
		vi.stubEnv('DEV', dev);
		vi.stubEnv('VITE_TBC_TAB_FIXTURES', harness);
		window.history.replaceState(null, '', '/?upgrades-runner=replay:ret-p3-p2');
		vi.resetModules();
		return import('./dev_flags');
	};

	it('is empty on a production build, whatever the query says', async () => {
		const fresh = await importWith(false, '');
		expect(fresh.FIXTURES_ENABLED).toBe(false);
		expect(fresh.DEV_FLAGS).toEqual({});
	});

	it('reads the page query on the dev server', async () => {
		const fresh = await importWith(true, '');
		expect(fresh.FIXTURES_ENABLED).toBe(true);
		expect(fresh.DEV_FLAGS).toEqual({ replay: 'ret-p3-p2' });
	});

	it('reads the page query in the gate harness build', async () => {
		const fresh = await importWith(false, '1');
		expect(fresh.FIXTURES_ENABLED).toBe(true);
		expect(fresh.DEV_FLAGS).toEqual({ replay: 'ret-p3-p2' });
	});
});
