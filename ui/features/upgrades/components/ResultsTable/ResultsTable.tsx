import { type ComponentPropsWithoutRef, useMemo, useRef } from 'react';

import { type ResultsTableModel, useResultsTable } from '../../hooks/useResultsTable';
import { useVirtualRows } from '../../hooks/useVirtualRows';
import type { RankedItem } from '../../model/engine/rank';
import { landedRows as bestFirst } from '../../model/results_view';
import { ResultRow, type RowContext } from './ResultRow';
import { PlainResultsHead, RESULTS_COLUMN_COUNT, RESULTS_COLUMNS } from './ResultsTableHead';

/** Table attributes pass through, so a variant can mark itself; the testid is set after them so it cannot be overridden. */
export type ResultsTableProps = Omit<ComponentPropsWithoutRef<'table'>, 'className'>;

/**
 * The frame every results table shares: the scroll box, the table and its column widths. The caller
 * puts its head, if any, and `ResultRows` inside. Every table is full width, so with the shared
 * widths each column lines up across tables. The floor (602 px) leaves 139 px for item-name text,
 * wider than the widest unbroken word in any item name ("Shadowmaster's", 125.5 px in Chromium), so
 * a name breaks only between words; below the floor the box scrolls. The box is `relative` so it
 * contains the head's `sr-only` labels, which are absolutely positioned and would otherwise widen
 * the page at 375 px.
 */
export const ResultsTable = ({ children, ...attributes }: ResultsTableProps) => (
	<div data-testid="upgrades-table-scroll" className="relative overflow-x-auto">
		<table {...attributes} className="w-full min-w-172 table-fixed" data-testid="upgrades-results-table">
			{RESULTS_COLUMNS}
			{children}
		</table>
	</div>
);

export interface ResultRowsProps {
	/** The table whose rows these are (`useResultsTable`), already in the order it sorts them. */
	table: ResultsTableModel;
	rowContext: RowContext;
	/** The row ids (`rowKey`) to mark as not an upgrade: a main table's rows that miss the cutoff (`paneRows`). */
	notUpgrades?: ReadonlySet<string>;
}

export interface ProvisionalResultsTableProps {
	/** The run's rows so far, in the order they landed (`RunState.landedRows`). */
	landedRows: readonly RankedItem[];
	rowContext: RowContext;
}

/** The table of a run in flight: the rows so far, best first, under a head with nothing to click, so the stored sort does not apply. */
export const ProvisionalResultsTable = ({ landedRows, rowContext }: ProvisionalResultsTableProps) => {
	// Memoised on the run's array, which changes only when a row lands: TanStack rebuilds every row on new data.
	const rows = useMemo(() => bestFirst(landedRows), [landedRows]);
	const table = useResultsTable(rows, rowContext, { sortable: false });
	return (
		<ResultsTable data-provisional="true">
			<PlainResultsHead />
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
export const ResultRows = ({ table, rowContext, notUpgrades }: ResultRowsProps) => {
	const rows = table.getRowModel().rows;
	const tbodyRef = useRef<HTMLTableSectionElement>(null);
	// Memoised on the row model, which TanStack keeps while the data and sort hold: a new array is a new
	// `getItemKey`, which makes the virtualiser recompute every row's position.
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
						notUpgrade={notUpgrades?.has(row.id) ?? false}
					/>
				);
			})}
			{paddingBottom > 0 && <RowSpacer height={paddingBottom} />}
		</tbody>
	);
};
