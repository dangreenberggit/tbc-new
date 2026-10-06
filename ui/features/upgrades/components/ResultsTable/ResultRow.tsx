import { ActionId } from '@sim/proto/action_id';
import { externalRel } from '@sim/utils/links';
import { useActionId } from '@ui-kit/hooks/useActionId';
import { WowheadIcon } from '@ui-kit/WowheadIcon';
import { memo } from 'react';

import type { RankedItem } from '../../model/engine/rank';
import { formatDelta, slotLabel, sourceLabel } from '../../utils/format';

export interface ResultRowProps {
	row: RankedItem;
	/** The row's place in the table, which is what the Rank column shows. */
	position: number;
}

/**
 * One ranked item. The cell order is read by position by the desktop gate (`tools/run-tab-cdp.mjs`).
 *
 * `memo`, because a run lands rows one at a time and each landing renders the table: without it every
 * row already shown renders again, which a 467-row replay measured at over 20 s.
 */
export const ResultRow = memo(({ row, position }: ResultRowProps) => {
	const { iconUrl, href } = useActionId(ActionId.fromItemId(row.itemId));

	return (
		<tr className="border-b border-b-border" data-testid="upgrades-result-row" data-item-id={row.itemId}>
			<td className="py-1 pr-3 tabular-nums">{position}</td>
			<td className="py-1 pr-3">
				<span className="flex items-center gap-2">
					<WowheadIcon as="div" className="size-6 shrink-0" iconUrl={iconUrl} />
					<a href={href || undefined} target="_blank" rel={externalRel(href || undefined, undefined)}>
						{row.name}
					</a>
				</span>
			</td>
			<td className="py-1 pr-3 whitespace-nowrap">{slotLabel(row)}</td>
			<td className="py-1 pr-3 text-right whitespace-nowrap tabular-nums">{formatDelta(row.deltaDps)}</td>
			<td className="py-1">{sourceLabel(row.source)}</td>
		</tr>
	);
});
