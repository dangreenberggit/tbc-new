import { EquipmentSpec, Spec } from '@generated/proto/common';
import { SimHostProvider } from '@sim/context/SimHostContext';
import { createSimStore, patchSlice } from '@sim/state/sim_store';
import { fakeHost } from '@sim/testing';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { PoolEntry } from '../model/engine/pool';

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
	poolFor: (_spec: string, phase: number) => POOLS[phase] ?? [],
	bisTagPhaseFor: (_spec: string, phase: number) => ({ tagsFromPhase: phase, requestedPhase: phase }),
}));

const { useUpgradesSettings } = await import('./useUpgradesSettings');

const gear = (...ids: number[]) => EquipmentSpec.create({ items: ids.map(id => ({ id })) });
const PRESETS = [
	{ name: 'P3', phase: 3, gear: gear(1) },
	{ name: 'P3 Alt', phase: 3, gear: gear(2) },
	{ name: 'P4', phase: 4, gear: gear(4) },
];

const mount = (spec = Spec.SpecRetributionPaladin) => {
	const store = createSimStore();
	patchSlice(store, 'sim', { phase: 3 });
	const host = fakeHost({
		player: { getSpec: () => spec },
		sim: { store },
		individualConfig: { presets: { gear: PRESETS } },
		getSavedGearStorageKey: () => 'upgrades-settings-test-gear',
	});
	const wrapper = ({ children }: { children: ReactNode }) => <SimHostProvider host={host}>{children}</SimHostProvider>;
	const view = renderHook(() => useUpgradesSettings({ iterations: 500 }), { wrapper });
	return { view, setPhase: (phase: number) => act(() => patchSlice(store, 'sim', { phase })) };
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

	it('selects the new phase’s defaults when the phase changes, and drops an exclusion the new pool lacks', () => {
		const { view, setPhase } = mount();
		act(() => view.result.current.toggleSource('Hyjal Summit'));
		expect(view.result.current.runSettings.excludedSources).toEqual(['Hyjal Summit']);

		setPhase(4);
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

	it('writes a typed number into its field before the picker re-reads it', () => {
		const { view } = mount();
		const { iterationsField, capField } = view.result.current;
		expect(iterationsField.current).toBe(500);
		expect(capField.current).toBe(0);

		act(() => {
			view.result.current.onIterationsChange(2000);
			// What the picker's notification reads, before this hook renders again.
			expect(iterationsField.current).toBe(2000);
			view.result.current.onCapChange(40);
		});
		expect(view.result.current.iterationsField).toBe(iterationsField);
		expect(view.result.current.runSettings).toMatchObject({ iterations: 2000, candidateCap: 40 });
	});

	it('offers nothing and counts nothing for a spec with no ranking data', () => {
		const { view } = mount(Spec.SpecProtectionPaladin);
		expect(view.result.current.eligibleCount).toBeUndefined();
		expect(view.result.current.sources).toEqual({ raids: [], other: [] });
		expect(selectedKeys(view.result.current)).toEqual([]);
	});
});
