import { useSimHost } from '@sim/context/SimHostContext';
import { useMemo } from 'react';

import type { RowContext } from '../components/ResultsTable';
import { appliedToggles, dpsSortKeyFor, offeredToggles, type ResultsViewResult, resultsViewFor, type ViewToggles } from '../model/results_view';
import type { RunState } from '../model/run_state';
import { rowTagIndex, type SetOption } from '../model/settings_pool';
import { selectViewToggles } from '../model/upgrades_store';
import { useUpgradesStore } from './useUpgradesStore';

export type ResultsView = {
	/** The view toggles as the user set them, and the ones the tab shows for this run. */
	toggles: ViewToggles;
	offered: ViewToggles;
	setToggle: (toggle: keyof ViewToggles, on: boolean) => void;
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
	const offered = offeredToggles(run);
	const { withSetPotential, onlyBis } = appliedToggles(offered, toggles);
	const ranking = run.status === 'done' || run.status === 'stopped' ? run.result : undefined;
	const measuredOn = run.status === 'running' || run.status === 'done' || run.status === 'stopped' ? run.measuredOn : undefined;
	// Memoised on the selection alone, so a row's tags keep their identity and its memoised name cell holds.
	const tagsOf = useMemo(() => rowTagIndex(selectedSets), [selectedSets]);
	// Memoised because every `ResultRow` is: a new context on each landing row would render every row again.
	const rowContext = useMemo<RowContext>(
		() => ({
			itemOf: itemId => sim.db.getItemById(itemId),
			sim,
			tip: { ranking, wornItemIds: measuredOn?.wornItemIds, specId: measuredOn?.specId, withSetPotential },
			tagsOf,
			dpsKey: dpsSortKeyFor(ranking, withSetPotential),
		}),
		[sim, ranking, measuredOn, withSetPotential, tagsOf],
	);
	// Memoised for the same rows: `applyView` builds new row objects on every call.
	const view = useMemo(() => resultsViewFor(run, { withSetPotential, onlyBis }), [run, withSetPotential, onlyBis]);

	return { toggles, offered, setToggle, rowContext, view };
}
