import { ItemSlot, Spec } from '@generated/proto/common';
import { SimHostProvider } from '@sim/context/SimHostContext';
import { createSimStore, patchKeyed, patchSlice, PLAYER_FIELDS, seedKeyed, zeroVersions } from '@sim/state/sim_store';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { PoolEntry } from '../model/engine/pool';
import { testItem } from '../testing/db_pool';
import { fakeTabHost } from '../testing/fake_tab_host';

// The engine reads hand types through the page's database; the test database stands in for it.
vi.mock('@sim/proto/database', () => ({ Database: { getSync: () => ({ getItemById: (id: number) => testItem(id) }) } }));

const weapon = (itemId: number): PoolEntry => ({ itemId, name: `item ${itemId}`, slot: 'weapon', phase: 3, source: { kind: 'raid', zone: 'Black Temple' } });

const HELD = [32361, 28734, 30911]; // Blind-Seers Icon, Jewel of Infinite Possibilities, Scepter of Purification: off hand only
const ONE_HANDER = 28524; // Emerald Ripper
const TWO_HANDER = 29988; // The Nexus Key
const POOL = [...HELD, ONE_HANDER, TWO_HANDER].map(weapon);
/** What a worn two-hander holds out: the off-hand-only items and the one-hander (tickets 365, 700). */
const HELD_OUT = HELD.length + 1;

vi.mock('../model/data/data', async importOriginal => ({
	...(await importOriginal<typeof import('../model/data/data')>()),
	poolFor: () => POOL,
	presetsWithPhase: (_host: unknown, presets: unknown) => presets,
	bisTagPhaseFor: () => undefined,
}));
// The pool waits for the sim's item database; the pool above stands in for it.
vi.mock('@sim/hooks/useSimReady', () => ({ useSimReady: () => true }));

const { useUpgradesSettings } = await import('./useUpgradesSettings');

const STORE_KEY = 1;
/** The part of the player's `Gear` the settings read: the worn main hand. */
const wearing = (mainHandId: number) => ({
	getEquippedItem: (slot: ItemSlot) => (slot === ItemSlot.ItemSlotMainHand ? { id: mainHandId } : null),
});

const mount = (mainHandId: number) => {
	const store = createSimStore();
	patchSlice(store, 'sim', { phase: 3 });
	seedKeyed(store, 'players', STORE_KEY, { gear: wearing(mainHandId), v: zeroVersions(PLAYER_FIELDS) } as never);
	const host = fakeTabHost({
		player: { getSpec: () => Spec.SpecMage, storeKey: STORE_KEY },
		sim: { store, getPhase: () => store.getState().sim.phase },
		getSavedGearStorageKey: () => 'upgrades-settings-offhand-test-gear',
	});
	const wrapper = ({ children }: { children: ReactNode }) => <SimHostProvider host={host}>{children}</SimHostProvider>;
	return {
		view: renderHook(() => useUpgradesSettings(), { wrapper }),
		/** A weapon swap on the gear tab, which writes the player's gear to the sim store. */
		wear: (id: number) => act(() => patchKeyed(store, 'players', STORE_KEY, { gear: wearing(id) } as never, ['gear'])),
	};
};

describe('useUpgradesSettings and the worn main hand', () => {
	it('counts the off-hand-only items and one-handers again when a two-hander is swapped for a one-hander', () => {
		const { view, wear } = mount(TWO_HANDER);
		expect(view.result.current.eligibleCount).toBe(POOL.length - HELD_OUT);

		wear(ONE_HANDER);
		expect(view.result.current.eligibleCount).toBe(POOL.length);

		wear(TWO_HANDER);
		expect(view.result.current.eligibleCount).toBe(POOL.length - HELD_OUT);
	});
});
