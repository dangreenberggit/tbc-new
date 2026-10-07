import i18n from '@i18n/config';

import type { RankedItem } from '../../model/engine/rank';
import type { ResultsSort, ResultsSortKey } from '../../model/results_sort';
import { BelowCutoffGroup } from '../BelowCutoffGroup';
import { EmptyState } from '../EmptyState';
import { ResultRows, ResultsTable, type RowContext, ScreenReaderResultsHead, SortableResultsHead } from '../ResultsTable';

export interface ResultsPaneProps {
	shortlist: readonly RankedItem[];
	belowCutoff: readonly RankedItem[];
	rowContext: RowContext;
	sort?: ResultsSort;
	onSort: (key: ResultsSortKey) => void;
}

/**
 * One sub-tab's results: its shortlist, then the rows below the cutoff behind
 * an expand. Under a shortlist the group's head is for screen readers only,
 * because the shortlist's head names the columns on screen; with no shortlist
 * the group gets the sortable head.
 */
export const ResultsPane = ({ shortlist, belowCutoff, rowContext, sort, onSort }: ResultsPaneProps) => (
	<>
		{shortlist.length > 0 ? (
			<ResultsTable>
				<SortableResultsHead sort={sort} onSort={onSort} />
				<ResultRows rows={shortlist} rowContext={rowContext} sort={sort} />
			</ResultsTable>
		) : (
			<EmptyState title={i18n.t('upgrades_tab.results.empty_no_upgrades')} body={i18n.t('upgrades_tab.results.empty_no_upgrades_body')} />
		)}
		{belowCutoff.length > 0 && (
			<BelowCutoffGroup
				head={shortlist.length > 0 ? <ScreenReaderResultsHead sort={sort} /> : <SortableResultsHead sort={sort} onSort={onSort} />}
				rows={belowCutoff}
				rowContext={rowContext}
				sort={sort}
			/>
		)}
	</>
);
