import type { ItemQuality } from '@generated/proto/common';
import i18n from '@i18n/config';
import { ActionId } from '@sim/proto/action_id';
import { externalRel } from '@sim/utils/links';
import { useActionId } from '@ui-kit/hooks/useActionId';
import { itemQualityClassName } from '@ui-kit/utils/css';
import { WowheadIcon } from '@ui-kit/WowheadIcon';
import { memo } from 'react';

import type { RankedItem } from '../../model/engine/rank';
import { type RowBadge, withHeading } from '../../model/settings_pool';

export interface ItemNameCellProps {
	row: Pick<RankedItem, 'itemId' | 'name' | 'bisTags' | 'owned'>;
	quality: ItemQuality | undefined;
	/** The selected gear sets that hold the item. */
	gearSetBadges: readonly RowBadge[];
	/** The headings of the BiS gear sets that hold the item, named on its "BiS" badge when no selected gear set holds it. */
	bisHeadings: readonly string[];
	/** Shown in the main table although it misses the cutoff: said in text beside the badges, so no hover is needed. */
	notUpgrade?: boolean;
	/** The item's level, or undefined (or 0) when the site's database gives none, which shows no level. */
	ilvl?: number;
}

/**
 * For a row in no selected gear set: one per heading of the BiS gear sets that hold it, so warrior's page reads "BiS (Fury)"
 * or "BiS (Arms)".
 */
const poolBisBadges = (bisTags: RankedItem['bisTags'], headings: readonly string[]): RowBadge[] => {
	if (!bisTags.includes('BiS')) return [];
	const label = i18n.t('upgrades_tab.results.bis_badge', { ns: 'upgrades' });
	return headings.length > 0 ? headings.map(heading => ({ key: `BiS:${heading}`, label: withHeading(label, heading) })) : [{ key: 'BiS', label }];
};

/** The item: its icon, its name as a wowhead link in its quality color, and its badges beneath. Memoised: see `ResultRow`. */
export const ItemNameCell = memo(({ row, quality, gearSetBadges, bisHeadings, notUpgrade = false, ilvl }: ItemNameCellProps) => {
	const { iconUrl, href } = useActionId(ActionId.fromItemId(row.itemId));
	const badges = gearSetBadges.length > 0 ? gearSetBadges : poolBisBadges(row.bisTags, bisHeadings);

	return (
		<td className="py-1 pr-3">
			<span className="flex items-center gap-2">
				<WowheadIcon as="div" className="size-6 shrink-0" iconUrl={iconUrl} />
				{/* The table's floor fits every name's widest word (`ResultsTable`); `wrap-anywhere` only keeps a longer one inside the fixed cell.
				    The row gap keeps the badges off the name at phone width. */}
				<span className="grid min-w-0 gap-y-1 wrap-anywhere">
					<a
						href={href || undefined}
						target="_blank"
						rel={externalRel(href || undefined, undefined)}
						title={row.name}
						data-testid="upgrades-item-name"
						className={itemQualityClassName(quality)}>
						{row.name}
					</a>
					{/* The steps of one reputation-ring chain share a name; the item level tells them apart. */}
					{(!!ilvl || badges.length > 0 || row.owned || notUpgrade) && (
						<span className="flex flex-wrap items-center gap-1 text-xs">
							{!!ilvl && <span data-testid="upgrades-item-ilvl">{i18n.t('upgrades_tab.results.item_level', { ns: 'upgrades', ilvl })}</span>}
							{badges.map(badge => (
								<span key={badge.key} className="rounded-full bg-warning px-1.5 text-black" data-testid="upgrades-row-badge">
									{badge.label}
								</span>
							))}
							{row.owned && <span>({i18n.t('upgrades_tab.results.owned', { ns: 'upgrades' })})</span>}
							{notUpgrade && <span data-testid="upgrades-not-upgrade">({i18n.t('upgrades_tab.results.not_upgrade', { ns: 'upgrades' })})</span>}
						</span>
					)}
				</span>
			</span>
		</td>
	);
});
