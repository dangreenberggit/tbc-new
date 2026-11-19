import type { UIItem } from '@generated/proto/ui';
import type { Sim } from '@sim/sim';
import clsx from 'clsx';
import { memo, type Ref } from 'react';

import type { RankedItem } from '../../model/engine/rank';
import { ilvlOf } from '../../model/pool_source';
import type { DpsSortKey } from '../../model/results_columns';
import type { RankingContext } from '../../model/set_bonus_popover';
import type { RowBadge } from '../../model/settings_pool';
import { slotLabel } from '../../utils/format';
import { BatchToggle, FavoriteToggle } from '../RowToggles';
import { DeltaCell } from './DeltaCell';
import { ItemNameCell } from './ItemNameCell';
import { SourceCell } from './SourceCell';

/**
 * What every table and row of one results area shares. Built once per area and
 * kept stable, so a memoised row renders again only when its own row changes.
 */
export type RowContext = {
	itemOf: (itemId: number) => UIItem | undefined;
	/** The page's sim, whose database the Source cell's links read. */
	sim: Sim;
	/** What the set-bonus popover and the below-cutoff rounding read; it has no ranking while a run is in flight. */
	rankingContext: RankingContext;
	/** The badges of the selected gear sets that hold an item; one array per item, so the name cell's memo holds. */
	gearSetBadgesOf: (itemId: number) => readonly RowBadge[];
	/** The headings the "BiS" badge names on a row in no selected gear set (`bisHeadingIndex`). */
	bisHeadingsOf: (itemId: number) => readonly string[];
	/** What the ΔDPS column sorts on; undefined is the bare ΔDPS. */
	dpsKey?: DpsSortKey;
	/** The offered sources "Filter by source" hides from a settled table, which the Source cell must not name; undefined hides none. */
	hiddenSources?: readonly string[];
};

export interface ResultRowProps {
	row: RankedItem;
	/** The row's place in its own table, shown in the Rank column. */
	position: number;
	context: RowContext;
	/** A BiS-list row the main table shows although it misses the cutoff. */
	notUpgrade?: boolean;
	ref?: Ref<HTMLTableRowElement>;
}

/**
 * One ranked item. DPS comes before Slot so a phone shows the figure without scrolling sideways.
 * Memoised because each row a run finishes renders the table again. A new row or a sort still moves
 * `position` for the rows below it, so the costly cells are memoised on their own and only the Rank
 * cell changes. The virtualiser reads `data-index` when it measures the row.
 */
export const ResultRow = memo(({ row, position, context, notUpgrade = false, ref }: ResultRowProps) => {
	const item = context.itemOf(row.itemId);
	return (
		<tr
			ref={ref}
			className={clsx('border-b border-b-border', row.owned && 'text-muted')}
			data-testid="upgrades-result-row"
			data-index={position - 1}
			data-item-id={row.itemId}
			data-worn={row.owned ? 'true' : undefined}
			data-not-upgrade={notUpgrade ? 'true' : undefined}>
			<td className="py-1 pr-3 tabular-nums">{position}</td>
			<ItemNameCell
				row={row}
				quality={item?.quality}
				gearSetBadges={context.gearSetBadgesOf(row.itemId)}
				bisHeadings={context.bisHeadingsOf(row.itemId)}
				notUpgrade={notUpgrade}
				ilvl={item && ilvlOf(item)}
			/>
			<DeltaCell row={row} context={context} />
			<td className="py-1 pr-3">{slotLabel(row)}</td>
			<SourceCell row={row} item={item} sim={context.sim} hiddenSources={context.hiddenSources} />
			<td className="py-1">
				<FavoriteToggle itemId={row.itemId} />
			</td>
			<td className="py-1">
				<BatchToggle itemId={row.itemId} />
			</td>
		</tr>
	);
});
