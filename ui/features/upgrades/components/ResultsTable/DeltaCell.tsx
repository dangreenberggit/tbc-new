import i18n from '@i18n/config';

import { cutoffAdmittingArm } from '../../model/engine/cutoff';
import type { RankedItem } from '../../model/engine/rank';
import { setBonusTipLines } from '../../model/set_bonus_tip';
import { formatDelta, formatDps } from '../../utils/format';
import { setBonusSubLineText } from '../../utils/set_bonus_labels';
import type { RowContext } from './ResultRow';

export interface DeltaCellProps {
	row: RankedItem;
	context: RowContext;
}

/**
 * The DPS change, with at most three short notes under it: that the row has
 * set-bonus detail, which worn item a two-item swap removes, and that only the
 * percentage rule admitted the row (ticket 254). K3 makes the figure the
 * set-bonus popover's trigger.
 */
export const DeltaCell = ({ row, context }: DeltaCellProps) => {
	const tip = setBonusTipLines(row, context.tip);
	const cutoff = context.tip.ranking?.cutoff;
	const pctOnly = cutoff !== undefined && cutoffAdmittingArm(row.deltaDps, row.deltaPct, cutoff) === 'pct';

	return (
		<td className="py-1 pr-3 text-right whitespace-nowrap tabular-nums">
			<span className="grid justify-items-end">
				{formatDelta(row.deltaDps)}
				{tip && (
					<small className="text-muted" data-testid="upgrades-set-bonus">
						{setBonusSubLineText(tip.subLine)}
					</small>
				)}
				{row.removedItems?.map(removed => (
					<small key={`${removed.itemId}:${removed.slot}`} className="text-muted" data-testid="upgrades-removed-items">
						{i18n.t('upgrades_tab.results.removes_worn', {
							name: context.itemOf(removed.itemId)?.name ?? String(removed.itemId),
							slot: removed.slot,
						})}
					</small>
				))}
				{pctOnly && (
					<small
						className="text-muted"
						data-testid="upgrades-cutoff-arm"
						title={i18n.t('upgrades_tab.cutoff.pct_arm_title', { pct: String(cutoff.pct), abs: formatDps(cutoff.absDps) })}>
						{i18n.t('upgrades_tab.cutoff.pct_arm')}
					</small>
				)}
			</span>
		</td>
	);
};
