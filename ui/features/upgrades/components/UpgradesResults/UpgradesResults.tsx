import i18n from '@i18n/config';
import { useSimHost } from '@sim/context/SimHostContext';
import { useMemo } from 'react';

import { landedRows, resultsViewFor } from '../../model/results_view';
import type { RunState } from '../../model/run_reducer';
import { EmptyState } from '../EmptyState';
import { ResultsPanes } from '../ResultsPanes';
import { ProvisionalResultsTable, type RowContext } from '../ResultsTable';
import { SubstitutionsList } from '../SubstitutionsList';

export interface UpgradesResultsProps {
	run: RunState;
}

/**
 * The results area: the rows landed so far while a run is in flight, the
 * sub-tabs and the dropped candidates once it settles, or what to say in
 * their place.
 */
export const UpgradesResults = ({ run }: UpgradesResultsProps) => {
	const { sim } = useSimHost();
	const ranking = run.status === 'done' || run.status === 'stopped' ? run.result : undefined;
	const measuredOn = run.status === 'running' || run.status === 'done' || run.status === 'stopped' ? run.measuredOn : undefined;
	// Memoised because every `ResultRow` is: a new context on each landing row would render every row again.
	const rowContext = useMemo<RowContext>(
		() => ({ itemOf: itemId => sim.db.getItemById(itemId), tip: { ranking, wornItemIds: measuredOn?.wornItemIds, specId: measuredOn?.specId } }),
		[sim, ranking, measuredOn],
	);
	// Memoised for the same rows: `applyView` builds new row objects on every call.
	const view = useMemo(() => resultsViewFor(run), [run]);

	switch (run.status) {
		case 'idle':
			return <EmptyState title={i18n.t('upgrades_tab.results.empty_no_ranking')} body={i18n.t('upgrades_tab.results.empty_no_ranking_body')} />;
		case 'running':
			return run.landedRows.length > 0 ? (
				<ProvisionalResultsTable rows={landedRows(run.landedRows)} rowContext={rowContext} />
			) : (
				<EmptyState body={i18n.t('upgrades_tab.results.rows_pending')} />
			);
		case 'error':
			return (
				<p className="mb-0 text-danger" role="alert" data-testid="upgrades-run-error">
					{run.message}
				</p>
			);
		case 'done':
		case 'stopped': {
			const hasRows = view !== undefined && view.rows.length > 0;
			// A stopped run with no finished row shows no empty state: the status line already says so.
			const noUpgrades = !hasRows && run.status === 'done';
			return (
				<>
					{hasRows && <ResultsPanes view={view} rowContext={rowContext} />}
					{noUpgrades && (
						<EmptyState title={i18n.t('upgrades_tab.results.empty_no_upgrades')} body={i18n.t('upgrades_tab.results.empty_no_upgrades_body')} />
					)}
					{run.result.substitutions.length > 0 && <SubstitutionsList substitutions={run.result.substitutions} />}
				</>
			);
		}
	}
};
