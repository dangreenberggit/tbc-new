/**
 * GearSource over the page's current gear and talents. `Gear.getEquippedItems()`
 * is `Object.values` over integer `ItemSlot` keys, which iterate in `SIM_ORDER`'s
 * order, so index `i` is `SIM_ORDER[i]`.
 */

import type { Spec } from '@generated/proto/common';
import type { IndividualSimHost } from '@sim/sim_host';

import type { FightSummary, GearSource, LoggedGear, LoggedItem } from '../engine/seams/gear-source';
import { SIM_ORDER } from '../engine/slots';
import type { CharacterRef, FightRef, SpecId } from '../engine/types';

/** The page has no logged fights, only its current gear, so this one stands for it. */
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

export function equippedItemIds(player: IndividualSimHost<Spec>['player']): number[] {
	const equipped = player.getGear().getEquippedItems();
	return SIM_ORDER.map((_, i) => equipped[i]?.id ?? 0);
}

export class PlayerGearSource implements GearSource {
	/**
	 * The ids the last `readGear` gave the engine. The ranking holds no gear, so the
	 * tab keeps these to work out which set bonuses a row's swap breaks.
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
			if (eq.randomSuffix) item.randomSuffix = eq.randomSuffix.id;
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
 * string; TBC specs have 3 trees, so another length is reported as malformed.
 */
function talentPointsByTree(points: number[]): [number, number, number] {
	if (points.length !== 3) {
		throw new Error(`expected 3 talent trees, got ${points.length} from the page's talents string`);
	}
	return [points[0]!, points[1]!, points[2]!];
}
