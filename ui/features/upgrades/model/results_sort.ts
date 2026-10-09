/**
 * The two inputs the results sort reads (`results_columns.ts`, ticket 565):
 * the slot and source text, and the ΔDPS key. The sort itself is TanStack
 * Table's, with its state in the tab store.
 */

import type { RankedItem } from './engine/rank';

/** The text a reader sees in the slot and source cells, which those columns sort on. */
export type SortLabels<T> = { slot: (row: T) => string; source: (row: T) => string };

/** What the ΔDPS column sorts on, when it is more than the row's own ΔDPS (`results_view.ts` `dpsSortKeyFor`). */
export type DpsSortKey = (row: RankedItem) => number;
