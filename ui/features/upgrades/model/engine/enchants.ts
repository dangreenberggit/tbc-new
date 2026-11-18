/**
 * Enchant applicability by `(effectId, itemId)`: a thin bridge to the live
 * `Database` and `enchantAppliesToItem(enchant, item)` in
 * ui/sim/proto/items.ts, not a second implementation.
 */

import { Database } from '@sim/proto/database';
import { enchantAppliesToItem as upstreamEnchantAppliesToItem } from '@sim/proto/items';

import { getItem } from './items';

/**
 * `effectId` is `enchant.effectId`, so the lookup is a straight scan of the
 * enchant lists: small (TBC has a few hundred enchants) and run at most once
 * per candidate slot attempt.
 */
export function enchantAppliesToItem(effectId: number, itemId: number): boolean {
	const item = Database.getSync().getItemById(itemId);
	if (!item) return false;
	const itemEntry = getItem(itemId);
	if (!itemEntry) return false;

	// Database.getEnchants(slot) is keyed by ItemSlot, which callers do not
	// carry (they have the item's ItemType), so every slot's list is scanned.
	for (const slot of ALL_ITEM_SLOTS) {
		for (const enchant of Database.getSync().getEnchants(slot)) {
			if (enchant.effectId !== effectId) continue;
			if (upstreamEnchantAppliesToItem(enchant, item)) return true;
		}
	}
	return false;
}

/**
 * The stats of the enchant with this `effectId`, found the way
 * `enchantAppliesToItem` finds it, or `[]` when the database has none. An
 * enchant's hit counts toward the gem-repair hit budget.
 */
export function enchantStats(effectId: number): readonly number[] {
	for (const slot of ALL_ITEM_SLOTS) {
		for (const enchant of Database.getSync().getEnchants(slot)) {
			if (enchant.effectId === effectId) return enchant.stats;
		}
	}
	return [];
}

// ItemSlot values 0..16 (proto/common.proto). Database.getEnchants files an
// enchant under every slot it fits, so the cheapest correct scan is every slot.
const ALL_ITEM_SLOTS = Array.from({ length: 17 }, (_, i) => i);
