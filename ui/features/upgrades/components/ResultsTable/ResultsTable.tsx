import { type ComponentPropsWithoutRef, useMemo, useRef } from 'react';

import { type ResultsTableModel, useResultsTable } from '../../hooks/useResultsTable';
import { useVirtualRows } from '../../hooks/useVirtualRows';
import type { RankedItem } from '../../model/engine/rank';
import { simmedBestFirst } from '../../model/results_view';
import { ResultRow, type RowContext } from './ResultRow';
import { RESULTS_COLGROUP, RESULTS_COLUMN_COUNT, UnsortableResultsHead } from './ResultsTableHead';

/** Table attributes pass through, so a variant can mark itself; the testid is set after them so it cannot be overridden. */
export type ResultsTableProps = Omit<ComponentPropsWithoutRef<'table'>, 'className'>;

/**
 * The frame every results table shares: the scroll box, the table and its column widths, with the
 * caller's head and `ResultRows` inside. Every table is full width, so columns line up across
 * tables. The floor (602 px) leaves the item name wider than its widest unbroken word
 * ("Shadowmaster's"), so a name breaks only between words; below it the box scrolls. The box is
 * `relative` to contain the head's absolutely positioned `sr-only` labels, which would otherwise
 * widen a phone-width page.
 */
export const ResultsTable = ({ children, ...attributes }: ResultsTableProps) => (
	<div data-testid="upgrades-table-scroll" className="relative overflow-x-auto">
		<table {...attributes} className="w-full min-w-172 table-fixed" data-testid="upgrades-results-table">
			{RESULTS_COLGROUP}
			{children}
		</table>
	</div>
);

export interface ResultRowsProps {
	/** The table whose rows these are (`useResultsTable`), already in the order it sorts them. */
	table: ResultsTableModel;
	rowContext: RowContext;
	/** The row ids (`rowKey`) to mark as not an upgrade: a main table's rows that miss the cutoff (`paneRows`). */
	notUpgradeKeys?: ReadonlySet<string>;
}

export interface ProvisionalResultsTableProps {
	/** The run's rows so far, in the order they landed (`RunState.landedRows`). */
	landedRows: readonly RankedItem[];
	rowContext: RowContext;
}

/** The table of a run in flight: the rows so far, best first, under a head with nothing to click, so the stored sort does not apply. */
export const ProvisionalResultsTable = ({ landedRows, rowContext }: ProvisionalResultsTableProps) => {
	// Memoized on the run's array, which changes only when a row finishes: TanStack rebuilds every row on new data.
	const rows = useMemo(() => simmedBestFirst(landedRows), [landedRows]);
	const table = useResultsTable(rows, rowContext, { sortable: false });
	return (
		<ResultsTable data-provisional="true">
			<UnsortableResultsHead />
			<ResultRows table={table} rowContext={rowContext} />
		</ResultsTable>
	);
};

/** Stands in for the rows not rendered, so the table keeps its full height and the scroll bar its place. */
const RowSpacer = ({ height }: { height: number }) => (
	<tr data-testid="upgrades-row-spacer" aria-hidden="true">
		<td colSpan={RESULTS_COLUMN_COUNT} style={{ height }} />
	</tr>
);

/**
 * A table's rows in its sort order, numbered from 1 in the order shown and keyed by `rowKey`. Only
 * the rows in or near the view are rendered, so the tbody carries the full row count in
 * `data-row-count`.
 */
export const ResultRows = ({ table, rowContext, notUpgradeKeys }: ResultRowsProps) => {
	const rows = table.getRowModel().rows;
	const tbodyRef = useRef<HTMLTableSectionElement>(null);
	// Memoized on the row model, which TanStack keeps while the data and sort hold: a new array is a new
	// `getItemKey`, which makes the virtualizer recompute every row's position.
	const keys = useMemo(() => rows.map(row => row.id), [rows]);
	const { indexes, paddingTop, paddingBottom, measureRow } = useVirtualRows(keys, tbodyRef);
	return (
		<tbody ref={tbodyRef} data-testid="upgrades-result-rows" data-row-count={rows.length}>
			{paddingTop > 0 && <RowSpacer height={paddingTop} />}
			{indexes.map(index => {
				const row = rows[index];
				if (!row) return null;
				return (
					<ResultRow
						key={row.id}
						ref={measureRow}
						row={row.original}
						position={index + 1}
						context={rowContext}
						notUpgrade={notUpgradeKeys?.has(row.id) ?? false}
					/>
				);
			})}
			{paddingBottom > 0 && <RowSpacer height={paddingBottom} />}
		</tbody>
	);
};
