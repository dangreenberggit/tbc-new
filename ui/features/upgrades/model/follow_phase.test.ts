import { Spec } from '@generated/proto/common';
import { createSimStore, patchSlice } from '@sim/state/sim_store';
import { fakeHost } from '@sim/testing';
import { describe, expect, it } from 'vitest';

import { dbPoolHost } from '../testing/db_pool';
import { settled } from '../testing/fake_tab_host';
import { poolFor } from './data/data';
import { followPhase } from './follow_phase';
import { effectiveExcludedSources, validSourceKeysOf } from './settings_pool';
import { createUpgradesStore } from './upgrades_store';

/**
 * A ret page at phase 3, over the fork's db.json and ret's presets, once it has started up (when the tab starts
 * following the phase), whose tab store holds a pick, an exclusion only the phase-4 pool offers, and one no pool offers.
 */
const pageAt3 = async (spec: Spec) => {
	const simStore = createSimStore();
	patchSlice(simStore, 'sim', { phase: 3 });
	const page = dbPoolHost('ret');
	const host = fakeHost({
		player: { ...page.player, getSpec: () => spec },
		sim: { ...page.sim, store: simStore, getPhase: () => simStore.getState().sim.phase, waitForInit: () => Promise.resolve() },
		individualConfig: page.individualConfig,
	});
	const store = createUpgradesStore({ iterations: 1000 });
	followPhase(store, host);
	await settled();
	const offeredAt3 = validSourceKeysOf(poolFor(host, 3));
	const offeredAt4 = validSourceKeysOf(poolFor(host, 4));
	const onlyAt4 = offeredAt4.find(key => !offeredAt3.includes(key));
	expect(onlyAt4).toBeDefined();
	store.setState({
		settings: { ...store.getState().settings, selectedSetKeys: ['preset:3:P3'], excludedSources: [onlyAt4!, 'Nowhere'], defaultsFor: 'ret:3' },
	});
	return { store, onlyAt4, offeredAt4, patchSim: (patch: { phase?: number; iterations?: number }) => patchSlice(simStore, 'sim', patch) };
};

describe('followPhase', () => {
	it('sends the settings to the new phase’s defaults on a phase change, keeping only exclusions the new pool offers', async () => {
		const { store, onlyAt4, patchSim } = await pageAt3(Spec.SpecRetributionPaladin);
		patchSim({ phase: 4 });
		expect(store.getState().settings).toMatchObject({ selectedSetKeys: [], excludedSources: [onlyAt4], defaultsFor: undefined });
	});

	it('keeps a ticked "Heroic dungeon", a source that starts unticked, through a phase change that still offers it', async () => {
		const { store, offeredAt4, patchSim } = await pageAt3(Spec.SpecRetributionPaladin);
		expect(offeredAt4).toContain('Heroic dungeon');
		store.setState({ settings: { ...store.getState().settings, excludedSources: ['Heroic dungeon'] } });
		patchSim({ phase: 4 });
		const stored = store.getState().settings.excludedSources;
		expect(stored).toEqual(['Heroic dungeon']);
		expect(effectiveExcludedSources(stored, offeredAt4)).toEqual([]);
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
