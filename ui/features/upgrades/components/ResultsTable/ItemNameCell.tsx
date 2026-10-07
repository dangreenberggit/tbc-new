import type { ItemQuality } from '@generated/proto/common';
import i18n from '@i18n/config';
import { ActionId } from '@sim/proto/action_id';
import { externalRel } from '@sim/utils/links';
import { useActionId } from '@ui-kit/hooks/useActionId';
import { itemQualityClassName } from '@ui-kit/utils/css';
import { WowheadIcon } from '@ui-kit/WowheadIcon';
import { memo } from 'react';

import type { RankedItem } from '../../model/engine/rank';
import type { RowTag } from '../../model/settings_pool';

export interface ItemNameCellProps {
	row: Pick<RankedItem, 'itemId' | 'name' | 'bisTags' | 'owned'>;
	quality: ItemQuality | undefined;
	/** The selected sets that hold the item (ticket 430). */
	tags: readonly RowTag[];
}

/** A row in no selected set shows the universe's own BiS or Alt tag instead. */
const listBadge = (bisTags: RankedItem['bisTags']): RowTag[] => {
	if (bisTags.includes('BiS')) return [{ key: 'BiS', label: i18n.t('upgrades_tab.results.bis_badge') }];
	if (bisTags.includes('Alt')) return [{ key: 'Alt', label: i18n.t('upgrades_tab.results.alt_badge') }];
	return [];
};

/** The item: its icon, its name as a wowhead link in its quality colour, and its tags beneath. `memo`: see `ResultRow`. */
export const ItemNameCell = memo(({ row, quality, tags }: ItemNameCellProps) => {
	const { iconUrl, href } = useActionId(ActionId.fromItemId(row.itemId));
	const badges = tags.length > 0 ? tags : listBadge(row.bisTags);

	return (
		<td className="py-1 pr-3">
			<span className="flex items-center gap-2">
				<WowheadIcon as="div" className="size-6 shrink-0" iconUrl={iconUrl} />
				{/* The table's floor fits every name's widest word (`ResultsTable`); `wrap-anywhere` only keeps a longer one inside the fixed cell. */}
				<span className="grid min-w-0 wrap-anywhere">
					<a
						href={href || undefined}
						target="_blank"
						rel={externalRel(href || undefined, undefined)}
						title={row.name}
						data-testid="upgrades-item-name"
						className={itemQualityClassName(quality)}>
						{row.name}
					</a>
					{(badges.length > 0 || row.owned) && (
						<span className="flex flex-wrap items-center gap-1 text-xs">
							{badges.map(badge => (
								<span key={badge.key} className="rounded-full bg-warning px-1.5 text-black" data-testid="upgrades-bis-badge">
									{badge.label}
								</span>
							))}
							{row.owned && <span>({i18n.t('upgrades_tab.results.owned')})</span>}
						</span>
					)}
				</span>
			</span>
		</td>
	);
});
