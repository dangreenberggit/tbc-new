import i18n from '@i18n/config';
import { Button } from '@ui-kit/Button';
import clsx from 'clsx';
import type { ReactNode } from 'react';

import type { ResultsSort, ResultsSortKey } from '../../model/results_sort';

const SORT_COLUMNS: readonly ResultsSortKey[] = ['item', 'slot', 'delta_dps', 'source'];

/**
 * One width per column, in head order, shared by every results table (fixed
 * layout) so the below-cutoff group's columns sit under the shortlist's head.
 * Each width is a little over the widest cell the ret-p3-p2 and feral-p3-p2bis
 * fixtures put in that column with the content's own widths (rank 50, slot 90,
 * ΔDPS 76, toggles 30 px at 1280); item and source text wraps. The item column
 * has no width and takes the rest of the table, so a long word in an item name
 * breaks (`ItemNameCell`) rather than run into the next column.
 */
const COLUMN_WIDTHS: ReadonlyArray<readonly [column: string, width: string | undefined]> = [
	['rank', 'w-15'],
	['item', undefined],
	['slot', 'w-28'],
	['delta_dps', 'w-24'],
	['source', 'w-36'],
	['favorite', 'w-9'],
	['batch', 'w-9'],
];

/** The shared widths; `ResultsTable` renders it first in every results table. */
export const ResultsColumns = () => (
	<colgroup>
		{COLUMN_WIDTHS.map(([column, width]) => (
			<col key={column} className={width} />
		))}
	</colgroup>
);

const columnClass = (key: ResultsSortKey) => clsx('py-1 pr-3', key === 'delta_dps' && 'text-right');

const ariaSort = (sort: ResultsSort | undefined, key: ResultsSortKey) => {
	if (sort?.key !== key) return 'none';
	return sort.dir === 'asc' ? 'ascending' : 'descending';
};

const SortIndicator = ({ dir }: { dir: ResultsSort['dir'] }) => (
	<>
		<span aria-hidden="true">{dir === 'asc' ? '▲' : '▼'}</span>
		<span className="sr-only">{i18n.t(dir === 'asc' ? 'upgrades_tab.results.sort_ascending' : 'upgrades_tab.results.sort_descending')}</span>
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
			<th className="py-1 pr-3">{i18n.t('upgrades_tab.results.rank')}</th>
			{children}
			<th className="py-1">
				<span className="sr-only">{i18n.t('upgrades_tab.results.favorite')}</span>
			</th>
			<th className="py-1">
				<span className="sr-only">{i18n.t('upgrades_tab.results.batch')}</span>
			</th>
		</tr>
	</thead>
);

/** The head of a table in flight: nothing to click, because its rows are not the ranking yet. */
export const PlainResultsHead = () => (
	<HeadRow>
		{SORT_COLUMNS.map(key => (
			<th key={key} className={columnClass(key)}>
				{i18n.t(`upgrades_tab.results.${key}`)}
			</th>
		))}
	</HeadRow>
);

export interface SortableResultsHeadProps {
	sort?: ResultsSort;
	onSort: (key: ResultsSortKey) => void;
}

/** The head of a settled table: each data column sorts on a click, and says how it is sorted. */
export const SortableResultsHead = ({ sort, onSort }: SortableResultsHeadProps) => (
	<HeadRow>
		{SORT_COLUMNS.map(key => (
			<th key={key} className={columnClass(key)} aria-sort={ariaSort(sort, key)}>
				<Button
					variant="unstyled"
					className="text-inherit [font:inherit] focus-visible:focus-ring"
					data-testid={`upgrades-sort-${key}`}
					onClick={() => onSort(key)}>
					{i18n.t(`upgrades_tab.results.${key}`)}
					{sort?.key === key && <SortIndicator dir={sort.dir} />}
				</Button>
			</th>
		))}
	</HeadRow>
);
