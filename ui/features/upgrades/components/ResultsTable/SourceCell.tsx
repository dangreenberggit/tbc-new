import { ItemSource } from '@features/gear/components/SelectorModal/ItemSource';
import type { UIItem } from '@generated/proto/ui';
import type { Sim } from '@sim/sim';
import { memo } from 'react';

import type { RankedItem } from '../../model/engine/rank';
import { rowNamesHiddenSource, rowShownSourceLabel, rowSourceLabel } from '../../utils/format';
import { itemSourceShows } from '../../utils/item_source';

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
 * plain text instead.
 */
export const SourceCell = memo(({ row, item, sim, hiddenSources = [] }: SourceCellProps) => {
	const namesHidden = rowNamesHiddenSource(row, hiddenSources);
	return (
		<td className="py-1 pr-3">
			{!namesHidden && item && itemSourceShows(item, sim) ? (
				<ItemSource item={item} sim={sim} />
			) : (
				<small className="text-muted">{namesHidden ? rowShownSourceLabel(row, hiddenSources) : rowSourceLabel(row)}</small>
			)}
		</td>
	);
});
