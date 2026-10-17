import { ItemSource } from '@features/gear/components/SelectorModal/ItemSource';
import type { UIItem } from '@generated/proto/ui';
import type { Sim } from '@sim/sim';
import { memo } from 'react';

import type { RankedItem } from '../../model/engine/rank';
import { rowNamesHiddenSource, rowSourceDetail } from '../../utils/format';
import { itemSourceShows, overrunNpcKey } from '../../utils/item_source';

const withOverrunNpcKeys = (item: UIItem, sim: Sim): UIItem => {
	let changed = false;
	const sources = item.sources.map(entry => {
		if (entry.source.oneofKind !== 'drop') return entry;
		const { drop } = entry.source;
		const name = sim.db.getNpc(drop.npcId)?.name;
		const key = name === undefined ? undefined : overrunNpcKey(name);
		if (key === undefined) return entry;
		changed = true;
		return { ...entry, source: { oneofKind: 'drop' as const, drop: { ...drop, npcId: 0, otherName: key } } };
	});
	return changed ? { ...item, sources } : item;
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
 * 680) reaches `ItemSource` with no npc and the key as `otherName`, which it
 * prints under the zone, so the cell names the boss and not the Lua text.
 */
export const SourceCell = memo(({ row, item, sim, hiddenSources = [] }: SourceCellProps) => {
	const namesHidden = rowNamesHiddenSource(row, hiddenSources);
	return (
		<td className="py-1 pr-3">
			{!namesHidden && item && itemSourceShows(item, sim) ? (
				<ItemSource item={withOverrunNpcKeys(item, sim)} sim={sim} />
			) : (
				<small className="text-muted">{rowSourceDetail(row, hiddenSources)}</small>
			)}
		</td>
	);
});
