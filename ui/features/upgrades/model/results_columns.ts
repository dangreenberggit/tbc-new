/**
 * What the results tables sort on: the sortable columns and each one's value for a
 * row. The table is TanStack Table's (`hooks/useResultsTable.ts`), with its one sort
 * in the tab store, so every pane, the below-cutoff group and the export follow the
 * same click. Display only: it never re-runs the view.
 */

import type { RankedItem } from './engine/rank';

/** The text a reader sees in the slot and source cells, which those columns sort on. */
export type SortLabels<T> = { slot: (row: T) => string; source: (row: T) => string };

/** What the ΔDPS column sorts on, when it is more than the row's own ΔDPS (`results_view.ts` `dpsSortKeyFor`). */
export type DpsSortKey = (row: RankedItem) => number;

/** In header order; each id is also the `upgrades-sort-<id>` test id. */
export const SORT_COLUMN_IDS = ['item', 'delta_dps', 'slot', 'source'] as const;

export type ResultsSortKey = (typeof SORT_COLUMN_IDS)[number];

export const sortValue = (key: ResultsSortKey, row: RankedItem, labels: SortLabels<RankedItem>, dpsKey: DpsSortKey | undefined): string | number => {
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
 * Plain `<`, 0 on a tie, as TanStack's `sortFn_basic` compares. The table breaks a
 * tie on row index, so rows a sort cannot tell apart keep the engine's order both
 * ways. Not `sortFn: 'auto'`: it picks `alphanumeric` for a text column with a
 * digit in it, which splits on digits.
 */
export const compareSortValues = (a: string | number, b: string | number): number => {
	if (a === b) return 0;
	return a < b ? -1 : 1;
};
