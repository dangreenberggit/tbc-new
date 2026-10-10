import type { Env } from '@sim/state/env';
import { fakeHost, type FakeHostParts } from '@sim/testing';

/** In-memory `Env['storage']`, as the test harnesses upstream's `Env` comment names pass in; `entries` is what it holds. */
export const memoryStorage = (initial: Record<string, string> = {}): Env['storage'] & { entries: Map<string, string> } => {
	const entries = new Map(Object.entries(initial));
	return {
		entries,
		getItem: key => entries.get(key) ?? null,
		setItem: (key, value) => void entries.set(key, value),
		removeItem: key => void entries.delete(key),
	};
};

/**
 * Upstream's `fakeHost` plus what the tab's store reads when it is made: the
 * page's storage key, `sim.env.storage`, and `sim.waitForInit`, after which
 * the store follows the phase. Each host's storage starts empty, so no test
 * sees another test's saved settings, and its sim has already started up. A
 * `sim` passed in keeps its identity, because the tab's store is keyed by it.
 */
export const fakeTabHost = (parts: FakeHostParts = {}) => {
	const sim = (parts.sim ?? {}) as { env?: Partial<Env>; waitForInit?: () => Promise<void> };
	sim.env ??= { storage: memoryStorage() };
	sim.waitForInit ??= () => Promise.resolve();
	return fakeHost({ getStorageKey: (part: string) => `__upgrades_test${part}`, ...parts, sim });
};
