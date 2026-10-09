import type { ComponentPropsWithoutRef } from 'react';

import { type ResultsTableModel, useResultsTable } from '../../hooks/useResultsTable';
import type { RankedItem } from '../../model/engine/rank';
import { ResultRow, type RowContext } from './ResultRow';
import { PlainResultsHead, RESULTS_COLUMNS } from './ResultsTableHead';

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
	rows: readonly RankedItem[];
	rowContext: RowContext;
}

/** The table of a run in flight: the rows so far, best first, under a head with nothing to click, so the stored sort does not apply. */
export const ProvisionalResultsTable = ({ rows, rowContext }: ProvisionalResultsTableProps) => {
	const table = useResultsTable(rows, rowContext, { sortable: false });
	return (
		<ResultsTable data-provisional="true">
			<PlainResultsHead />
			<ResultRows table={table} rowContext={rowContext} />
		</ResultsTable>
	);
};

/** A table's rows in its sort order, numbered from 1 in the order shown (owner ruling, ticket 287). Each row is keyed by `rowKey`, the table's row id. */
export const ResultRows = ({ table, rowContext }: ResultRowsProps) => (
	<tbody>
		{table.getRowModel().rows.map((row, index) => (
			<ResultRow key={row.id} row={row.original} position={index + 1} context={rowContext} />
		))}
	</tbody>
);
