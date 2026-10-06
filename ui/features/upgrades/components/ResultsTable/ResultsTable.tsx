import type { RankedItem } from '../../model/engine/rank';
import { type ResultsSort, type ResultsSortKey, sortRows } from '../../model/results_sort';
import { rowKey } from '../../model/results_view';
import { SORT_LABELS } from '../../utils/format';
import { ResultRow, type RowContext } from './ResultRow';
import { ResultsTableHead } from './ResultsTableHead';

export interface ResultsTableProps {
	rows: readonly RankedItem[];
	rowContext: RowContext;
	sort?: ResultsSort;
	/** Absent: the head has nothing to click. */
	onSort?: (key: ResultsSortKey) => void;
	/** A run in flight: the rows so far, best first, not yet the ranking. */
	provisional?: boolean;
	/** No head, for the below-cutoff group under a table that has one. */
	headless?: boolean;
}

/** One results table. Every table numbers its own rows from 1 in the order shown (owner ruling, ticket 287). */
export const ResultsTable = ({ rows, rowContext, sort, onSort, provisional, headless }: ResultsTableProps) => (
	<div data-testid="upgrades-table-scroll" className="overflow-x-auto">
		<table className="w-full" data-testid="upgrades-results-table" data-provisional={provisional ? 'true' : undefined}>
			{!headless && <ResultsTableHead sort={sort} onSort={onSort} />}
			<tbody>
				{sortRows(rows, sort, SORT_LABELS).map((row, index) => (
					<ResultRow key={rowKey(row)} row={row} position={index + 1} context={rowContext} />
				))}
			</tbody>
		</table>
	</div>
);
