/**
 * PlayerGearSource — GearSource over the page's own current gear/talents
 * (plan §2.2), not a WCL log. `findFights` has nothing to look up: there is
 * exactly one "fight" on this surface — the character as currently configured
 * on the page — so it returns one synthetic FightSummary and `readGear`
 * ignores the FightRef it is handed back (the ref exists only to satisfy the
 * seam's two methods, which packages/core needs for its WCL transport).
 *
 * Field-by-field verification against `Player` state (plan §2.2's "open
 * verification item"):
 *  - `talentPointsByTree`: `player.getTalentTreePoints()`
 *    (`ui/core/proto_utils/utils.ts`'s `getTalentTreePoints`, summing digits
 *    of the page's own talents string per tree) returns exactly the
 *    `[number, number, number]` type this field needs, sourced from the
 *    page's live talents — not a stand-in. This resolves the plan's
 *    "untested" flag; it was answered, not worked around.
 *  - `items[].id/enchant/gems`: `EquippedItem.id` / `.enchant?.effectId` /
 *    `.gems` (`ui/core/proto_utils/equipped_item.ts`) are the same accessors
 *    `EquippedItem.asSpec()` uses to build the protojson `ItemSpec` the sim
 *    itself consumes, so there is no second, independently-drifting reading
 *    of the same state.
 *  - `items[].slot`: `Gear.getEquippedItems()` returns `Object.values(this.gear)`
 *    over a `Partial<Record<ItemSlot, EquippedItem>>`; JS iterates
 *    integer-keyed properties in ascending numeric order regardless of
 *    insertion order (a language guarantee, not an implementation detail),
 *    and the fork's own `ItemSlot` enum (`proto/common.ts`) is declared
 *    0 (Head) .. 16 (Ranged) in exactly `SIM_ORDER`'s order — verified by
 *    reading both enumerations side by side, not assumed. So index `i` in
 *    the returned array *is* `SIM_ORDER[i]`.
 *  - `className`/`specIdHint`: left undefined. `rank.ts`'s doc comment
 *    already states these are unread on this port (no spec-mismatch check —
 *    `spec.ts` is not ported, plan §2.1), so there is nothing for them to
 *    disclose.
 */

import type { IndividualSimUI } from '../../../../individual_sim_ui.js';
import type { FightSummary, GearSource, LoggedGear, LoggedItem } from '../engine/seams/gear-source.js';
import { SIM_ORDER } from '../engine/slots.js';
import type { CharacterRef, FightRef, SpecId } from '../engine/types.js';

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
export function equippedItemIds(player: IndividualSimUI<any>['player']): number[] {
	const equipped = player.getGear().getEquippedItems();
	return SIM_ORDER.map((_, i) => equipped[i]?.id ?? 0);
}

export class PlayerGearSource implements GearSource {
	/**
	 * The ids the last `readGear` gave the engine. The ranking holds no gear, so
	 * the tab keeps these to work out a row's own set breaks (ticket 536).
	 */
	lastItemIds: readonly number[] | undefined;

	constructor(private readonly simUI: IndividualSimUI<any>) {}

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
 * `getTalentTreePoints()` returns `Array<number>` (its own source sums an
 * arbitrary-length talents-string split on `-`), but `LoggedGear` needs
 * exactly 3. TBC has exactly 3 talent trees per spec; a length other than 3
 * means the page's talents string itself is malformed, which is a real
 * problem to report rather than paper over with a default.
 */
function talentPointsByTree(points: number[]): [number, number, number] {
	if (points.length !== 3) {
		throw new Error(`expected 3 talent trees, got ${points.length} from the page's talents string`);
	}
	return [points[0]!, points[1]!, points[2]!];
}
