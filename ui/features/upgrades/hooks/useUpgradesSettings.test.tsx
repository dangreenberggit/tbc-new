import { EquipmentSpec, Spec } from '@generated/proto/common';
import { SimHostProvider } from '@sim/context/SimHostContext';
import { createSimStore, patchSlice } from '@sim/state/sim_store';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { PoolEntry } from '../model/engine/pool';
import { fakeTabHost, settled } from '../testing/fake_tab_host';
import type { UpgradesSettings } from './useUpgradesSettings';

const entry = (itemId: number, zone: string, phase: number, bis = false): PoolEntry => ({
	itemId,
	name: `item ${itemId}`,
	slot: 'head',
	phase,
	source: { kind: 'raid', zone },
	...(bis ? { bisTags: ['BiS'] } : {}),
});

/** A small pool per phase whose BiS tags speak for that phase, so each phase has one default preset. */
const POOLS: Record<number, PoolEntry[]> = {
	3: [entry(1, 'Black Temple', 3, true), entry(2, 'Hyjal Summit', 3), entry(3, 'Black Temple', 3)],
	4: [entry(1, 'Black Temple', 3), entry(4, 'Zul’Aman', 4, true), entry(5, 'Zul’Aman', 4)],
};
vi.mock('../model/data/data', async importOriginal => ({
	...(await importOriginal<typeof import('../model/data/data')>()),
	poolFor: (_host: unknown, phase: number) => POOLS[phase] ?? [],
	presetsWithPhase: (_host: unknown, presets: unknown) => presets,
	bisTagPhaseFor: (_host: unknown, _presets: unknown, phase: number) => ({ tagsFromPhase: phase, requestedPhase: phase }),
}));
// The pool waits for the sim's item database; these pools stand in for it.
vi.mock('@sim/hooks/useSimReady', () => ({ useSimReady: () => true }));

const { useUpgradesSettings } = await import('./useUpgradesSettings');
const { upgradesStoreFor } = await import('./useUpgradesStore');

const gear = (...ids: number[]) => EquipmentSpec.create({ items: ids.map(id => ({ id })) });
const PRESETS = [
	{ name: 'P3', phase: 3, gear: gear(1) },
	{ name: 'P3 Alt', phase: 3, gear: gear(2) },
	{ name: 'P4', phase: 4, gear: gear(4) },
];

/** A fresh page per case, so each case gets its own tab store (the store is keyed by the page's `Sim`). */
const mount = (spec = Spec.SpecRetributionPaladin) => {
	const store = createSimStore();
	patchSlice(store, 'sim', { phase: 3 });
	const host = fakeTabHost({
		player: { getSpec: () => spec },
		sim: { store, getPhase: () => store.getState().sim.phase },
		individualConfig: { presets: { gear: PRESETS } },
		getSavedGearStorageKey: () => 'upgrades-settings-test-gear',
	});
	const wrapper = ({ children }: { children: ReactNode }) => <SimHostProvider host={host}>{children}</SimHostProvider>;
	const render = () => renderHook(() => useUpgradesSettings(), { wrapper });
	return {
		view: render(),
		render,
		tabStore: upgradesStoreFor(host),
		/** A phase change the user makes once the page has started up, which is when the tab starts following the phase. */
		setPhase: async (phase: number) => {
			await settled();
			act(() => patchSlice(store, 'sim', { phase }));
		},
	};
};

const selectedKeys = (settings: { selectedOptions: readonly { key: string }[] }) => settings.selectedOptions.map(o => o.key);

describe('useUpgradesSettings', () => {
	it('selects the phase’s default sets on the first render, and keeps a deselection through later renders', () => {
		const { view } = mount();
		expect(selectedKeys(view.result.current)).toEqual(['preset:3:P3']);

		act(() => view.result.current.toggleSet('preset:3:P3'));
		view.rerender();
		expect(selectedKeys(view.result.current)).toEqual([]);
	});

	it('selects the new phase’s defaults when the phase changes, and drops an exclusion the new pool lacks', async () => {
		const { view, setPhase } = mount();
		act(() => view.result.current.toggleSource('Hyjal Summit'));
		expect(view.result.current.runSettings.excludedSources).toEqual(['Hyjal Summit']);

		await setPhase(4);
		expect(selectedKeys(view.result.current)).toEqual(['preset:4:P4']);
		expect(view.result.current.runSettings.excludedSources).toEqual([]);
		expect(view.result.current.sources.raids.map(o => o.key)).toEqual(['Black Temple', 'Zul’Aman']);
	});

	it('prunes only while a set is selected, and counts what the run would sim', () => {
		const { view } = mount();
		expect(view.result.current.eligibleCount).toBe(3);

		act(() => view.result.current.setPrune(true));
		expect(view.result.current.runSettings.prune).toBe(true);
		expect(view.result.current.eligibleCount).toBe(1);

		act(() => view.result.current.toggleSet('preset:3:P3'));
		expect(view.result.current.runSettings.prune).toBe(false);
		expect(view.result.current.eligibleCount).toBe(3);
	});

	it('writes a typed number to the tab store, which the pickers read back', () => {
		const { view, tabStore } = mount();
		expect(view.result.current.store).toBe(tabStore);
		expect(tabStore.getState().settings).toMatchObject({ iterations: 3000, candidateCap: undefined });

		act(() => {
			view.result.current.setIterations(2000);
			view.result.current.setCandidateCap(40);
		});
		expect(tabStore.getState().settings).toMatchObject({ iterations: 2000, candidateCap: 40 });
		expect(view.result.current.runSettings).toMatchObject({ iterations: 2000, candidateCap: 40 });
	});

	it('shows the phase’s default sets before any write, though the store holds none yet', () => {
		const { view, tabStore } = mount();
		expect(selectedKeys(view.result.current)).toEqual(['preset:3:P3']);
		expect(view.result.current.runSettings.guaranteedSetKeys).toEqual(['preset:3:P3']);
		expect(tabStore.getState().settings.selectedSetKeys).toEqual([]);
		expect(tabStore.getState().settings.defaultsFor).toBeUndefined();
	});

	it('shows the new phase’s defaults right after a phase change, before the tab writes them', async () => {
		const { view, setPhase, tabStore } = mount();
		await setPhase(4);
		expect(selectedKeys(view.result.current)).toEqual(['preset:4:P4']);
		expect(tabStore.getState().settings.defaultsFor).toBeUndefined();
	});

	it('gives every reader on the page the same effective settings', async () => {
		const { view, render, setPhase } = mount();
		const other = render();
		expect(other.result.current.runSettings).toEqual(view.result.current.runSettings);

		act(() => view.result.current.toggleSource('Hyjal Summit'));
		expect(other.result.current.runSettings).toEqual(view.result.current.runSettings);
		expect(other.result.current.runSettings.excludedSources).toEqual(['Hyjal Summit']);

		await setPhase(4);
		expect(selectedKeys(other.result.current)).toEqual(['preset:4:P4']);
		expect(other.result.current.runSettings).toEqual(view.result.current.runSettings);
	});

	// As on the old tab, which applied each phase's defaults on every phase change (bb6d447aa
	// `useUpgradesSettings.ts:76-79`), the result must not depend on an unrelated edit in between (review K2-1).
	it.each([
		{ path: 'with no edit at phase 4', editAtPhase4: () => {} },
		{ path: 'with an iterations edit at phase 4', editAtPhase4: (settings: UpgradesSettings) => settings.setIterations(2000) },
	])('selects the phase’s default sets again after a round trip to another phase, $path', async ({ editAtPhase4 }) => {
		const { view, render, setPhase } = mount();
		const outside = render();
		const expectAgreement = () => expect(outside.result.current.runSettings).toEqual(view.result.current.runSettings);
		act(() => {
			view.result.current.toggleSet('preset:3:P3');
			view.result.current.toggleSource('Hyjal Summit');
			view.result.current.toggleSource('Black Temple');
		});
		expect(selectedKeys(view.result.current)).toEqual([]);
		expectAgreement();

		await setPhase(4);
		act(() => editAtPhase4(view.result.current));
		expect(selectedKeys(view.result.current)).toEqual(['preset:4:P4']);
		// Phase 4's pool offers Black Temple but not Hyjal Summit.
		expect(view.result.current.excludedSources).toEqual(['Black Temple']);
		expectAgreement();

		await setPhase(3);
		expect(selectedKeys(view.result.current)).toEqual(['preset:3:P3']);
		expect(view.result.current.excludedSources).toEqual(['Black Temple']);
		expectAgreement();
	});

	it('keeps the selected sets’ identity while only other settings change, so the row badges do not render again', () => {
		const { view } = mount();
		const before = view.result.current.selectedOptions;

		act(() => view.result.current.setPrune(true));
		act(() => view.result.current.setIterations(2000));
		act(() => view.result.current.toggleSource('Hyjal Summit'));
		expect(view.result.current.selectedOptions).toBe(before);

		act(() => view.result.current.toggleSet('preset:3:P3'));
		expect(view.result.current.selectedOptions).not.toBe(before);
	});

	it('offers nothing and counts nothing for a spec with no ranking data', () => {
		const { view } = mount(Spec.SpecProtectionPaladin);
		expect(view.result.current.eligibleCount).toBeUndefined();
		expect(view.result.current.sources).toEqual({ raids: [], other: [] });
		expect(selectedKeys(view.result.current)).toEqual([]);
	});
});
