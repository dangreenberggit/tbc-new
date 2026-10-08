import { addBulkItems, hasBulkItem, seedBulkPickerGroups } from '@features/bulk/model/items';
import { ItemSlot, ItemSpec } from '@generated/proto/common';
import { DatabaseFilters } from '@generated/proto/ui';
import i18n from '@i18n/config';
import { SimHostProvider } from '@sim/context/SimHostContext';
import { seedBulkSettings } from '@sim/settings/bulk_settings';
import { createSimStore, PLAYER_FIELDS, seedKeyed, zeroVersions } from '@sim/state/sim_store';
import { fakeHost } from '@sim/testing';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import englishTranslations from '../../../../../assets/locales/en/translation.json';
import upgradesTranslations from '../../../../../assets/locales/en/upgrades.json';
import { BatchToggle, FavoriteToggle } from '.';

// Every item fits one ring slot, so the batch has one picker group to file it in.
vi.mock('@sim/proto/items', async () => ({
	...(await vi.importActual<typeof import('@sim/proto/items')>('@sim/proto/items')),
	getEligibleItemSlots: () => [ItemSlot.ItemSlotFinger1],
	canEquipItem: () => true,
}));
vi.mock('@sim/bulk/utils', async () => ({
	...(await vi.importActual<typeof import('@sim/bulk/utils')>('@sim/bulk/utils')),
	getBulkPlayerCanDualWield: () => false,
}));

beforeAll(() => i18n.addResourceBundle('en', 'translation', englishTranslations, true, true));
beforeAll(() => i18n.addResourceBundle('en', 'upgrades', upgradesTranslations, true, true));
afterAll(() => i18n.removeResourceBundle('en', 'translation'));
afterAll(() => i18n.removeResourceBundle('en', 'upgrades'));

const STORE_KEY = 4;
const ITEM_ID = 32332;

const fakeEquippedItem = (id: number) => {
	const item = { id, item: { id, name: `Item ${id}`, unique: false }, _item: { id, name: `Item ${id}`, unique: false } };
	return { ...item, asSpec: () => ItemSpec.create({ id }), withDynamicStats: () => item };
};

/** A page with a real store: the sim's filters and the player's Bulk list live in it, as on the site. */
const mount = (ui: ReactNode) => {
	const store = createSimStore();
	const sim = {
		store,
		isNative: false,
		db: { lookupItemSpec: (spec: ItemSpec) => fakeEquippedItem(spec.id) },
		getFilters: () => DatabaseFilters.clone(store.getState().sim.filters),
		setFilters: (next: DatabaseFilters) => store.setState(state => ({ sim: { ...state.sim, filters: DatabaseFilters.clone(next) } })),
	};
	const host = fakeHost({ sim, player: { sim, storeKey: STORE_KEY, getPlayerSpec: () => ({ friendlyName: 'test' }) } });
	seedKeyed(store, 'players', STORE_KEY, { gear: { getEquippedItem: () => null }, v: zeroVersions(PLAYER_FIELDS) } as never);
	seedBulkSettings(host.player);
	seedBulkPickerGroups(host.player);
	render(<SimHostProvider host={host}>{ui}</SimHostProvider>);
	return host;
};

const pressed = (testId: string) => screen.getByTestId(testId).getAttribute('aria-pressed');

describe('FavoriteToggle', () => {
	it('adds the item to the sim’s favourites and reads pressed, and a second click takes it out', () => {
		const host = mount(<FavoriteToggle itemId={ITEM_ID} />);
		expect(pressed('upgrades-favorite-toggle')).toBe('false');

		fireEvent.click(screen.getByTestId('upgrades-favorite-toggle'));
		expect(host.sim.getFilters().favoriteItems).toEqual([ITEM_ID]);
		expect(pressed('upgrades-favorite-toggle')).toBe('true');
		expect(screen.getByTestId('upgrades-favorite-toggle').title).toBe('Remove from favorites');

		fireEvent.click(screen.getByTestId('upgrades-favorite-toggle'));
		expect(host.sim.getFilters().favoriteItems).toEqual([]);
		expect(pressed('upgrades-favorite-toggle')).toBe('false');
	});

	it('follows a favourite set elsewhere on the page', () => {
		const host = mount(<FavoriteToggle itemId={ITEM_ID} />);
		const next = host.sim.getFilters();
		next.favoriteItems = [ITEM_ID];
		act(() => host.sim.setFilters(next));
		expect(pressed('upgrades-favorite-toggle')).toBe('true');
	});
});

describe('BatchToggle', () => {
	it('adds the plain item to the Bulk list and reads pressed, and a second click removes it', () => {
		const host = mount(<BatchToggle itemId={ITEM_ID} />);
		const spec = ItemSpec.create({ id: ITEM_ID });
		expect(pressed('upgrades-batch-toggle')).toBe('false');

		fireEvent.click(screen.getByTestId('upgrades-batch-toggle'));
		expect(hasBulkItem(host.player, spec)).toBe(true);
		expect(pressed('upgrades-batch-toggle')).toBe('true');
		expect(screen.getByTestId('upgrades-batch-toggle').title).toBe('Remove from Batch Sim');

		fireEvent.click(screen.getByTestId('upgrades-batch-toggle'));
		expect(hasBulkItem(host.player, spec)).toBe(false);
		expect(pressed('upgrades-batch-toggle')).toBe('false');
	});

	it('does not read a gemmed copy of the item in the Bulk list as this row’s, because a click could not remove it', () => {
		const host = mount(<BatchToggle itemId={ITEM_ID} />);
		addBulkItems(host.player, [ItemSpec.create({ id: ITEM_ID, gems: [24027] })], true);
		expect(pressed('upgrades-batch-toggle')).toBe('false');
	});
});
