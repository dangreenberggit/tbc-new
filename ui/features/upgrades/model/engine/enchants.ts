/**
 * Whether an enchant fits an item, by `(effectId, itemId)`: calls the live `Database` and
 * `enchantAppliesToItem(enchant, item)` in ui/sim/proto/items.ts, not a second copy.
 */

import { Database } from '@sim/proto/database';
import { enchantAppliesToItem as upstreamEnchantAppliesToItem } from '@sim/proto/items';

import { getItem } from './items';
import { SIM_ORDER } from './slots';

/** A straight scan by `enchant.effectId`: a few hundred enchants, once per slot attempt. */
export function enchantAppliesToItem(effectId: number, itemId: number): boolean {
	const item = Database.getSync().getItemById(itemId);
	if (!item) return false;
	const itemEntry = getItem(itemId);
	if (!itemEntry) return false;

	// getEnchants is keyed by ItemSlot, which callers do not carry, so scan every slot.
	for (const slot of ALL_ITEM_SLOTS) {
		for (const enchant of Database.getSync().getEnchants(slot)) {
			if (enchant.effectId !== effectId) continue;
			if (upstreamEnchantAppliesToItem(enchant, item)) return true;
		}
	}
	return false;
}

/** The stats of the enchant with this `effectId`, or `[]`, for the hit budget. */
export function enchantStats(effectId: number): readonly number[] {
	for (const slot of ALL_ITEM_SLOTS) {
		for (const enchant of Database.getSync().getEnchants(slot)) {
			if (enchant.effectId === effectId) return enchant.stats;
		}
	}
	return [];
}

const ALL_ITEM_SLOTS = SIM_ORDER.map((_, slot) => slot);
