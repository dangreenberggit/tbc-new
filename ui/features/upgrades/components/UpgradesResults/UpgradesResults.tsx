import i18n from '@i18n/config';
import { memo } from 'react';

import { useResultsView } from '../../hooks/useResultsView';
import { poolSourceFor } from '../../model/data/data';
import type { SpecId } from '../../model/engine/types';
import type { RunState } from '../../model/run_state';
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
	/** The spec the run ranked for; with the run's phase it tells a phase with no candidate list from a list with no upgrades (ticket 515). */
	specId?: SpecId;
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
export const UpgradesResults = memo(({ run, selectedSets, specId }: UpgradesResultsProps) => {
	const { toggles, offered, setToggle, rowContext, view } = useResultsView(run, selectedSets);

	switch (run.status) {
		case 'idle':
			return (
				<EmptyState
					title={i18n.t('upgrades_tab.results.empty_no_ranking', { ns: 'upgrades' })}
					body={i18n.t('upgrades_tab.results.empty_no_ranking_body', { ns: 'upgrades' })}
				/>
			);
		case 'running':
			return run.landedRows.length > 0 ? (
				<ProvisionalResultsTable landedRows={run.landedRows} rowContext={rowContext} />
			) : (
				<EmptyState body={i18n.t('upgrades_tab.results.rows_pending', { ns: 'upgrades' })} />
			);
		case 'error':
			// The status line's alert region says what failed.
			return null;
		case 'done':
		case 'stopped': {
			const hasRows = view !== undefined && view.rows.length > 0;
			const { maxPhase } = run.result.assumptions;
			// Checked before any other empty state: Phase 1 has no list by design (`packages/core/test/pool-file.test.ts`), so "No upgrades found" would be wrong.
			const poolMissing = run.status === 'done' && !hasRows && specId !== undefined && poolSourceFor(specId, maxPhase) === undefined;
			if (poolMissing) {
				return (
					<>
						<ViewToggles offered={offered} toggles={toggles} maxPhase={maxPhase} onChange={setToggle} />
						<EmptyState
							title={i18n.t('upgrades_tab.results.empty_no_phase_list', { ns: 'upgrades', phase: maxPhase })}
							body={i18n.t('upgrades_tab.results.empty_no_phase_list_body', { ns: 'upgrades', phase: maxPhase })}
						/>
					</>
				);
			}
			// A stopped run with no finished row shows no empty state: the status line already says so.
			const noUpgrades = !hasRows && run.status === 'done';
			return (
				<>
					<ViewToggles offered={offered} toggles={toggles} maxPhase={maxPhase} onChange={setToggle} />
					{hasRows && <ResultsPanes view={view} rowContext={rowContext} />}
					{noUpgrades && (
						<EmptyState
							title={i18n.t('upgrades_tab.results.empty_no_upgrades', { ns: 'upgrades' })}
							body={i18n.t('upgrades_tab.results.empty_no_upgrades_body', { ns: 'upgrades' })}
						/>
					)}
					{run.result.substitutions.length > 0 && <SubstitutionsList substitutions={run.result.substitutions} />}
				</>
			);
		}
	}
});
