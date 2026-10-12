/**
 * What the results tables sort on (tickets 280, 565): the sortable columns and
 * each one's value for a row. The table itself is TanStack Table's, built in
 * `hooks/useResultsTable.ts` with its one sort kept in the tab store, so every
 * pane, the below-cutoff group and the export follow the same click. A display
 * concern only: it never re-runs the view.
 */

import type { RankedItem } from './engine/rank';

/** The text a reader sees in the slot and source cells, which those columns sort on. */
export type SortLabels<T> = { slot: (row: T) => string; source: (row: T) => string };

/** What the ΔDPS column sorts on, when it is more than the row's own ΔDPS (`results_view.ts` `dpsSortKeyFor`). */
export type DpsSortKey = (row: RankedItem) => number;

/** The sortable columns in head order; each id is also the `upgrades-sort-<id>` test id the gates click. */
export const SORT_COLUMN_IDS = ['item', 'delta_dps', 'slot', 'source'] as const;

export type ResultsSortKey = (typeof SORT_COLUMN_IDS)[number];

/** A row's value in a sortable column: names, slots and sources sort on their lower-cased text, ΔDPS on `dpsKey` when the view gives one. */
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
 * Plain `<`, 0 on a tie. The table breaks a tie on the row's index, so rows a
 * sort does not tell apart keep the engine's order in both directions.
 * TanStack's `sortFn: 'auto'` is not used because it picks `alphanumeric` for
 * a text column with a digit in it, which splits on digits; the old sort did
 * not. This is the comparison TanStack's `sortFn_basic` makes.
 */
export const compareSortValues = (a: string | number, b: string | number): number => {
	if (a === b) return 0;
	return a < b ? -1 : 1;
};
