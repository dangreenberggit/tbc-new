import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEV_FLAGS, FIXTURES_ENABLED, readDevFlags } from './dev_flags';

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

	it('reads the fixture name', () => {
		expect(readDevFlags('?upgrades-fixture=feral-p3-nordrassil4')).toEqual({ fixture: 'feral-p3-nordrassil4' });
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
		vi.unstubAllGlobals();
		vi.resetModules();
		window.history.replaceState(null, '', '/');
	});

	it('is empty under vitest, where the define does not exist', () => {
		expect(FIXTURES_ENABLED).toBe(false);
		expect(DEV_FLAGS).toEqual({});
	});

	it('reads the page query when the define is true', async () => {
		vi.stubGlobal('__TBC_TAB_FIXTURES__', true);
		window.history.replaceState(null, '', '/?upgrades-runner=replay:ret-p3-p2');
		vi.resetModules();
		const fresh = await import('./dev_flags');
		expect(fresh.FIXTURES_ENABLED).toBe(true);
		expect(fresh.DEV_FLAGS).toEqual({ replay: 'ret-p3-p2' });
	});
});
