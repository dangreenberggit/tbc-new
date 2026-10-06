import i18n from '@i18n/config';
import { memo } from 'react';

import { useResultsView } from '../../hooks/useResultsView';
import { landedRows } from '../../model/results_view';
import type { RunState } from '../../model/run_reducer';
import type { SetOption } from '../../model/settings_pool';
import { EmptyState } from '../EmptyState';
import { ResultsPanes } from '../ResultsPanes';
import { ProvisionalResultsTable } from '../ResultsTable';
import { SubstitutionsList } from '../SubstitutionsList';
import { ViewToggles } from '../ViewToggles';

export interface UpgradesResultsProps {
	run: RunState;
	/** The sim sets selected now; a row in one of them carries its name (ticket 430). */
	selectedSets: readonly SetOption[];
}

/**
 * The results area: the rows landed so far while a run is in flight, the
 * view toggles, sub-tabs and dropped candidates once it settles, or what to
 * say in their place.
 *
 * `memo`, because the tab body renders again on every settings edit and both
 * props keep their identity through one that is not a set pick: the panes and
 * the export would otherwise re-sort and re-serialise the shortlist each time.
 */
export const UpgradesResults = memo(({ run, selectedSets }: UpgradesResultsProps) => {
	const { toggles, offered, setToggle, rowContext, view } = useResultsView(run, selectedSets);

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
			// The status line's alert region says what failed.
			return null;
		case 'done':
		case 'stopped': {
			const hasRows = view !== undefined && view.rows.length > 0;
			// A stopped run with no finished row shows no empty state: the status line already says so.
			const noUpgrades = !hasRows && run.status === 'done';
			return (
				<>
					<ViewToggles offered={offered} toggles={toggles} maxPhase={run.result.assumptions.maxPhase} onChange={setToggle} />
					{hasRows && <ResultsPanes view={view} rowContext={rowContext} />}
					{noUpgrades && (
						<EmptyState title={i18n.t('upgrades_tab.results.empty_no_upgrades')} body={i18n.t('upgrades_tab.results.empty_no_upgrades_body')} />
					)}
					{run.result.substitutions.length > 0 && <SubstitutionsList substitutions={run.result.substitutions} />}
				</>
			);
		}
	}
});
