import type { UIItem } from '@generated/proto/ui';
import type { Sim } from '@sim/sim';
import clsx from 'clsx';
import { memo, type Ref } from 'react';

import type { RankedItem } from '../../model/engine/rank';
import type { DpsSortKey } from '../../model/results_columns';
import type { SetBonusTipContext } from '../../model/set_bonus_tip';
import type { RowTag } from '../../model/settings_pool';
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
	/** The sim database's item, or undefined when it has none. */
	itemOf: (itemId: number) => UIItem | undefined;
	/** The page's sim, whose database the Source cell's links read. */
	sim: Sim;
	/** What the set-bonus hint and the %-rule note are measured against; it has no ranking while a run is in flight. */
	tip: SetBonusTipContext;
	/** The names of the selected sets that hold an item (ticket 430); one array per item, so the name cell's memo holds. */
	tagsOf: (itemId: number) => readonly RowTag[];
	/** What the ΔDPS column sorts on; undefined is the bare ΔDPS. */
	dpsKey?: DpsSortKey;
	/** The offered sources "Filter by source" hides from a settled table, which the Source cell must not name; undefined hides none. */
	hiddenSources?: readonly string[];
};

export interface ResultRowProps {
	row: RankedItem;
	/** The row's place in its own table, which is what the Rank column shows (owner ruling, ticket 287). */
	position: number;
	context: RowContext;
	/** A BiS-list row the main table shows although it misses the cutoff (ticket 528). */
	notUpgrade?: boolean;
	/** The virtualiser's measuring ref (`useVirtualRows`). */
	ref?: Ref<HTMLTableRowElement>;
}

/**
 * One ranked item. DPS comes before Slot so a phone shows the figure without scrolling sideways (ticket 606). The
 * main repo's gates (`scripts/tab-harness/run-tab-cdp.mjs`, `test-layout.mjs`) find the DPS cell by its test id and
 * the slot cell as the one after it, and read Rank, Item and Source by position.
 *
 * `memo`, because a run lands rows one at a time and each landing renders the table: without it every
 * row already shown renders again, which a 467-row replay measured at over 20 s. A landing row or a sort
 * still moves `position` for the rows below it, so the costly cells are memoised on their own and
 * only the Rank cell changes.
 *
 * `data-index` is the row's index in its table, which the virtualiser reads when it measures the row
 * and the gates read to collect a table's rows across scroll positions.
 */
export const ResultRow = memo(({ row, position, context, notUpgrade = false, ref }: ResultRowProps) => (
	<tr
		ref={ref}
		className={clsx('border-b border-b-border', row.owned && 'text-muted')}
		data-testid="upgrades-result-row"
		data-index={position - 1}
		data-item-id={row.itemId}
		data-owned={row.owned ? 'true' : undefined}
		data-not-upgrade={notUpgrade ? 'true' : undefined}>
		<td className="py-1 pr-3 tabular-nums">{position}</td>
		<ItemNameCell row={row} quality={context.itemOf(row.itemId)?.quality} tags={context.tagsOf(row.itemId)} notUpgrade={notUpgrade} />
		<DeltaCell row={row} context={context} />
		<td className="py-1 pr-3">{slotLabel(row)}</td>
		<SourceCell row={row} item={context.itemOf(row.itemId)} sim={context.sim} hiddenSources={context.hiddenSources} />
		<td className="py-1">
			<FavoriteToggle itemId={row.itemId} />
		</td>
		<td className="py-1">
			<BatchToggle itemId={row.itemId} />
		</td>
	</tr>
));
