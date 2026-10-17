import { ItemSource } from '@features/gear/components/SelectorModal/ItemSource';
import type { UIItem } from '@generated/proto/ui';
import { ActionId } from '@sim/proto/action_id';
import { difficultyNames } from '@sim/proto/names';
import type { Sim } from '@sim/sim';
import { externalRel } from '@sim/utils/links';
import { memo, type ReactNode } from 'react';

import type { RankedItem } from '../../model/engine/rank';
import { rowNamesHiddenSource, rowSourceDetail } from '../../utils/format';
import { itemSourceShows, overrunNpcKey } from '../../utils/item_source';

/**
 * Upstream's drop-with-npc link (`ItemSource`), drawn here with the boss
 * `overrunNpcKey` recovers, when the item's first source is a drop whose npc
 * name overran its AtlasLoot key (ticket 680); else undefined. `ItemSource`
 * prints the npc's database name, which is the Lua text, and upstream files
 * stay unedited, so the cell draws the same link itself: zone and difficulty
 * over the boss, linking the npc (review finding P2 of feat/tab-follow-ups).
 */
const overrunDropSource = (item: UIItem, sim: Sim): ReactNode | undefined => {
	const [first] = item.sources;
	if (first?.source.oneofKind !== 'drop') return undefined;
	const { drop } = first.source;
	const zone = sim.db.getZone(drop.zoneId);
	const npc = sim.db.getNpc(drop.npcId);
	const boss = npc ? overrunNpcKey(npc.name) : undefined;
	if (!zone || !npc || boss === undefined) return undefined;
	const href = ActionId.makeNpcUrl(npc.id);
	const category = drop.category ? ` - ${drop.category}` : '';
	return (
		<a href={href} target="_blank" rel={externalRel(href, undefined)} data-whtticon="false" className="relative z-1">
			<small>
				<span>
					{zone.name} ({difficultyNames.get(drop.difficulty) ?? 'Unknown'})
					<br />
					{boss + category}
				</span>
			</small>
		</a>
	);
};

export interface SourceCellProps {
	row: RankedItem;
	/** The sim database's item; undefined when it has none. */
	item: UIItem | undefined;
	sim: Sim;
	/** The sources "Filter by source" hides; undefined hides none. */
	hiddenSources?: readonly string[];
}

/**
 * Where the item comes from, as the gear picker shows it: upstream's linked
 * source (a drop's zone and boss, a quest, a vendor). When the site has no
 * source to show, the engine's plain label in the same small type. `memo`
 * with the row's other costly cells, so a landing row renders only the Rank
 * cell again.
 *
 * A row kept by "Filter by source" can also come from a hidden source (an
 * item from two raids stays while either is shown). Upstream's block names
 * the item's first source only, which may be the hidden one, so while any
 * of the row's sources is hidden the cell names its first shown source in
 * plain text instead. The plain text names that one source with what the
 * row holds beyond its zone or bucket: a drop's or token's boss, a
 * reputation's standing, a PvP item's currency.
 *
 * A drop whose npc name overran its AtlasLoot key (`overrunNpcKey`, ticket
 * 680) is drawn by `overrunDropSource`, so the cell names the boss and not
 * the Lua text.
 */
export const SourceCell = memo(({ row, item, sim, hiddenSources = [] }: SourceCellProps) => {
	const namesHidden = rowNamesHiddenSource(row, hiddenSources);
	return (
		<td className="py-1 pr-3">
			{!namesHidden && item && itemSourceShows(item, sim) ? (
				(overrunDropSource(item, sim) ?? <ItemSource item={item} sim={sim} />)
			) : (
				<small className="text-muted">{rowSourceDetail(row, hiddenSources)}</small>
			)}
		</td>
	);
});
