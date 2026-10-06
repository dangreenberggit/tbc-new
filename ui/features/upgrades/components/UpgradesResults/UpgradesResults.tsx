import i18n from '@i18n/config';
import { useSimHost } from '@sim/context/SimHostContext';
import { useMemo, useState } from 'react';

import { appliedToggles, dpsSortKeyFor, landedRows, NO_VIEW_TOGGLES, offeredToggles, resultsViewFor } from '../../model/results_view';
import type { RunState } from '../../model/run_reducer';
import { rowTagIndex, type SetOption } from '../../model/settings_pool';
import { EmptyState } from '../EmptyState';
import { ResultsPanes } from '../ResultsPanes';
import { ProvisionalResultsTable, type RowContext } from '../ResultsTable';
import { SubstitutionsList } from '../SubstitutionsList';
import { ViewToggle, ViewToggles } from '../ViewToggles';

export interface UpgradesResultsProps {
	run: RunState;
	/** The sim sets selected now; a row in one of them carries its name (ticket 430). */
	selectedSets: readonly SetOption[];
}

/**
 * The results area: the rows landed so far while a run is in flight, the
 * view toggles, sub-tabs and dropped candidates once it settles, or what to
 * say in their place. The toggles are this area's own state: they reshape a
 * ranking already measured, so they are not run settings.
 */
export const UpgradesResults = ({ run, selectedSets }: UpgradesResultsProps) => {
	const { sim } = useSimHost();
	const [toggles, setToggles] = useState(NO_VIEW_TOGGLES);
	const offered = offeredToggles(run);
	const { withSetPotential, onlyBis } = appliedToggles(run, toggles);
	const ranking = run.status === 'done' || run.status === 'stopped' ? run.result : undefined;
	const measuredOn = run.status === 'running' || run.status === 'done' || run.status === 'stopped' ? run.measuredOn : undefined;
	// Memoised because every `ResultRow` is: a new context on each landing row would render every row again.
	const rowContext = useMemo<RowContext>(
		() => ({
			itemOf: itemId => sim.db.getItemById(itemId),
			tip: { ranking, wornItemIds: measuredOn?.wornItemIds, specId: measuredOn?.specId, withSetPotential },
			tagsOf: rowTagIndex(selectedSets),
			dpsKey: dpsSortKeyFor(ranking, withSetPotential),
		}),
		[sim, ranking, measuredOn, withSetPotential, selectedSets],
	);
	// Memoised for the same rows: `applyView` builds new row objects on every call.
	const view = useMemo(() => resultsViewFor(run, { withSetPotential, onlyBis }), [run, withSetPotential, onlyBis]);

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
			const listPhase = i18n.t(`common.phases.${run.result.assumptions.maxPhase}`);
			return (
				<>
					{offered.withSetPotential && (
						<ViewToggles>
							<ViewToggle
								testId="upgrades-view-set-potential"
								label={i18n.t('upgrades_tab.view.set_potential')}
								tooltip={i18n.t('upgrades_tab.view.set_potential_tooltip')}
								checked={toggles.withSetPotential}
								onChange={checked => setToggles(current => ({ ...current, withSetPotential: checked }))}
							/>
							{offered.onlyBis && (
								<ViewToggle
									testId="upgrades-view-only-bis"
									label={i18n.t('upgrades_tab.view.only_bis')}
									tooltip={`${i18n.t('upgrades_tab.view.only_bis_tooltip')} ${i18n.t('upgrades_tab.view.only_bis_qualifier', { phase: listPhase })}`}
									checked={toggles.onlyBis}
									onChange={checked => setToggles(current => ({ ...current, onlyBis: checked }))}
								/>
							)}
						</ViewToggles>
					)}
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
