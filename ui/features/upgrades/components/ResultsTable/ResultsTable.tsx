import type { ComponentPropsWithoutRef } from 'react';

import type { RankedItem } from '../../model/engine/rank';
import { type ResultsSort, sortRows } from '../../model/results_sort';
import { rowKey } from '../../model/results_view';
import { SORT_LABELS } from '../../utils/format';
import { ResultRow, type RowContext } from './ResultRow';
import { PlainResultsHead, RESULTS_COLUMNS } from './ResultsTableHead';

/** Table attributes pass through, so a variant can mark itself; the testid the gates read is fixed after them. */
export type ResultsTableProps = Omit<ComponentPropsWithoutRef<'table'>, 'className'>;

/**
 * The frame every results table shares: the scroll box, the table the gates
 * read and its column widths. The caller composes its head, if it has one, and
 * `ResultRows` inside. Every table is equally wide, the full width, so with the
 * shared widths every column of one table lines up with the same column of the
 * others. Its floor (602 px) leaves the item column 139 px for text, wider than
 * the widest word in any universe's item names ("Shadowmaster's", 125.5 px), so
 * a name breaks only between words; below the floor the box scrolls. The scroll
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
		{sortRows(rows, sort, SORT_LABELS, rowContext.dpsKey).map((row, index) => (
			<ResultRow key={rowKey(row)} row={row} position={index + 1} context={rowContext} />
		))}
	</tbody>
);
