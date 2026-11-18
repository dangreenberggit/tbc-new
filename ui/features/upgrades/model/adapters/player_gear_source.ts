/**
 * GearSource over the page's current gear and talents. The page has exactly one
 * "fight", the character as configured, so `findFights` returns one synthetic
 * FightSummary and `readGear` ignores the FightRef it is handed back.
 *
 * - `talentPointsByTree` comes from `player.getTalentTreePoints()`
 *   (`ui/sim/proto/utils.ts`), which sums the page's talents string per tree.
 * - `items[].id/enchant/gems` use the accessors `EquippedItem.asSpec()` uses
 *   (`ui/sim/proto/equipped_item.ts`), so they read the gear as the sim does.
 * - `items[].slot`: `Gear.getEquippedItems()` is `Object.values` over a record keyed
 *   by `ItemSlot`. JS iterates integer keys in ascending order, and `ItemSlot`
 *   (`proto/common.proto`) runs 0 (Head) .. 16 (Ranged) in `SIM_ORDER`'s order, so
 *   index `i` is `SIM_ORDER[i]`.
 * - `className`/`specIdHint` stay undefined: nothing in the tab reads them.
 */

import type { Spec } from '@generated/proto/common';
import type { IndividualSimHost } from '@sim/sim_host';

import type { FightSummary, GearSource, LoggedGear, LoggedItem } from '../engine/seams/gear-source';
import { SIM_ORDER } from '../engine/slots';
import type { CharacterRef, FightRef, SpecId } from '../engine/types';

/** The one synthetic fight this surface ever has: "current gear on this page". */
export const CURRENT_PAGE_FIGHT: FightRef = {
	reportCode: 'current-page',
	fightId: 0,
};

const CURRENT_PAGE_FIGHT_SUMMARY: FightSummary = {
	reportCode: CURRENT_PAGE_FIGHT.reportCode,
	fightId: CURRENT_PAGE_FIGHT.fightId,
	encounterName: 'Current page settings',
	route: 'report-events',
	confidence: 1,
};

/** The item id in each `SIM_ORDER` slot of the page's gear, 0 for an empty slot. */
export function equippedItemIds(player: IndividualSimHost<Spec>['player']): number[] {
	const equipped = player.getGear().getEquippedItems();
	return SIM_ORDER.map((_, i) => equipped[i]?.id ?? 0);
}

export class PlayerGearSource implements GearSource {
	/**
	 * The ids the last `readGear` gave the engine. The ranking holds no gear, so
	 * the tab keeps these to work out a row's own set breaks.
	 */
	lastItemIds: readonly number[] | undefined;

	constructor(private readonly simUI: IndividualSimHost<Spec>) {}

	async findFights(_character: CharacterRef, _spec: SpecId): Promise<FightSummary[]> {
		return [CURRENT_PAGE_FIGHT_SUMMARY];
	}

	async readGear(_fight: FightRef): Promise<LoggedGear> {
		const player = this.simUI.player;
		const equipped = player.getGear().getEquippedItems();
		const ids = equippedItemIds(player);
		this.lastItemIds = ids;

		const items: LoggedItem[] = SIM_ORDER.map((slot, i) => {
			const eq = equipped[i];
			if (!eq) return { id: 0, slot };
			const item: LoggedItem = { id: ids[i]!, slot };
			const enchant = eq.enchant;
			if (enchant) item.enchant = enchant.effectId;
			const gemIds = eq.gems.filter((g): g is NonNullable<typeof g> => g != null).map(g => g.id);
			if (gemIds.length > 0) item.gems = gemIds;
			return item;
		});

		return {
			items,
			talentPointsByTree: talentPointsByTree(player.getTalentTreePoints()),
			provenance: {
				reportCode: CURRENT_PAGE_FIGHT.reportCode,
				fightId: CURRENT_PAGE_FIGHT.fightId,
				sourceID: 0,
			},
		};
	}
}

/**
 * `getTalentTreePoints()` returns one entry per `-`-separated part of the talents
 * string. TBC specs have 3 trees, so any other length means the talents string is
 * malformed, and that is reported rather than defaulted.
 */
function talentPointsByTree(points: number[]): [number, number, number] {
	if (points.length !== 3) {
		throw new Error(`expected 3 talent trees, got ${points.length} from the page's talents string`);
	}
	return [points[0]!, points[1]!, points[2]!];
}
