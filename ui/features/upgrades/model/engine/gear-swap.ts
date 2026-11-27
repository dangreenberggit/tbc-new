/**
 * A gear after one or more swaps: the candidate in its slot, empty sockets filled, the meta
 * gem repaired, and an off hand cleared for a two-hander. No I/O.
 */

import { HandType } from '@generated/proto/common';

import { fillEmptyCandidateGems, type FillEmptyOpts, type GemContext } from './candidate-gems';
import { gearHitRating } from './caps';
import { enchantAppliesToItem } from './enchants';
import { findMetaGemId, getGem } from './gems';
import { getItem } from './items';
import { type GemRecolor, repairMetaGems, type SocketedItem } from './meta-repair';
import { migrateGemsToItem } from './migrate-gems';
import { SIM_ORDER, type SimItemSpec } from './slots';
import type { DetectedSpecId } from './types';

/**
 * The first half of `candidateSwapWithRepairs`: the gear after the swap and
 * its gem fill, before any meta repair. Exported so a test can read each
 * repair's input.
 */
export function candidateSwapPreRepair(
	equipment: readonly SimItemSpec[],
	slotIndex: number,
	itemId: number,
	gems: GemContext,
	randomSuffix?: number,
): {
	swapped: SimItemSpec[];
	socketed: SocketedItem[];
	removed: readonly { slotIndex: number; itemId: number }[];
} {
	// Cleared before the swap: `swapItemAt` computes `fillOptsForSwap` from the
	// array it is handed, so clearing afterwards would leave a unique gem on the
	// removed off-hand item in `usedUnique`, blocking the candidate's socket.
	const { equipment: cleared, removed } = clearOffHandForTwoHander(equipment, slotIndex, itemId);
	const swapped = swapItemAt(cleared, slotIndex, itemId, gems, randomSuffix);
	const socketed: SocketedItem[] = swapped.map(spec => ({
		itemId: spec.id ?? 0,
		gems: [...spec.gems],
	}));
	return { swapped, socketed, removed };
}

export function candidateSwapWithRepairs(
	equipment: readonly SimItemSpec[],
	slotIndex: number,
	itemId: number,
	gems: GemContext,
	randomSuffix?: number,
): {
	equipment: SimItemSpec[];
	recolors: readonly GemRecolor[];
	repaired: boolean;
	removed: readonly { slotIndex: number; itemId: number }[];
} {
	const { swapped, socketed, removed } = candidateSwapPreRepair(equipment, slotIndex, itemId, gems, randomSuffix);
	const hitBudget = gems.repairHitBudget;
	const minimized = repairMetaGems({
		items: socketed,
		epWeights: gems.weights,
		allowedGems: gems.fillGems,
		...(hitBudget
			? {
					hitBudget: {
						stat: hitBudget.stat,
						remaining: hitBudget.baselineRemaining - (gearHitRating(swapped, hitBudget.stat) - hitBudget.baselineGearHit),
						...(hitBudget.groups ? { groups: hitBudget.groups } : {}),
					},
				}
			: {}),
	});
	return {
		equipment: applyRepairedGems(swapped, minimized.items),
		recolors: minimized.recolors.filter(s => s.itemIndex !== slotIndex),
		// The swapped slot included, which `swaps` filters out.
		repaired: minimized.recolors.length > 0,
		removed,
	};
}

/**
 * The gear from one fixed series of `candidateSwapWithRepairs` calls, as
 * built: the set phase's added-pieces, partner and pair gears. `repaired` is
 * whether any call changed a socket; `swaps` is every call's repair swaps in
 * call order.
 */
export type ChainBuild = {
	equipment: SimItemSpec[];
	repaired: boolean;
	recolors: GemRecolor[];
};

export function chainSwapsWithRepairs(
	equipment: readonly SimItemSpec[],
	pieces: readonly { slotIndex: number; itemId: number }[],
	gems: GemContext,
): ChainBuild {
	let gear: SimItemSpec[] = [...equipment];
	let repaired = false;
	const recolors: GemRecolor[] = [];
	for (const piece of pieces) {
		const outcome = candidateSwapWithRepairs(gear, piece.slotIndex, piece.itemId, gems);
		gear = outcome.equipment;
		repaired ||= outcome.repaired;
		recolors.push(...outcome.recolors);
	}
	return { equipment: gear, repaired, recolors };
}

/**
 * Takes the worn off-hand item off when a two-handed candidate goes in the
 * main hand, and names what it took. A two-hander beside an off-hand item is
 * gear the game cannot equip, so the row's sim runs without it and the row
 * discloses it in `RankedItem.removedItems`. The reverse case, a one-hander
 * offered beside a worn two-hander, is rejected in `attemptEligibility`,
 * because displacing the two-hander would be a hidden cost; here the build is
 * legal and the cost is stated. Every other case returns the input untouched.
 */
function clearOffHandForTwoHander(
	equipment: readonly SimItemSpec[],
	slotIndex: number,
	itemId: number,
): {
	equipment: readonly SimItemSpec[];
	removed: readonly { slotIndex: number; itemId: number }[];
} {
	if (slotIndex !== SIM_ORDER.indexOf('mainhand')) {
		return { equipment, removed: [] };
	}
	if (getItem(itemId)?.handType !== HandType.HandTypeTwoHand) {
		return { equipment, removed: [] };
	}
	const offHandIndex = SIM_ORDER.indexOf('offhand');
	const wornOffHandId = equipment[offHandIndex]?.id;
	if (!wornOffHandId) return { equipment, removed: [] };

	const cleared = equipment.map((spec, i) =>
		// The bare-slot value `equipmentFromLoggedGear` writes for an empty slot,
		// so a cleared off hand looks like one the player never filled.
		i === offHandIndex ? { gems: [] } : spec,
	);
	return {
		equipment: cleared,
		removed: [{ slotIndex: offHandIndex, itemId: wornOffHandId }],
	};
}

/** `randomSuffix` is the candidate's own; the worn item put back in its own slot keeps the one it is worn with. */
function swapItemAt(equipment: readonly SimItemSpec[], slotIndex: number, itemId: number, gemCtx: GemContext, randomSuffix?: number): SimItemSpec[] {
	return equipment.map((spec, i) => {
		if (i !== slotIndex) return spec;
		const sameItem = spec.id === itemId;
		const gems = sameItem
			? [...(spec.gems ?? [])]
			: fillEmptyCandidateGems(
					itemId,
					migrateGemsToItem(spec.gems ?? [], spec.id ?? 0, itemId),
					gemCtx.fillGems,
					gemCtx.weightRecord,
					fillOptsForSwap(equipment, slotIndex, gemCtx.spec),
				);
		const out: SimItemSpec = { id: itemId, gems };
		const suffix = sameItem ? spec.randomSuffix : randomSuffix;
		if (suffix) out.randomSuffix = suffix;
		if (spec.enchant && enchantAppliesToItem(spec.enchant, itemId)) {
			out.enchant = spec.enchant;
		}
		return out;
	});
}

function fillOptsForSwap(equipment: readonly SimItemSpec[], slotIndex: number, spec: DetectedSpecId | undefined): FillEmptyOpts {
	const usedUnique = new Set<number>();
	const otherGemIds: number[] = [];
	for (let i = 0; i < equipment.length; i++) {
		if (i === slotIndex) continue;
		for (const id of equipment[i]?.gems ?? []) {
			if (!(id > 0)) continue;
			otherGemIds.push(id);
			if (getGem(id)?.unique) usedUnique.add(id);
		}
	}
	const wornGems = (equipment[slotIndex]?.gems ?? []).filter(id => id > 0);
	const metaId = findMetaGemId([...otherGemIds, ...wornGems]);
	return {
		usedUnique,
		...(metaId !== undefined ? { meta: { metaId, otherGemIds } } : {}),
		...(spec !== undefined ? { spec } : {}),
	};
}

export function applyRepairedGems(equipment: readonly SimItemSpec[], socketed: SocketedItem[]): SimItemSpec[] {
	return equipment.map((spec, i) => {
		const repaired = socketed[i];
		if (!repaired || !spec.id) return spec;
		return { ...spec, gems: [...repaired.gems] };
	});
}
