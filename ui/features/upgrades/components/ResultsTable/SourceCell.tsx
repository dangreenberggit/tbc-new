import { ItemSource } from '@features/gear/components/SelectorModal/ItemSource';
import { useSim } from '@sim/context/SimHostContext';
import { memo } from 'react';

import type { RankedItem } from '../../model/engine/rank';
import { rowSourceLabel } from '../../utils/format';
import { itemSourceShows } from '../../utils/item_source';

export interface SourceCellProps {
	row: RankedItem;
}

/**
 * Where the item comes from, as the gear picker shows it: upstream's linked
 * source (a drop's zone and boss, a quest, a vendor). When the site has no
 * source to show, the engine's plain label in the same small type. `memo`
 * with the row's other costly cells, so a landing row renders only the Rank
 * cell again.
 */
export const SourceCell = memo(({ row }: SourceCellProps) => {
	const sim = useSim();
	const item = sim.db.getItemById(row.itemId);
	return (
		<td className="py-1 pr-3">
			{item && itemSourceShows(item, sim) ? <ItemSource item={item} sim={sim} /> : <small className="text-muted">{rowSourceLabel(row)}</small>}
		</td>
	);
});
