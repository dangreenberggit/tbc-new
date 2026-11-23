/**
 * Orders candidates by EP gain over the worn item before any sim, from raw item data with
 * no gem changes, so it cannot fail on a candidate the sim would reject. The order only
 * changes when a row fills and what a candidate cap keeps, never a number shown.
 */
import { HandType } from '@generated/proto/common';

import { getItem } from './items';
import { type PoolEntry, type SimSlotName, simSlotsForPoolSlot } from './pool';
import { SIM_ORDER, type SimItemSpec } from './slots';
import type { SpecId } from './types';

/**
 * An item's EP in one sim slot, 0 for an unknown item. The slot matters for weapons, whose
 * DPS is priced at that slot's weight (`EquippedItem.calcStats(slot)`). Only a worn item
 * passes `randomSuffix`: a pool entry has none.
 */
export type ItemEp = (itemId: number, slot: SimSlotName, randomSuffix?: number) => number;

const OFFHAND_INDEX = SIM_ORDER.indexOf('offhand');

/**
 * The best EP gain over every sim slot the candidate can go in, as the candidate loop
 * tries both ring, trinket or hand slots and keeps the best. A two-hander in the main
 * hand is also charged the worn off hand, which its sim clears. No usable slot gives 0,
 * not a throw: this runs before any sim, so no result could explain a skip.
 */
function bestEpDelta(entry: PoolEntry, equipment: readonly SimItemSpec[], itemEp: ItemEp, spec?: SpecId): number {
	const wornEp = (slotName: SimSlotName, slotIndex: number): number => {
		const worn = equipment[slotIndex];
		return worn?.id === undefined ? 0 : itemEp(worn.id, slotName, worn.randomSuffix);
	};
	const twoHander = getItem(entry.itemId)?.handType === HandType.HandTypeTwoHand;
	let best: number | undefined;
	for (const slotName of simSlotsForPoolSlot(entry.slot, spec, entry.itemId)) {
		const slotIndex = SIM_ORDER.indexOf(slotName);
		if (slotIndex < 0) continue;
		let delta = itemEp(entry.itemId, slotName) - wornEp(slotName, slotIndex);
		if (twoHander && slotName === 'mainhand') {
			delta -= wornEp('offhand', OFFHAND_INDEX);
		}
		if (best === undefined || delta > best) best = delta;
	}
	return best ?? 0;
}

/**
 * Sorts by `bestEpDelta` descending, then item id ascending: a total order, so two runs
 * over the same input agree. Does not mutate `candidates`.
 */
export function orderCandidatesByEp(candidates: readonly PoolEntry[], equipment: readonly SimItemSpec[], itemEp: ItemEp, spec?: SpecId): PoolEntry[] {
	const delta = new Map(candidates.map(c => [c, bestEpDelta(c, equipment, itemEp, spec)]));
	return [...candidates].sort((a, b) => {
		const deltaA = delta.get(a) ?? 0;
		const deltaB = delta.get(b) ?? 0;
		if (deltaA !== deltaB) return deltaB - deltaA;
		return a.itemId - b.itemId;
	});
}
