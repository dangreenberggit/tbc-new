import type { Env } from '@sim/state/env';
import { fakeHost, type FakeHostParts } from '@sim/testing';

/** In-memory `Env['storage']`, as the test harnesses upstream's `Env` comment names pass in. */
export const memoryStorage = (): Env['storage'] => {
	const entries = new Map<string, string>();
	return {
		getItem: key => entries.get(key) ?? null,
		setItem: (key, value) => void entries.set(key, value),
		removeItem: key => void entries.delete(key),
	};
};

/**
 * Upstream's `fakeHost` plus what the tab's store reads when it is made: the
 * page's storage key and `sim.env.storage`. Each host's storage starts empty,
 * so no test sees another test's saved settings. A `sim` passed in keeps its
 * identity, because the tab's store is keyed by it.
 */
export const fakeTabHost = (parts: FakeHostParts = {}) => {
	const sim = (parts.sim ?? {}) as { env?: Partial<Env> };
	sim.env ??= { storage: memoryStorage() };
	return fakeHost({ getStorageKey: (part: string) => `__upgrades_test${part}`, ...parts, sim });
};
