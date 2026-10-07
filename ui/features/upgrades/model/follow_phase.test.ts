import { Spec } from '@generated/proto/common';
import { createSimStore, patchSlice } from '@sim/state/sim_store';
import { fakeHost } from '@sim/testing';
import { describe, expect, it } from 'vitest';

import { poolFor } from './data/data';
import { followPhase } from './follow_phase';
import { validSourceKeysOf } from './settings_pool';
import { createUpgradesStore } from './upgrades_store';

/** A page at phase 3 whose tab store holds a pick, an exclusion only the phase-4 pool offers, and one no pool offers. */
const pageAt3 = (spec: Spec) => {
	const simStore = createSimStore();
	patchSlice(simStore, 'sim', { phase: 3 });
	const host = fakeHost({ player: { getSpec: () => spec }, sim: { store: simStore, getPhase: () => simStore.getState().sim.phase } });
	const store = createUpgradesStore({ iterations: 1000 });
	const offeredAt3 = validSourceKeysOf(poolFor('ret', 3));
	const onlyAt4 = validSourceKeysOf(poolFor('ret', 4)).find(key => !offeredAt3.includes(key));
	store.setState({
		settings: { ...store.getState().settings, selectedSetKeys: ['preset:3:P3'], excludedSources: [onlyAt4!, 'Nowhere'], defaultsFor: 'ret:3' },
	});
	followPhase(store, host);
	return { store, onlyAt4, patchSim: (patch: { phase?: number; iterations?: number }) => patchSlice(simStore, 'sim', patch) };
};

describe('followPhase', () => {
	it('sends the settings to the new phase’s defaults on a phase change, keeping only exclusions the new pool offers', () => {
		const { store, onlyAt4, patchSim } = pageAt3(Spec.SpecRetributionPaladin);
		patchSim({ phase: 4 });
		expect(store.getState().settings).toMatchObject({ selectedSetKeys: [], excludedSources: [onlyAt4], defaultsFor: undefined });
	});

	it('leaves the settings alone when another sim field changes', () => {
		const { store, patchSim } = pageAt3(Spec.SpecRetributionPaladin);
		const before = store.getState().settings;
		patchSim({ iterations: 5000 });
		expect(store.getState().settings).toBe(before);
	});

	it('leaves the settings alone for a spec with no ranking data', () => {
		const { store, patchSim } = pageAt3(Spec.SpecProtectionPaladin);
		const before = store.getState().settings;
		patchSim({ phase: 4 });
		expect(store.getState().settings).toBe(before);
	});
});
