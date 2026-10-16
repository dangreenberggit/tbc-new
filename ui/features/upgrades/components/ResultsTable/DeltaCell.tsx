import i18n from '@i18n/config';
import { memo } from 'react';

import type { RankedItem } from '../../model/engine/rank';
import { setBonusTipLines } from '../../model/set_bonus_tip';
import { formatDelta, simSlotLabel } from '../../utils/format';
import { setBonusSubLineText } from '../../utils/set_bonus_labels';
import { SetBonusPopover } from '../SetBonusPopover';
import type { RowContext } from './ResultRow';

export interface DeltaCellProps {
	row: RankedItem;
	context: RowContext;
}

/**
 * The DPS change, with at most two short notes under it: that the row has
 * set-bonus detail, and which worn item a two-item swap removes. A figure with set-bonus detail
 * is the trigger of the popover that itemises it. The figure is the one the
 * column sorts on, so with Set potential it is ΔDPS plus the set credit, the
 * popover's total (the old tab's cell, cb561067 `upgrades_tab.tsx:3205-3220`).
 * `memo`: see `ResultRow`.
 */
export const DeltaCell = memo(({ row, context }: DeltaCellProps) => {
	const tip = setBonusTipLines(row, context.tip);
	const figure = formatDelta(context.dpsKey?.(row) ?? row.deltaDps);

	return (
		<td className="py-1 pr-3 text-right whitespace-nowrap tabular-nums" data-testid="upgrades-delta-cell">
			<span className="grid justify-items-end">
				{tip ? <SetBonusPopover tip={tip}>{figure}</SetBonusPopover> : figure}
				{tip && (
					<small className="text-muted" data-testid="upgrades-set-bonus">
						{setBonusSubLineText(tip.subLine)}
					</small>
				)}
				{row.removedItems?.map(removed => (
					<small key={`${removed.itemId}:${removed.slot}`} className="text-right whitespace-normal text-muted" data-testid="upgrades-removed-items">
						{i18n.t('upgrades_tab.results.removes_worn', {
							ns: 'upgrades',
							name: context.itemOf(removed.itemId)?.name ?? String(removed.itemId),
							slot: simSlotLabel(removed.slot),
						})}
					</small>
				))}
			</span>
		</td>
	);
});
