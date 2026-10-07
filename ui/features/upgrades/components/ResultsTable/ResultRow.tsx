import type { ItemQuality } from '@generated/proto/common';
import clsx from 'clsx';
import { memo } from 'react';

import type { RankedItem } from '../../model/engine/rank';
import type { DpsSortKey } from '../../model/results_sort';
import type { SetBonusTipContext } from '../../model/set_bonus_tip';
import type { RowTag } from '../../model/settings_pool';
import { rowSourceLabel, slotLabel } from '../../utils/format';
import { BatchToggle, FavoriteToggle } from '../RowToggles';
import { DeltaCell } from './DeltaCell';
import { ItemNameCell } from './ItemNameCell';

/**
 * What every table and row of one results area shares. Built once per area and
 * kept stable, so a memoised row renders again only when its own row changes.
 */
export type RowContext = {
	/** The sim database's name and quality for an item, or undefined when it has none. */
	itemOf: (itemId: number) => { name: string; quality: ItemQuality } | undefined;
	/** What the set-bonus hint and the %-rule note are measured against; it has no ranking while a run is in flight. */
	tip: SetBonusTipContext;
	/** The names of the selected sets that hold an item (ticket 430); one array per item, so the name cell's memo holds. */
	tagsOf: (itemId: number) => readonly RowTag[];
	/** What the ΔDPS column sorts on; undefined is the bare ΔDPS. */
	dpsKey?: DpsSortKey;
};

export interface ResultRowProps {
	row: RankedItem;
	/** The row's place in its own table, which is what the Rank column shows (owner ruling, ticket 287). */
	position: number;
	context: RowContext;
}

/**
 * One ranked item. The cell order is read by position by the desktop gate (`tools/run-tab-cdp.mjs`).
 *
 * `memo`, because a run lands rows one at a time and each landing renders the table: without it every
 * row already shown renders again, which a 467-row replay measured at over 20 s. A landing row or a sort
 * still moves `position` for the rows below it, so the two costly cells are memoised on their own and
 * only the Rank cell changes.
 */
export const ResultRow = memo(({ row, position, context }: ResultRowProps) => (
	<tr
		className={clsx('border-b border-b-border', row.owned && 'text-muted')}
		data-testid="upgrades-result-row"
		data-item-id={row.itemId}
		data-owned={row.owned ? 'true' : undefined}>
		<td className="py-1 pr-3 tabular-nums">{position}</td>
		<ItemNameCell row={row} quality={context.itemOf(row.itemId)?.quality} tags={context.tagsOf(row.itemId)} />
		<td className="py-1 pr-3">{slotLabel(row)}</td>
		<DeltaCell row={row} context={context} />
		<td className="py-1 pr-3">{rowSourceLabel(row)}</td>
		<td className="py-1">
			<FavoriteToggle itemId={row.itemId} />
		</td>
		<td className="py-1">
			<BatchToggle itemId={row.itemId} />
		</td>
	</tr>
));
