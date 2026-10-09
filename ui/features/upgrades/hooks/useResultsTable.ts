import {
	createColumnHelper,
	createSortedRowModel,
	functionalUpdate,
	rowSortingFeature,
	type SortFn,
	type SortingState,
	tableFeatures,
	type Updater,
	useTable,
} from '@tanstack/react-table';
import { useMemo } from 'react';

import type { RowContext } from '../components/ResultsTable/ResultRow';
import type { RankedItem } from '../model/engine/rank';
import { compareSortValues, type DpsSortKey, SORT_COLUMN_IDS, type SortLabels, sortValue } from '../model/results_columns';
import { rowKey } from '../model/results_view';
import { selectSort, setSort, type UpgradesState } from '../model/upgrades_store';
import { SORT_LABELS } from '../utils/format';
import { useUpgradesStore, useUpgradesStoreApi } from './useUpgradesStore';

export const resultsTableFeatures = tableFeatures({ rowSortingFeature, sortedRowModel: createSortedRowModel() });

export type ResultsTableFeatures = typeof resultsTableFeatures;

const byValue: SortFn<ResultsTableFeatures, RankedItem> = (rowA, rowB, columnId) =>
	compareSortValues(rowA.getValue<string | number>(columnId), rowB.getValue<string | number>(columnId));

const column = createColumnHelper<ResultsTableFeatures, RankedItem>();

/** The four sortable columns, each sorting on `sortValue`. */
const resultsColumns = (labels: SortLabels<RankedItem>, dpsKey: DpsSortKey | undefined) =>
	column.columns(SORT_COLUMN_IDS.map(id => column.accessor(row => sortValue(id, row, labels, dpsKey), { id, sortFn: byValue })));

/**
 * The options every results table shares. A column starts descending (on
 * ΔDPS, the order the page opened with), a second click flips it, a sort is
 * never cleared, and a click on another column replaces the sort.
 */
const RESULTS_TABLE_OPTIONS = {
	features: resultsTableFeatures,
	getRowId: (row: RankedItem) => rowKey(row),
	sortDescFirst: true,
	enableSortingRemoval: false,
	enableMultiSort: false,
} as const;

const ENGINE_ORDER: SortingState = [];
const selectEngineOrder = (_state: UpgradesState): SortingState => ENGINE_ORDER;

export interface UseResultsTableOptions {
	/** False for a run in flight: its rows are not the ranking yet, so they keep the engine's order whatever the stored sort is. */
	sortable?: boolean;
}

/**
 * One results table over `rows`, sorted by the tab store's one sort, so every
 * table on the page and the export follow the same click (ticket 565).
 */
export function useResultsTable(rows: readonly RankedItem[], rowContext: RowContext, { sortable = true }: UseResultsTableOptions = {}) {
	const store = useUpgradesStoreApi();
	// A table that ignores the sort selects a constant, so a sort click does not re-render it.
	const sorting = useUpgradesStore(sortable ? selectSort : selectEngineOrder);
	const { dpsKey } = rowContext;
	// Memoised because `useTable` hands back a new table object whenever its options object is new, and a new
	// columns array rebuilds every column. Both hold only while the caller keeps `rows` the same array.
	const columns = useMemo(() => resultsColumns(SORT_LABELS, dpsKey), [dpsKey]);
	// Controlled `state.sorting` rather than a TanStack atom: the sort lives in the tab's one zustand store (ticket 565, plan Q-sort), and an atom would be a second store.
	const options = useMemo(
		() => ({
			...RESULTS_TABLE_OPTIONS,
			data: rows,
			columns,
			state: { sorting },
			onSortingChange: (updater: Updater<SortingState>) => setSort(store, functionalUpdate(updater, store.getState().sort)),
		}),
		[rows, columns, sorting, store],
	);
	return useTable(options);
}

/** What a head and its rows read: the column sort state and the rows in that order. */
export type ResultsTableModel = ReturnType<typeof useResultsTable>;
