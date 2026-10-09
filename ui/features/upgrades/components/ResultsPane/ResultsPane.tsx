import i18n from '@i18n/config';

import { useResultsTable } from '../../hooks/useResultsTable';
import type { RankedItem } from '../../model/engine/rank';
import { BelowCutoffGroup } from '../BelowCutoffGroup';
import { EmptyState } from '../EmptyState';
import { ResultRows, ResultsTable, type RowContext, ScreenReaderResultsHead, SortableResultsHead } from '../ResultsTable';

export interface ResultsPaneProps {
	shortlist: readonly RankedItem[];
	belowCutoff: readonly RankedItem[];
	rowContext: RowContext;
}

/**
 * One sub-tab's results: its shortlist, then the rows below the cutoff behind
 * an expand. Under a shortlist the group's head is for screen readers only,
 * because the shortlist's head names the columns on screen; with no shortlist
 * the group gets the sortable head. Both tables follow the tab store's one
 * sort, so a click on either head orders both.
 */
export const ResultsPane = ({ shortlist, belowCutoff, rowContext }: ResultsPaneProps) => {
	const shortlistTable = useResultsTable(shortlist, rowContext);
	const groupTable = useResultsTable(belowCutoff, rowContext);
	return (
		<>
			{shortlist.length > 0 ? (
				<ResultsTable>
					<SortableResultsHead table={shortlistTable} />
					<ResultRows table={shortlistTable} rowContext={rowContext} />
				</ResultsTable>
			) : (
				<EmptyState
					title={i18n.t('upgrades_tab.results.empty_no_upgrades', { ns: 'upgrades' })}
					body={i18n.t('upgrades_tab.results.empty_no_upgrades_body', { ns: 'upgrades' })}
				/>
			)}
			{belowCutoff.length > 0 && (
				<BelowCutoffGroup
					head={shortlist.length > 0 ? <ScreenReaderResultsHead table={groupTable} /> : <SortableResultsHead table={groupTable} />}
					table={groupTable}
					rowContext={rowContext}
				/>
			)}
		</>
	);
};
