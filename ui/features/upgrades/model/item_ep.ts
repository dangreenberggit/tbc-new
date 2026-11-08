/**
 * The candidate order's item score, computed by wowsims' own code: the same
 * `EquippedItem.calcStats(slot)` and `Stats.computeEP` that the gear picker's
 * `Player.computeItemEP` uses (`ui/sim/player/player.ts`). `calcStats(slot)`
 * adds a weapon's damage per second as the main-hand, off-hand or ranged
 * pseudo-stat of that slot, so the tab's weights file's `pseudoWeights` price
 * weapon damage.
 *
 * Not `Player.computeItemEP` itself: that scores with the page's EP weights,
 * and the tab orders by its bundled weights set (`data/data.ts`).
 */

import type { UIItem } from '@generated/proto/ui';
import { Database } from '@sim/proto/database';
import { EquippedItem } from '@sim/proto/equipped_item';
import { Stats } from '@sim/proto/stats';

import type { EpWeightsFile } from './data/data';
import type { ItemEp } from './engine/candidate-order';
import { SIM_ORDER } from './engine/slots';

type ItemLookup = (itemId: number) => UIItem | undefined;

const pageItem: ItemLookup = itemId => Database.getSync().getItemById(itemId);

export function itemEpFor({ weights, pseudoWeights }: Readonly<EpWeightsFile>, lookup: ItemLookup = pageItem): ItemEp {
	const epWeights = Stats.fromMap(weights, pseudoWeights);
	const cache = new Map<string, number>();
	return (itemId, slot) => {
		const key = `${itemId}:${slot}`;
		const cached = cache.get(key);
		if (cached !== undefined) return cached;
		const item = lookup(itemId);
		// SIM_ORDER is wowsims' ItemSlot order, so its index is the ItemSlot value.
		const ep = item ? new EquippedItem({ item }).calcStats(SIM_ORDER.indexOf(slot)).computeEP(epWeights) : 0;
		cache.set(key, ep);
		return ep;
	};
}
