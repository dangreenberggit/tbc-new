/** Gear hit rating for the gem-repair hit budget. */
import { enchantStats } from './enchants';
import { getItem } from './items';
import { layoutHitRating } from './meta-repair';
import type { SimItemSpec } from './slots';
import { type Stat, statAt } from './stats';

/**
 * The hit `stat` from item stats, enchants, gems and active socket bonuses. Set bonuses
 * live in Go code, in no database row, so the set phase reads them from the sim. Enchants
 * count because a swap can drop one that does not fit the new item.
 */
export function gearHitRating(equipment: readonly SimItemSpec[], stat: Stat): number {
	let hit = 0;
	for (const spec of equipment) {
		if (!spec.id) continue;
		hit += statAt(getItem(spec.id)?.stats ?? [], stat);
		if (spec.enchant) hit += statAt(enchantStats(spec.enchant), stat);
	}
	return (
		hit +
		layoutHitRating(
			equipment.map(spec => ({ itemId: spec.id ?? 0, gems: [...(spec.gems ?? [])] })),
			stat,
		)
	);
}
