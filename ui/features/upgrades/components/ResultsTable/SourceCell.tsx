import { ItemSource } from '@features/gear/components/SelectorModal/ItemSource';
import type { UIItem } from '@generated/proto/ui';
import { ActionId } from '@sim/proto/action_id';
import type { Sim } from '@sim/sim';
import { externalRel } from '@sim/utils/links';
import { memo, type ReactNode } from 'react';

import type { RankedItem } from '../../model/engine/rank';
import { keepMarkWithZone, rowNamesHiddenSource, rowSourceDetail, zoneWithMark } from '../../utils/format';
import { itemSourceShows, overrunNpcKey } from '../../utils/item_source';

/**
 * Upstream's drop-with-npc link (`ItemSource`), drawn here when the item's
 * first source is a drop from a known npc; else undefined, and upstream's
 * block draws the source. Upstream files stay unedited, so the cell draws
 * the same link itself, zone and difficulty over the boss, linking the npc,
 * for two reasons. The zone and its mark are joined by a no-break space, so
 * a narrow cell never puts "(N)" on a line of its own (ticket 607). And when
 * the npc name overran its AtlasLoot key, the boss is the one
 * `overrunNpcKey` recovers, where `ItemSource` prints the Lua text (ticket
 * 680; review finding P2 of feat/tab-follow-ups).
 */
const dropSource = (item: UIItem, sim: Sim): ReactNode | undefined => {
	const [first] = item.sources;
	if (first?.source.oneofKind !== 'drop') return undefined;
	const { drop } = first.source;
	const zone = sim.db.getZone(drop.zoneId);
	const npc = sim.db.getNpc(drop.npcId);
	if (!zone || !npc) return undefined;
	const boss = overrunNpcKey(npc.name) ?? npc.name;
	const href = ActionId.makeNpcUrl(npc.id);
	const category = drop.category ? ` - ${drop.category}` : '';
	return (
		<a href={href} target="_blank" rel={externalRel(href, undefined)} data-whtticon="false" className="relative z-1">
			<small>
				<span>
					{zoneWithMark(zone.name, drop.difficulty)}
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
 * A drop from a known npc is drawn by `dropSource`, and the plain text goes
 * through `keepMarkWithZone`, so neither leaves a difficulty mark alone on a
 * line.
 */
export const SourceCell = memo(({ row, item, sim, hiddenSources = [] }: SourceCellProps) => {
	const namesHidden = rowNamesHiddenSource(row, hiddenSources);
	return (
		<td className="py-1 pr-3">
			{!namesHidden && item && itemSourceShows(item, sim) ? (
				(dropSource(item, sim) ?? <ItemSource item={item} sim={sim} />)
			) : (
				<small className="text-muted">{keepMarkWithZone(rowSourceDetail(row, hiddenSources))}</small>
			)}
		</td>
	);
});
