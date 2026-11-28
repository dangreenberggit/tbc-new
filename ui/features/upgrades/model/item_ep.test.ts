import { ItemSlot } from '@generated/proto/common';
import { Stats } from '@sim/proto/stats';
import { describe, expect, it, vi } from 'vitest';

import { testItem } from '../testing/db_pool';
import { SIM_ORDER } from './engine/slots';
import { itemEpFor } from './item_ep';

// A suffix's stats come from `Database.getSync()`; the real class over the test database stands in for the page's.
vi.mock('@sim/proto/database', importOriginal => import('../testing/database_mock').then(m => m.withTestDatabase(importOriginal)));

const SYPHON = 32262; // Syphon of the Nathrezim: 196-365 damage, speed 2.8, 50 of stats 17 and 18
const DRAGONSPINE = 28830; // Dragonspine Trophy: no weapon damage, 40 of stats 17 and 18
const RAVAGERS_BRACERS = 30687; // no strength of its own
const OF_THE_BEAST = -41; // strength, agility and stamina
const SYPHON_DPS = (196 + 365) / 2 / 2.8;

// db.json keeps an item's stats under its scaling options; the page's `Database` copies them to `stats` when it loads.
const pageItem = (id: number) => {
	const item = testItem(id);
	return item && { ...item, stats: Stats.fromMap(item.scalingOptions[0].stats).asProtoArray() };
};

describe('itemEpFor', () => {
	const itemEp = itemEpFor({ weights: { '17': 1 }, pseudoWeights: { '0': 8, '1': 3, '2': 2 } }, pageItem);

	it("adds a weapon's damage per second at the weight of the slot it goes in", () => {
		expect(itemEp(SYPHON, 'mainhand')).toBeCloseTo(50 + SYPHON_DPS * 8, 6);
		expect(itemEp(SYPHON, 'offhand')).toBeCloseTo(50 + SYPHON_DPS * 3, 6);
	});

	it('gives an item with no weapon damage only its stats', () => {
		expect(itemEp(DRAGONSPINE, 'trinket1')).toBe(40);
	});

	it('scores an unknown item as 0', () => {
		expect(itemEp(999_999_999, 'mainhand')).toBe(0);
	});

	it('names the same slots as wowsims', () => {
		expect(SIM_ORDER.indexOf('mainhand')).toBe(ItemSlot.ItemSlotMainHand);
		expect(SIM_ORDER.indexOf('offhand')).toBe(ItemSlot.ItemSlotOffHand);
		expect(SIM_ORDER.indexOf('ranged')).toBe(ItemSlot.ItemSlotRanged);
	});

	it("scores a suffixed item with its suffix's stats", () => {
		// Strength only: the base bracers have none, "of the Beast" adds some.
		const strengthEp = itemEpFor({ weights: { '0': 1 }, pseudoWeights: {} });
		expect(strengthEp(RAVAGERS_BRACERS, 'wrist')).toBe(0);
		// 5259 per 10000 of the item's 41 random property points, rounded down
		// (`EquippedItem.withDynamicStats`, ui/sim/proto/equipped_item.ts).
		expect(strengthEp(RAVAGERS_BRACERS, 'wrist', OF_THE_BEAST)).toBe(Math.floor((5259 * 41) / 10000));
	});
});
