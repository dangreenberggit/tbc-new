import i18n from '@i18n/config';
import { Button } from '@ui-kit/Button';
import clsx from 'clsx';
import type { ReactNode } from 'react';

import type { ResultsTableModel } from '../../hooks/useResultsTable';
import { SORT_COLUMN_IDS, type SortColumnId } from '../../model/results_columns';

const SORT_COLUMNS: readonly SortColumnId[] = SORT_COLUMN_IDS;

type SortDir = 'asc' | 'desc';

type Column = 'rank' | SortColumnId | 'favorite' | 'batch';

/** Every column in head order: `HeadRow`'s Rank, the sortable columns, then its two toggle columns. */
const COLUMNS: readonly Column[] = ['rank', ...SORT_COLUMNS, 'favorite', 'batch'];

/** How many cells a row spans, for a cell that stands in for a whole row. */
export const RESULTS_COLUMN_COUNT = COLUMNS.length;

/**
 * One width per column, shared by every results table (fixed layout) so the below-cutoff group's
 * columns sit under the main table's head. Each width is a little over the widest cell seen at
 * 1280 px (rank 50, slot 90, ΔDPS 76, toggles 30); item, slot and source text wraps. The item
 * column takes the rest of the table, down to the floor `ResultsTable` sets.
 */
const COLUMN_WIDTH: Record<Column, string | undefined> = {
	rank: 'w-15',
	item: undefined,
	slot: 'w-28',
	delta_dps: 'w-24',
	source: 'w-36',
	favorite: 'w-9',
	batch: 'w-9',
};

/** Static, so built once. */
export const RESULTS_COLGROUP = (
	<colgroup>
		{COLUMNS.map(column => (
			<col key={column} className={COLUMN_WIDTH[column]} />
		))}
	</colgroup>
);

const columnName = (column: Column) => i18n.t(`upgrades_tab.results.${column}`, { ns: 'upgrades' });

const columnClass = (column: SortColumnId) => clsx('py-1 pr-3', column === 'delta_dps' && 'text-right');

/** How the table sorts on `key`: its direction, or false when another column (or none) sorts it. */
const sortDirOf = (table: ResultsTableModel, column: SortColumnId): SortDir | false => table.getColumn(column)?.getIsSorted() ?? false;

const ariaSort = (dir: SortDir | false) => {
	if (!dir) return 'none';
	return dir === 'asc' ? 'ascending' : 'descending';
};

const SortIndicator = ({ dir }: { dir: SortDir }) => (
	<>
		<span aria-hidden="true">{dir === 'asc' ? '▲' : '▼'}</span>
		<span className="sr-only">
			{i18n.t(dir === 'asc' ? 'upgrades_tab.results.sort_ascending' : 'upgrades_tab.results.sort_descending', { ns: 'upgrades' })}
		</span>
	</>
);

/**
 * The columns every head shares around the four data columns: Rank first, and the
 * two toggle columns last, named for screen readers only because they hold icons.
 */
const HeadRow = ({ children }: { children: ReactNode }) => (
	<thead>
		<tr className="border-b border-b-border text-left">
			<th className="py-1 pr-3">{columnName('rank')}</th>
			{children}
			<th className="py-1">
				<span className="sr-only">{columnName('favorite')}</span>
			</th>
			<th className="py-1">
				<span className="sr-only">{columnName('batch')}</span>
			</th>
		</tr>
	</thead>
);

/** The head of a table in flight: nothing to click, because its rows are not the ranking yet. */
export const UnsortableResultsHead = () => (
	<HeadRow>
		{SORT_COLUMNS.map(column => (
			<th key={column} className={columnClass(column)}>
				{columnName(column)}
			</th>
		))}
	</HeadRow>
);

const isSortColumn = (column: Column): column is SortColumnId => (SORT_COLUMNS as readonly Column[]).includes(column);

/**
 * A head only screen readers get, for a table under another table's visible head
 * (the rows below the cutoff, under the main table). The cells are unpadded, since
 * the default padding would leave a 2 px row, so the row takes no height and the
 * shared widths still place each column under the visible head.
 */
export const ScreenReaderResultsHead = ({ table }: { table: ResultsTableModel }) => (
	<thead>
		<tr>
			{COLUMNS.map(column => (
				<th key={column} className="p-0" aria-sort={isSortColumn(column) ? ariaSort(sortDirOf(table, column)) : undefined}>
					<span className="sr-only">{columnName(column)}</span>
				</th>
			))}
		</tr>
	</thead>
);

export interface SortableResultsHeadProps {
	table: ResultsTableModel;
}

/** The head of a settled table: each data column sorts on a click, and says how it is sorted. */
export const SortableResultsHead = ({ table }: SortableResultsHeadProps) => (
	<HeadRow>
		{SORT_COLUMNS.map(column => {
			const dir = sortDirOf(table, column);
			return (
				<th key={column} className={columnClass(column)} aria-sort={ariaSort(dir)}>
					<Button
						variant="unstyled"
						className="text-inherit [font:inherit] focus-visible:focus-ring"
						data-testid={`upgrades-sort-${column}`}
						onClick={() => table.getColumn(column)?.toggleSorting()}>
						{columnName(column)}
						{dir && <SortIndicator dir={dir} />}
					</Button>
				</th>
			);
		})}
	</HeadRow>
);
