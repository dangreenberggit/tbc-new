/**
 * The column sort of the results tables (ticket 280). One sort is shared by
 * every pane, the below-cutoff group and the export, so the export order is
 * the order on screen. It is a display concern only: it never re-runs the
 * view, and it is not stored.
 */

import type { RankedItem } from './engine/rank';

export type ResultsSortKey = 'item' | 'slot' | 'delta_dps' | 'source';

export type ResultsSort = { key: ResultsSortKey; dir: 'asc' | 'desc' };

/**
 * A new column starts at descending, which on ΔDPS is the order the page
 * opened with; a second click on the same column flips it.
 */
export const nextSort = (current: ResultsSort | undefined, key: ResultsSortKey): ResultsSort =>
	current?.key === key ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' };

/** The text a reader sees in the slot and source cells, which those columns sort on. */
export type SortLabels<T> = { slot: (row: T) => string; source: (row: T) => string };

/** What the ΔDPS column sorts on, when it is more than the row's own ΔDPS (`results_view.ts` `dpsSortKeyFor`). */
export type DpsSortKey = (row: RankedItem) => number;

const sortValue = <T extends RankedItem>(key: ResultsSortKey, row: T, labels: SortLabels<T>, dpsKey: DpsSortKey | undefined): string | number => {
	switch (key) {
		case 'item':
			return row.name.toLowerCase();
		case 'slot':
			return labels.slot(row).toLowerCase();
		case 'delta_dps':
			return dpsKey ? dpsKey(row) : row.deltaDps;
		case 'source':
			return labels.source(row).toLowerCase();
	}
};

/**
 * `rows` in `sort` order. Rows with equal keys keep the engine's order
 * (`Array.prototype.sort` is stable), so a sort that does not tell two rows
 * apart never reshuffles them.
 */
export function sortRows<T extends RankedItem>(rows: readonly T[], sort: ResultsSort | undefined, labels: SortLabels<T>, dpsKey?: DpsSortKey): T[] {
	if (!sort) return [...rows];
	const dir = sort.dir === 'asc' ? 1 : -1;
	return [...rows].sort((a, b) => {
		const ak = sortValue(sort.key, a, labels, dpsKey);
		const bk = sortValue(sort.key, b, labels, dpsKey);
		if (ak === bk) return 0;
		return ak < bk ? -dir : dir;
	});
}
