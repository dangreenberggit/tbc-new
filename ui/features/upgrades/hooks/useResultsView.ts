import { useSimHost } from '@sim/context/SimHostContext';
import { useMemo } from 'react';

import type { RowContext } from '../components/ResultsTable';
import {
	appliedToggles,
	dpsSortKeyFor,
	offeredHidden,
	offeredToggles,
	resultsViewFor,
	type ResultsViewResult,
	sourcesView,
	type ViewSourceOptions,
	type ViewToggles,
} from '../model/results_view';
import type { RunState } from '../model/run_state';
import { rowTagIndex, type SetOption, sourceOptions } from '../model/settings_pool';
import { selectHiddenSources, selectViewToggles } from '../model/upgrades_store';
import { useUpgradesStore } from './useUpgradesStore';

export type ResultsView = {
	/** The view toggles as the user set them, and the ones the tab shows for this run. */
	toggles: ViewToggles;
	offered: ViewToggles;
	setToggle: (toggle: keyof ViewToggles, on: boolean) => void;
	/** The sources "Filter by source" offers: those of the settled view's rows before the source cut; none before a run settles. */
	sourceOptions: ViewSourceOptions;
	/** The hidden sources as stored, which may name one this view does not offer. */
	hiddenSources: readonly string[];
	toggleViewSource: (key: string) => void;
	setViewSources: (keys: readonly string[]) => void;
	rowContext: RowContext;
	/** Undefined before a run settles. */
	view: ResultsViewResult | undefined;
};

/**
 * What the results area renders from a run: the view a settled run shows
 * under the view toggles, and the context its rows share. The toggles are
 * view state of the area: they reshape a ranking already measured and are not
 * run settings. They live in the tab store, which saves them with the settings.
 */
export function useResultsView(run: RunState, selectedSets: readonly SetOption[]): ResultsView {
	const { sim } = useSimHost();
	const toggles = useUpgradesStore(selectViewToggles);
	const setToggle = useUpgradesStore(state => state.setViewToggle);
	const hiddenSources = useUpgradesStore(selectHiddenSources);
	const toggleViewSource = useUpgradesStore(state => state.toggleViewSource);
	const setViewSources = useUpgradesStore(state => state.setViewSources);
	const offered = offeredToggles(run);
	const { withSetPotential, onlyBis } = appliedToggles(offered, toggles);
	const ranking = run.status === 'done' || run.status === 'stopped' ? run.result : undefined;
	const measuredOn = run.status === 'running' || run.status === 'done' || run.status === 'stopped' ? run.measuredOn : undefined;
	// Memoised on the selection alone, so a row's tags keep their identity and its memoised name cell holds.
	const tagsOf = useMemo(() => rowTagIndex(selectedSets), [selectedSets]);
	// Memoised for the same rows: `applyView` builds new row objects on every call. The source cut runs on this view
	// in a memo of its own, so ticking a source does not run `applyView` again.
	const preCutView = useMemo(() => resultsViewFor(run, { withSetPotential, onlyBis }), [run, withSetPotential, onlyBis]);
	const offeredSources = useMemo(() => sourceOptions(preCutView?.rows ?? []), [preCutView]);
	const view = useMemo(() => (preCutView && hiddenSources.length > 0 ? sourcesView(preCutView, hiddenSources) : preCutView), [preCutView, hiddenSources]);
	// Only the hidden sources this view offers act, so a source hidden in an earlier run hides nothing here, in a row or a cell.
	const actingHidden = useMemo(() => offeredHidden(offeredSources, hiddenSources), [offeredSources, hiddenSources]);
	// Memoised because every `ResultRow` is: a new context on each landing row would render every row again.
	const rowContext = useMemo<RowContext>(
		() => ({
			itemOf: itemId => sim.db.getItemById(itemId),
			sim,
			tip: { ranking, wornItemIds: measuredOn?.wornItemIds, specId: measuredOn?.specId, withSetPotential },
			tagsOf,
			dpsKey: dpsSortKeyFor(ranking, withSetPotential),
			hiddenSources: actingHidden,
		}),
		[sim, ranking, measuredOn, withSetPotential, tagsOf, actingHidden],
	);

	return { toggles, offered, setToggle, sourceOptions: offeredSources, hiddenSources, toggleViewSource, setViewSources, rowContext, view };
}
