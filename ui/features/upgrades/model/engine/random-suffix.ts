/**
 * The random suffix a candidate is priced with. A suffix item ("Ravager's Bracers")
 * has only armor until it rolls a suffix ("of the Tiger"), so a bare copy is an item
 * nobody wears.
 */

import { Database } from '@sim/proto/database';

import type { PoolEntry } from './pool';
import type { SimItemSpec } from './slots';
import { epScore, type EpWeights } from './stats';

/**
 * Each pool entry with a suffix to price: the one the player wears on that item, or
 * else the option with the highest EP, the gear picker's rule for ranking a suffix
 * item (`computeItemEP`, ui/sim/player/player.ts). An entry with no suffix options,
 * or a worn copy with no suffix, comes back as the same object.
 */
export function withCandidateSuffixes(entries: readonly PoolEntry[], equipment: readonly SimItemSpec[], epWeights: EpWeights): PoolEntry[] {
	return entries.map(entry => {
		const options = Database.getSync().getItemById(entry.itemId)?.randomSuffixOptions ?? [];
		if (options.length === 0) return entry;
		const worn = equipment.find(spec => spec.id === entry.itemId);
		const suffixId = worn ? worn.randomSuffix : bestSuffix(options, epWeights);
		const suffix = suffixId ? Database.getSync().getRandomSuffixById(suffixId) : undefined;
		if (!suffix) return entry;
		// wowsims' name for a suffixed item: the item's name, then the suffix's (`ItemDetailCell`).
		return { ...entry, randomSuffix: suffix.id, name: `${entry.name} ${suffix.name}` };
	});
}

/**
 * The option with the highest EP; the first one on a tie. The picker scales every
 * option by the item's random property points, which leaves the order alone. None
 * when no option is worth more than 0 EP: the picker lists none of those
 * (`getRandomSuffixes`, ui/sim/player/player.ts).
 */
function bestSuffix(options: readonly number[], epWeights: EpWeights): number | undefined {
	let best: number | undefined;
	let bestEp = 0;
	for (const id of options) {
		const suffix = Database.getSync().getRandomSuffixById(id);
		if (!suffix) continue;
		const ep = epScore(suffix.stats, epWeights);
		if (ep > bestEp) {
			best = id;
			bestEp = ep;
		}
	}
	return best;
}
