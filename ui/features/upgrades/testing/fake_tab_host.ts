import type { Env } from '@sim/state/env';
import { fakeHost, type FakeHostParts } from '@sim/testing';

/** In-memory `Env['storage']` for tests; `entries` holds what was written. */
export const memoryStorage = (initial: Record<string, string> = {}): Env['storage'] & { entries: Map<string, string> } => {
	const entries = new Map(Object.entries(initial));
	return {
		entries,
		getItem: key => entries.get(key) ?? null,
		setItem: (key, value) => void entries.set(key, value),
		removeItem: key => void entries.delete(key),
	};
};

/** Waits one timer turn, so promise callbacks queued so far have run: a page's `waitForInit` handlers, a settled run. */
export const flushPromises = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

/**
 * `fakeHost` plus what the tab's store reads when it is made: the storage key, no
 * preset gear sets, `sim.env.storage` and an already resolved `sim.waitForInit`.
 * Each host's storage starts empty, so no test sees another's saved settings. A
 * `sim` passed in keeps its identity, because the tab's store is keyed by it.
 */
export const fakeTabHost = (parts: FakeHostParts = {}) => {
	const sim = (parts.sim ?? {}) as { env?: Partial<Env>; waitForInit?: () => Promise<void> };
	sim.env ??= { storage: memoryStorage() };
	sim.waitForInit ??= () => Promise.resolve();
	// The settings read the worn gear through the player's sim store (`usePlayerStore`).
	const player = { sim, ...(parts.player as object | undefined) };
	return fakeHost({ getStorageKey: (part: string) => `__upgrades_test${part}`, individualConfig: { presets: { gear: [] } }, ...parts, player, sim });
};
