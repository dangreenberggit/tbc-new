import { useSimHost } from '@sim/context/SimHostContext';
import { useMemo } from 'react';

import type { RowContext } from '../components/ResultsTable';
import {
	appliedToggles,
	dpsSortKeyFor,
	hiddenOfferedSourcesOf,
	offeredToggles,
	resultsViewFor,
	type ResultsViewResult,
	sourcesView,
	type ViewSourceOptions,
	type ViewToggleState,
} from '../model/results_view';
import type { RunState } from '../model/run_state';
import { type GearSetOption, rowBadgeIndex, sourceOptions } from '../model/settings_pool';
import { selectHiddenSources, selectViewToggles } from '../model/upgrades_store';
import { useUpgradesStore } from './useUpgradesStore';

const NO_GEAR_SETS: readonly GearSetOption[] = [];

export type ResultsView = {
	/** The view toggles as the user set them, and the ones the tab shows for this run. */
	toggles: ViewToggleState;
	offered: ViewToggleState;
	setToggle: (toggle: keyof ViewToggleState, on: boolean) => void;
	/** The sources "Filter by source" offers: those of the settled view's rows before that filter applies; none before a run settles. */
	sourceOptions: ViewSourceOptions;
	/** The hidden sources as stored, which may name one this view does not offer. */
	hiddenSources: readonly string[];
	toggleHiddenSource: (key: string) => void;
	setHiddenSources: (keys: readonly string[]) => void;
	rowContext: RowContext;
	/** Undefined before a run settles. */
	view: ResultsViewResult | undefined;
};

/**
 * What the results area renders from a run: the view a settled run shows under the
 * view toggles, and the context its rows share. The toggles reshape a ranking
 * already measured, not the run; the tab store saves them with the settings.
 */
export function useResultsView(run: RunState, bisHeadingsOf: (itemId: number) => readonly string[]): ResultsView {
	const { sim } = useSimHost();
	const toggles = useUpgradesStore(selectViewToggles);
	const setToggle = useUpgradesStore(state => state.setViewToggle);
	const hiddenSources = useUpgradesStore(selectHiddenSources);
	const toggleHiddenSource = useUpgradesStore(state => state.toggleHiddenSource);
	const setHiddenSources = useUpgradesStore(state => state.setHiddenSources);
	const offered = offeredToggles(run);
	const { withSetPotential, onlyBis } = appliedToggles(offered, toggles);
	const ranking = run.status === 'done' || run.status === 'stopped' ? run.result : undefined;
	const measuredOn = run.status === 'running' || run.status === 'done' || run.status === 'stopped' ? run.measuredOn : undefined;
	// The gear sets the run was ranked with, not the gear sets selected now: a phase change after the run selects the new
	// phase's gear sets. Memoised on them alone, so a row's badges keep their identity and its memoised name cell holds.
	const rankedGearSets = measuredOn?.selectedGearSets ?? NO_GEAR_SETS;
	const gearSetBadgesOf = useMemo(() => rowBadgeIndex(rankedGearSets), [rankedGearSets]);
	// Memoised for the same rows: `applyView` builds new row objects on every call. The source filter runs on this
	// view in a memo of its own, so ticking a source does not run `applyView` again.
	const viewBeforeSourceFilter = useMemo(() => resultsViewFor(run, { withSetPotential, onlyBis }), [run, withSetPotential, onlyBis]);
	const offeredSources = useMemo(() => sourceOptions(viewBeforeSourceFilter?.rows ?? []), [viewBeforeSourceFilter]);
	const view = useMemo(
		() => (viewBeforeSourceFilter && hiddenSources.length > 0 ? sourcesView(viewBeforeSourceFilter, hiddenSources) : viewBeforeSourceFilter),
		[viewBeforeSourceFilter, hiddenSources],
	);
	// Only the hidden sources this view offers act, so a source hidden in an earlier run hides nothing here, in a row or a cell.
	const hiddenOfferedSources = useMemo(() => hiddenOfferedSourcesOf(offeredSources, hiddenSources), [offeredSources, hiddenSources]);
	// Memoised because every `ResultRow` is: a new context on each new row would render every row again.
	const rowContext = useMemo<RowContext>(
		() => ({
			itemOf: itemId => sim.db.getItemById(itemId),
			sim,
			rankingContext: { ranking, wornItemIds: measuredOn?.wornItemIds, specId: measuredOn?.specId, withSetPotential },
			gearSetBadgesOf,
			bisHeadingsOf,
			dpsKey: dpsSortKeyFor(ranking, withSetPotential),
			hiddenSources: hiddenOfferedSources,
		}),
		[sim, ranking, measuredOn, withSetPotential, gearSetBadgesOf, bisHeadingsOf, hiddenOfferedSources],
	);

	return { toggles, offered, setToggle, sourceOptions: offeredSources, hiddenSources, toggleHiddenSource, setHiddenSources, rowContext, view };
}
