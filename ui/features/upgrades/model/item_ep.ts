/**
 * The candidate order's item score: `Player.computeItemEP`'s `calcStats(slot)` and
 * `computeEP` (`ui/sim/player/player.ts`), but with the tab's bundled weights, not
 * the page's. `calcStats(slot)` counts weapon DPS as a pseudo-stat, which
 * `pseudoWeights` prices.
 */

import type { ItemRandomSuffix } from '@generated/proto/common';
import type { UIItem } from '@generated/proto/ui';
import { Database } from '@sim/proto/database';
import { EquippedItem } from '@sim/proto/equipped_item';
import { Stats } from '@sim/proto/stats';

import type { EpWeightsFile } from './data/data';
import type { ItemEp } from './engine/candidate-order';
import { SIM_ORDER } from './engine/slots';

type ItemLookup = (itemId: number) => UIItem | undefined;

const pageItem: ItemLookup = itemId => Database.getSync().getItemById(itemId);

const pageSuffix = (id: number): ItemRandomSuffix | undefined => Database.getSync().getRandomSuffixById(id);

/**
 * A suffixed item's stats as bulk sim prices one (`lookupItem` in
 * `ui/features/bulk/model/items.ts`: `withDynamicStats` puts the suffix's stats on the item).
 */
function equippedItem(item: UIItem, randomSuffix: number | undefined): EquippedItem {
	const suffix = randomSuffix ? pageSuffix(randomSuffix) : undefined;
	return suffix ? new EquippedItem({ item, randomSuffix: suffix }).withDynamicStats() : new EquippedItem({ item });
}

export function itemEpFor({ weights, pseudoWeights }: Readonly<EpWeightsFile>, lookup: ItemLookup = pageItem): ItemEp {
	const epWeights = Stats.fromMap(weights, pseudoWeights);
	const cache = new Map<string, number>();
	return (itemId, slot, randomSuffix) => {
		const key = `${itemId}:${slot}:${randomSuffix ?? 0}`;
		const cached = cache.get(key);
		if (cached !== undefined) return cached;
		const item = lookup(itemId);
		// SIM_ORDER is wowsims' ItemSlot order, so its index is the ItemSlot value.
		const ep = item ? equippedItem(item, randomSuffix).calcStats(SIM_ORDER.indexOf(slot)).computeEP(epWeights) : 0;
		cache.set(key, ep);
		return ep;
	};
}
