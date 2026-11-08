import i18n from '@i18n/config';
import { useOptionalSimHost } from '@sim/context/SimHostContext';
import { memo } from 'react';

import { useResultsView } from '../../hooks/useResultsView';
import { bisTagPhaseFor, poolFor } from '../../model/data/data';
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
	/** The headings a row's "BiS" badge names when the row is in no selected set (ticket 810). */
	bisHeadingsOf?: (itemId: number) => readonly string[];
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
export const UpgradesResults = memo(({ run, selectedSets, bisHeadingsOf, specId }: UpgradesResultsProps) => {
	const { toggles, offered, setToggle, sourceOptions, hiddenSources, toggleViewSource, setViewSources, rowContext, view } = useResultsView(
		run,
		selectedSets,
		bisHeadingsOf,
	);
	const host = useOptionalSimHost();

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
			const bisTagPhase = host?.sim.db ? bisTagPhaseFor(host, host.individualConfig.presets.gear, maxPhase)?.tagsFromPhase : undefined;
			const viewToggles = (
				<ViewToggles
					offered={offered}
					toggles={toggles}
					maxPhase={maxPhase}
					bisTagPhase={bisTagPhase}
					onChange={setToggle}
					sources={{ options: sourceOptions, hidden: hiddenSources, onToggle: toggleViewSource, onSetAll: setViewSources }}
				/>
			);
			// Checked before any other empty state: with no candidate list at this phase, "No items to show" would not say why.
			const poolMissing =
				run.status === 'done' &&
				!hasRows &&
				specId !== undefined &&
				host !== null &&
				poolFor(host, host.individualConfig.presets.gear, maxPhase).length === 0;
			if (poolMissing) {
				return (
					<>
						{viewToggles}
						<EmptyState
							title={i18n.t('upgrades_tab.results.empty_no_phase_list', { ns: 'upgrades', phase: maxPhase })}
							body={i18n.t('upgrades_tab.results.empty_no_phase_list_body', { ns: 'upgrades', phase: maxPhase })}
						/>
					</>
				);
			}
			// A table "Filter by source" emptied keeps its panes, so every slot keeps its tab (ticket 614) and each pane
			// can say why it is empty (`paneRows`).
			const filteredEmpty = !hasRows && view?.sourcesHidden === true;
			// A stopped run with no finished row shows no empty state: the status line already says so.
			const noUpgrades = !hasRows && !filteredEmpty && run.status === 'done';
			return (
				<>
					{viewToggles}
					{view !== undefined && (hasRows || filteredEmpty) && <ResultsPanes view={view} rowContext={rowContext} />}
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
