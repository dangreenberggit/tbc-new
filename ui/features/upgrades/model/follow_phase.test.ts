import { Spec } from '@generated/proto/common';
import { createSimStore, patchSlice } from '@sim/state/sim_store';
import { fakeHost } from '@sim/testing';
import { describe, expect, it, vi } from 'vitest';

import { settled } from '../testing/fake_tab_host';
import { poolFor } from './data/data';
import type { PoolEntry } from './engine/pool';
import { followPhase } from './follow_phase';
import { effectiveExcludedSources, validSourceKeysOf } from './settings_pool';
import { createUpgradesStore } from './upgrades_store';

// The pool is built from the page's item database, which a unit test does not load (`pool_source.test.ts` covers the
// real one); these pools stand in for it, with a raid only phase 4 offers.
const { POOLS } = vi.hoisted(() => {
	const entry = (itemId: number, source: PoolEntry['source']): PoolEntry => ({ itemId, name: `item ${itemId}`, slot: 'head', phase: 3, source });
	const at3 = [
		entry(1, { kind: 'raid', zone: 'Black Temple' }),
		entry(2, { kind: 'raid', zone: 'Hyjal Summit' }),
		entry(5, { kind: 'heroic', dungeon: 'Mana-Tombs' }),
	];
	return { POOLS: { 3: at3, 4: [...at3, entry(3, { kind: 'raid', zone: 'Zul’Aman' })] } as Record<number, PoolEntry[]> };
});
vi.mock('./data/data', async importOriginal => ({
	...(await importOriginal<typeof import('./data/data')>()),
	poolFor: (_host: unknown, phase: number) => POOLS[phase] ?? [],
}));

/**
 * A page at phase 3, once it has started up (when the tab starts following the phase), whose tab store holds a
 * pick, an exclusion only the phase-4 pool offers, and one no pool offers.
 */
const pageAt3 = async (spec: Spec) => {
	const simStore = createSimStore();
	patchSlice(simStore, 'sim', { phase: 3 });
	const host = fakeHost({
		player: { getSpec: () => spec },
		sim: { store: simStore, getPhase: () => simStore.getState().sim.phase, waitForInit: () => Promise.resolve() },
	});
	const store = createUpgradesStore({ iterations: 1000 });
	followPhase(store, host);
	await settled();
	const offeredAt3 = validSourceKeysOf(poolFor(host, 3));
	const onlyAt4 = validSourceKeysOf(poolFor(host, 4)).find(key => !offeredAt3.includes(key));
	store.setState({
		settings: { ...store.getState().settings, selectedSetKeys: ['preset:3:P3'], excludedSources: [onlyAt4!, 'Nowhere'], defaultsFor: 'ret:3' },
	});
	return { store, onlyAt4, patchSim: (patch: { phase?: number; iterations?: number }) => patchSlice(simStore, 'sim', patch) };
};

describe('followPhase', () => {
	it('sends the settings to the new phase’s defaults on a phase change, keeping only exclusions the new pool offers', async () => {
		const { store, onlyAt4, patchSim } = await pageAt3(Spec.SpecRetributionPaladin);
		patchSim({ phase: 4 });
		expect(store.getState().settings).toMatchObject({ selectedSetKeys: [], excludedSources: [onlyAt4], defaultsFor: undefined });
	});

	it('keeps a ticked "Heroic dungeon", a source that starts unticked, through a phase change that still offers it', async () => {
		const { store, patchSim } = await pageAt3(Spec.SpecRetributionPaladin);
		store.setState({ settings: { ...store.getState().settings, excludedSources: ['Heroic dungeon'] } });
		patchSim({ phase: 4 });
		const stored = store.getState().settings.excludedSources;
		expect(stored).toEqual(['Heroic dungeon']);
		expect(effectiveExcludedSources(stored, validSourceKeysOf(POOLS[4]!))).toEqual([]);
	});

	it('leaves the settings alone when another sim field changes', async () => {
		const { store, patchSim } = await pageAt3(Spec.SpecRetributionPaladin);
		const before = store.getState().settings;
		patchSim({ iterations: 5000 });
		expect(store.getState().settings).toBe(before);
	});

	it('leaves the settings alone for a spec with no ranking data', async () => {
		const { store, patchSim } = await pageAt3(Spec.SpecProtectionPaladin);
		const before = store.getState().settings;
		patchSim({ phase: 4 });
		expect(store.getState().settings).toBe(before);
	});
});
