import i18n from '@i18n/config';

import type { RankedItem } from '../../model/engine/rank';
import type { ResultsSort, ResultsSortKey } from '../../model/results_sort';
import { BelowCutoffGroup } from '../BelowCutoffGroup';
import { EmptyState } from '../EmptyState';
import { ResultsTable, type RowContext } from '../ResultsTable';

export interface ResultsPaneProps {
	shortlist: readonly RankedItem[];
	belowCutoff: readonly RankedItem[];
	rowContext: RowContext;
	sort?: ResultsSort;
	onSort: (key: ResultsSortKey) => void;
}

/** One sub-tab's results: its shortlist, then the rows below the cutoff behind an expand. */
export const ResultsPane = ({ shortlist, belowCutoff, rowContext, sort, onSort }: ResultsPaneProps) => (
	<>
		{shortlist.length > 0 ? (
			<ResultsTable rows={shortlist} rowContext={rowContext} sort={sort} onSort={onSort} />
		) : (
			<EmptyState title={i18n.t('upgrades_tab.results.empty_no_upgrades')} body={i18n.t('upgrades_tab.results.empty_no_upgrades_body')} />
		)}
		{belowCutoff.length > 0 && <BelowCutoffGroup rows={belowCutoff} rowContext={rowContext} sort={sort} />}
	</>
);
