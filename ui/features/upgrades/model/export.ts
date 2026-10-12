/**
 * The results' JSON export for a loot-priority tool such as ThatsMyBis
 * (tickets 126, 314), as the old tab built it (cb561067 `upgrades_tab.tsx`).
 * The caller passes the rows that meet the cutoff (`view.shortlist`) in the
 * sort on screen, so the payload carries the cross-slot ranked order. The
 * BiS-list rows that miss the cutoff, which the Upgrades pane's main table
 * also shows (ticket 528), are not upgrades, so they stay out of the export.
 */

import type { RankedItem } from './engine/rank';

/** `token`: the tier token that drops for a tier piece; `gear`: the gear item id for every row. */
export type ExportFlavour = 'token' | 'gear';

export type ExportPayload = { items: Array<{ id: number }> };

/**
 * Reads every source, not only the primary: a tier row can carry a drop
 * source ahead of its token source. A Sunmote token has no single tradeable
 * id and falls through to the gear id.
 */
export function exportIdForRow(row: Pick<RankedItem, 'itemId' | 'source' | 'sources'>, flavour: ExportFlavour): number {
	if (flavour === 'gear') return row.itemId;
	for (const source of row.sources ?? [row.source]) {
		if (source.kind !== 'token') continue;
		// `ItemSource` has no `tokenId` (`engine/pool.ts`), but the bundled universes carry it on token sources.
		const tokenId = (source as { tokenId?: number }).tokenId;
		if (typeof tokenId === 'number') return tokenId;
	}
	return row.itemId;
}

/**
 * Owned rows are left out: the player has the item. Rows are deduplicated on
 * the id they emit, so two rows that resolve to one token are one line.
 */
export function exportPayload(rows: readonly RankedItem[], flavour: ExportFlavour): ExportPayload {
	const seen = new Set<number>();
	const items: Array<{ id: number }> = [];
	for (const row of rows) {
		if (row.owned === true) continue;
		const id = exportIdForRow(row, flavour);
		if (seen.has(id)) continue;
		seen.add(id);
		items.push({ id });
	}
	return { items };
}
