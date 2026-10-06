import i18n from '@i18n/config';

import { type RunState, visibleRows } from '../../model/run_reducer';
import { EmptyState } from '../EmptyState';
import { ResultsTable } from '../ResultsTable';

export interface UpgradesResultsProps {
	run: RunState;
}

/** The results area: the rows the run has so far, or what to say in their place. */
export const UpgradesResults = ({ run }: UpgradesResultsProps) => {
	const rows = visibleRows(run);
	if (rows.length > 0) return <ResultsTable rows={rows} />;

	switch (run.status) {
		case 'idle':
			return <EmptyState title={i18n.t('upgrades_tab.results.empty_no_ranking')} body={i18n.t('upgrades_tab.results.empty_no_ranking_body')} />;
		case 'running':
			return <EmptyState body={i18n.t('upgrades_tab.results.rows_pending')} />;
		case 'done':
			return <EmptyState title={i18n.t('upgrades_tab.results.empty_no_upgrades')} body={i18n.t('upgrades_tab.results.empty_no_upgrades_body')} />;
		case 'error':
			return (
				<p className="mb-0 text-danger" role="alert" data-testid="upgrades-run-error">
					{run.message}
				</p>
			);
		case 'stopped':
			// The status line already says the run stopped before any row finished.
			return null;
	}
};
