/**
 * `bonusDpsNet`: a bonus's DPS less the worn bonuses its pieces break. Pure.
 */

import { getItem } from './items';
import type { SetBonusValue } from './rank-types';
import { type BrokenSetBonus, brokenSetBonuses, type CountsAsBreak } from './set-value';
import type { SimItemSpec } from './slots';

/**
 * How many of `bonus`'s added pieces lose the worn bonus `target` by their own
 * swap, for `netInflation`.
 */
export function countMembersBreaking(
	bonus: SetBonusValue,
	target: Pick<BrokenSetBonus, 'setId' | 'threshold'>,
	equipment: readonly SimItemSpec[],
	firstSlotIndexByItemId: ReadonlyMap<number, number>,
	countsAsBreak: CountsAsBreak,
): number {
	let k = 0;
	for (const itemId of bonus.packageItemIds) {
		const slotIndex = firstSlotIndexByItemId.get(itemId);
		if (slotIndex === undefined) continue;
		const memberSetId = getItem(itemId)?.setId;
		if (memberSetId == null) continue;
		const breaks = brokenSetBonuses(equipment, [{ itemId, slotIndex }], memberSetId, countsAsBreak);
		if (breaks.some(brk => brk.setId === target.setId && brk.threshold === target.threshold)) {
			k += 1;
		}
	}
	return k;
}
