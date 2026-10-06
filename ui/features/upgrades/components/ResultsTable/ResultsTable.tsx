import type { ComponentPropsWithoutRef } from 'react';

import type { RankedItem } from '../../model/engine/rank';
import { type ResultsSort, sortRows } from '../../model/results_sort';
import { rowKey } from '../../model/results_view';
import { SORT_LABELS } from '../../utils/format';
import { ResultRow, type RowContext } from './ResultRow';
import { PlainResultsHead } from './ResultsTableHead';

/** Table attributes pass through, so a variant can mark itself; the testid the gates read is fixed after them. */
export type ResultsTableProps = Omit<ComponentPropsWithoutRef<'table'>, 'className'>;

/**
 * The frame every results table shares: the scroll box and the table the gates
 * read. The caller composes its head, if it has one, and `ResultRows` inside.
 */
export const ResultsTable = ({ children, ...attributes }: ResultsTableProps) => (
	<div data-testid="upgrades-table-scroll" className="overflow-x-auto">
		<table {...attributes} className="w-full" data-testid="upgrades-results-table">
			{children}
		</table>
	</div>
);

export interface ResultRowsProps {
	rows: readonly RankedItem[];
	rowContext: RowContext;
	/** Absent: the order given. */
	sort?: ResultsSort;
}

/** The table of a run in flight: the rows so far, best first, under a head with nothing to click. */
export const ProvisionalResultsTable = ({ rows, rowContext }: Omit<ResultRowsProps, 'sort'>) => (
	<ResultsTable data-provisional="true">
		<PlainResultsHead />
		<ResultRows rows={rows} rowContext={rowContext} />
	</ResultsTable>
);

/** A table's rows in `sort` order, numbered from 1 in the order shown (owner ruling, ticket 287). */
export const ResultRows = ({ rows, rowContext, sort }: ResultRowsProps) => (
	<tbody>
		{sortRows(rows, sort, SORT_LABELS).map((row, index) => (
			<ResultRow key={rowKey(row)} row={row} position={index + 1} context={rowContext} />
		))}
	</tbody>
);
