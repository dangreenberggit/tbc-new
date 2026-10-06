import i18n from '@i18n/config';
import { Button } from '@ui-kit/Button';
import clsx from 'clsx';

import type { ResultsSort, ResultsSortKey } from '../../model/results_sort';

export interface ResultsTableHeadProps {
	sort?: ResultsSort;
	/** Absent: a plain head with nothing to click, as the table has while a run is in flight. */
	onSort?: (key: ResultsSortKey) => void;
}

const SORT_COLUMNS: readonly ResultsSortKey[] = ['item', 'slot', 'delta_dps', 'source'];

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
 * The results head: Rank, the four sortable columns, and the two toggle
 * columns, named for screen readers only because they hold icon buttons.
 */
export const ResultsTableHead = ({ sort, onSort }: ResultsTableHeadProps) => (
	<thead>
		<tr className="border-b border-b-border text-left">
			<th className="py-1 pr-3">{i18n.t('upgrades_tab.results.rank')}</th>
			{SORT_COLUMNS.map(key => (
				<th key={key} className={clsx('py-1 pr-3', key === 'delta_dps' && 'text-right')} aria-sort={onSort ? ariaSort(sort, key) : undefined}>
					{onSort ? (
						<Button
							variant="unstyled"
							className="text-inherit [font:inherit] focus-visible:focus-ring"
							data-testid={`upgrades-sort-${key}`}
							onClick={() => onSort(key)}>
							{i18n.t(`upgrades_tab.results.${key}`)}
							{sort?.key === key && <SortIndicator dir={sort.dir} />}
						</Button>
					) : (
						i18n.t(`upgrades_tab.results.${key}`)
					)}
				</th>
			))}
			<th className="py-1">
				<span className="sr-only">{i18n.t('upgrades_tab.results.favorite')}</span>
			</th>
			<th className="py-1">
				<span className="sr-only">{i18n.t('upgrades_tab.results.batch')}</span>
			</th>
		</tr>
	</thead>
);
