import i18n from '@i18n/config';
import { Button } from '@ui-kit/Button';
import clsx from 'clsx';
import type { ReactNode } from 'react';

import type { ResultsTableModel } from '../../hooks/useResultsTable';
import { type ResultsSortKey, SORT_COLUMN_IDS } from '../../model/results_columns';

const SORT_COLUMNS: readonly ResultsSortKey[] = SORT_COLUMN_IDS;

type SortDir = 'asc' | 'desc';

type Column = 'rank' | ResultsSortKey | 'favorite' | 'batch';

/** Every column in head order: `HeadRow`'s Rank, the sortable columns, then its two toggle columns. */
const COLUMNS: readonly Column[] = ['rank', ...SORT_COLUMNS, 'favorite', 'batch'];

/**
 * One width per column, shared by every results table (fixed
 * layout) so the below-cutoff group's columns sit under the shortlist's head.
 * Each width is a little over the widest cell the ret-p3-p2 and feral-p3-p2bis
 * fixtures put in that column with the content's own widths (rank 50, slot 90,
 * ΔDPS 76, toggles 30 px at 1280); item, slot and source text wraps. The item column
 * has no width and takes the rest of the table; the table's floor
 * (`ResultsTable`) sets how narrow it can get.
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

/** The shared widths; `ResultsTable` renders it first in every results table. Static, so built once. */
export const RESULTS_COLUMNS = (
	<colgroup>
		{COLUMNS.map(column => (
			<col key={column} className={COLUMN_WIDTH[column]} />
		))}
	</colgroup>
);

const columnName = (column: Column) => i18n.t(`upgrades_tab.results.${column}`, { ns: 'upgrades' });

const columnClass = (key: ResultsSortKey) => clsx('py-1 pr-3', key === 'delta_dps' && 'text-right');

/** How the table sorts on `key`: its direction, or false when another column (or none) sorts it. */
const sortDirOf = (table: ResultsTableModel, key: ResultsSortKey): SortDir | false => table.getColumn(key)?.getIsSorted() ?? false;

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
 * The columns every head shares around the four data columns: Rank first, and
 * the two toggle columns last, named for screen readers only because they
 * hold icon buttons.
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
export const PlainResultsHead = () => (
	<HeadRow>
		{SORT_COLUMNS.map(key => (
			<th key={key} className={columnClass(key)}>
				{columnName(key)}
			</th>
		))}
	</HeadRow>
);

const isSortColumn = (column: Column): column is ResultsSortKey => (SORT_COLUMNS as readonly Column[]).includes(column);

/**
 * A head only screen readers get, for a table under another table's visible
 * head (the below-cutoff group under the shortlist): every column named and
 * the sort said, the names visually hidden and the cells unpadded (the
 * browser's default cell padding would leave a 2 px row), so the row takes no
 * height and the shared widths still place each column under the visible head.
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
		{SORT_COLUMNS.map(key => {
			const dir = sortDirOf(table, key);
			return (
				<th key={key} className={columnClass(key)} aria-sort={ariaSort(dir)}>
					<Button
						variant="unstyled"
						className="text-inherit [font:inherit] focus-visible:focus-ring"
						data-testid={`upgrades-sort-${key}`}
						onClick={() => table.getColumn(key)?.toggleSorting()}>
						{columnName(key)}
						{dir && <SortIndicator dir={dir} />}
					</Button>
				</th>
			);
		})}
	</HeadRow>
);
