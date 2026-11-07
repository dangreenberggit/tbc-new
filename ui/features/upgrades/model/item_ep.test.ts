import { ItemSlot } from '@generated/proto/common';
import { Stats } from '@sim/proto/stats';
import { describe, expect, it } from 'vitest';

import { testItem } from '../testing/db_pool';
import { SIM_ORDER } from './engine/slots';
import { itemEpFor } from './item_ep';

const SYPHON = 32262; // Syphon of the Nathrezim: 196-365 damage, speed 2.8, 50 of stats 17 and 18
const DRAGONSPINE = 28830; // Dragonspine Trophy: no weapon damage, 40 of stats 17 and 18
const SYPHON_DPS = (196 + 365) / 2 / 2.8;

// db.json keeps an item's stats under its scaling options; the page's `Database` copies them to `stats` when it loads.
const pageItem = (id: number) => {
	const item = testItem(id);
	return item && { ...item, stats: Stats.fromMap(item.scalingOptions[0].stats).asProtoArray() };
};

describe('itemEpFor', () => {
	const itemEp = itemEpFor({ '17': 1 }, { '0': 8, '1': 3, '2': 2 }, pageItem);

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
});
