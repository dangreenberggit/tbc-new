import { type ComponentPropsWithoutRef, useMemo, useRef } from 'react';

import { type ResultsTableModel, useResultsTable } from '../../hooks/useResultsTable';
import { useVirtualRows } from '../../hooks/useVirtualRows';
import type { RankedItem } from '../../model/engine/rank';
import { landedRows as bestFirst } from '../../model/results_view';
import { ResultRow, type RowContext } from './ResultRow';
import { PlainResultsHead, RESULTS_COLUMN_COUNT, RESULTS_COLUMNS } from './ResultsTableHead';

/** Table attributes pass through, so a variant can mark itself; the testid the gates read is fixed after them. */
export type ResultsTableProps = Omit<ComponentPropsWithoutRef<'table'>, 'className'>;

/**
 * The frame every results table shares: the scroll box, the table the gates
 * read and its column widths. The caller composes its head, if it has one, and
 * `ResultRows` inside. Every table is equally wide, the full width, so with the
 * shared widths every column of one table lines up with the same column of the
 * others. Its floor (602 px) leaves 139 px for item-name text (measured in the
 * gate's Chromium), wider than the widest unhyphenated word in any universe's
 * item names ("Shadowmaster's", 125.5 px), so a name breaks only between words
 * (layout gate check 14); below the floor the box scrolls. The scroll
 * box is `relative` so it is the containing block of the head's screen-reader
 * labels (`sr-only` is absolutely positioned): otherwise they escape the box's
 * clip and widen the page at 375 px (layout gate check 1, post-run).
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
 * A table's rows in its sort order, numbered from 1 in the order shown (owner ruling, ticket 287). Each
 * row is keyed by `rowKey`, the table's row id. Only the rows in or near the page's view are rendered
 * (ticket 565), so the tbody carries the table's full row count for the gates, which cannot count rows.
 */
export const ResultRows = ({ table, rowContext }: ResultRowsProps) => {
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
				return <ResultRow key={row.id} ref={measureRow} row={row.original} position={index + 1} context={rowContext} />;
			})}
			{paddingBottom > 0 && <RowSpacer height={paddingBottom} />}
		</tbody>
	);
};
