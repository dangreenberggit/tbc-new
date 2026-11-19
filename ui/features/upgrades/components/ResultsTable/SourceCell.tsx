import { ItemSource } from '@features/gear/components/SelectorModal/ItemSource';
import type { UIItem } from '@generated/proto/ui';
import { ActionId } from '@sim/proto/action_id';
import type { Sim } from '@sim/sim';
import { externalRel } from '@sim/utils/links';
import { memo, type ReactNode } from 'react';

import type { RankedItem } from '../../model/engine/rank';
import { keepMarkWithZone, rowNamesHiddenSource, rowSourceDetail, zoneWithMark } from '../../utils/format';
import { itemSourceShows, nameBeforeOverrunKey } from '../../utils/gear_selector_source';

/**
 * The drop-with-npc link `ItemSource` draws, drawn here for an item whose first source is a drop
 * from a known npc; else undefined, and `ItemSource` draws the source. The zone and its difficulty
 * mark are joined by a no-break space, so a narrow cell never puts "(N)" on a line of its own, and
 * an npc name that overran its AtlasLoot key is replaced by the boss `nameBeforeOverrunKey` recovers.
 */
const dropSource = (item: UIItem, sim: Sim): ReactNode | undefined => {
	const [first] = item.sources;
	if (first?.source.oneofKind !== 'drop') return undefined;
	const { drop } = first.source;
	const zone = sim.db.getZone(drop.zoneId);
	const npc = sim.db.getNpc(drop.npcId);
	if (!zone || !npc) return undefined;
	const boss = nameBeforeOverrunKey(npc.name) ?? npc.name;
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
	item: UIItem | undefined;
	sim: Sim;
	/** The sources "Filter by source" hides; undefined hides none. */
	hiddenSources?: readonly string[];
}

/**
 * Where the item comes from, as the gear picker shows it, or the engine's plain label when the site
 * has no source to show. Memoised so a new row elsewhere re-renders only this row's Rank cell. A
 * row "Filter by source" keeps can also come from a hidden source, and `ItemSource` names only the
 * first, so while any of the row's sources is hidden the cell names its first shown one in plain text.
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
