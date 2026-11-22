/**
 * Which rows each results pane shows: an "Upgrades" pane plus one pane per slot
 * with a row, each split into its main table and its below-cutoff group. Pure.
 */

import { type SimSlotName, simSlotsForPoolSlot } from './engine/pool';
import type { RankedItem, Ranking } from './engine/rank';
import { rankableSetPotential } from './engine/set-potential';
import { SIM_ORDER } from './engine/slots';
import { applyView, type ViewResult, type ViewRow } from './engine/view';
import type { DpsSortKey } from './results_columns';
import type { RunState, StoppedRanking } from './run_state';
import { sourceKeysMatching, type SourceOption, sourceOptions } from './settings_pool';

/** The first pane, labeled "Upgrades": every slot's rows. */
export const ALL_SLOTS_PANE = 'all-slots';

export type PaneId = typeof ALL_SLOTS_PANE | SimSlotName;

/**
 * Do not cast `row.slot`: `weapon`, `finger` and `trinket` each cover two sim
 * slots, and `slotChoice` says which one the row is for.
 */
export const effectiveSlot = (row: Pick<RankedItem, 'slot' | 'slotChoice'>): SimSlotName => row.slotChoice ?? simSlotsForPoolSlot(row.slot)[0]!;

/** One item can rank in two slots (a ring in either finger), so the item id alone is not unique. */
export const rowKey = (row: Pick<RankedItem, 'itemId' | 'slot'>): string => `${row.itemId}:${row.slot}`;

/**
 * `paneSlots` keeps the slots from before a display filter, so a filter never
 * removes a pane. The `...BeforeSourceFilter` fields let `paneRows` tell when
 * "Filter by source" emptied a pane.
 */
export type ResultsViewResult = ViewResult & {
	paneSlots?: readonly SimSlotName[];
	sourcesHidden?: true;
	slotsBeforeSourceFilter?: readonly SimSlotName[];
	panesWithMainBeforeSourceFilter?: readonly PaneId[];
};

/** A slot with no row above the cutoff keeps its tab at 0, so the user can open it and see why it is empty. */
export function slotTabs(view: ResultsViewResult): Array<{ id: SimSlotName; count: number }> {
	const counts = new Map<SimSlotName, number>(view.paneSlots?.map(slot => [slot, 0]));
	for (const row of view.rows) {
		const slot = effectiveSlot(row);
		counts.set(slot, (counts.get(slot) ?? 0) + (row.belowCutoffInView ? 0 : 1));
	}
	return SIM_ORDER.flatMap(slot => {
		const count = counts.get(slot as SimSlotName);
		return count === undefined ? [] : [{ id: slot as SimSlotName, count }];
	});
}

/** On some phase's BiS list: a BiS or an Alt tag. */
const onBisList = (row: Pick<RankedItem, 'bisTags'>): boolean => row.bisTags.length > 0;

const inMainTable = (row: ViewRow): boolean => !row.belowCutoffInView || (!row.owned && onBisList(row));

export type PaneRows = {
	main: ViewRow[];
	notUpgradeKeys: ReadonlySet<string>;
	belowCutoff: ViewRow[];
	emptyReason: PaneEmptyReason;
};

/** The text of an empty pane. It shows only when the below-cutoff group is empty too, as next to rows it would be false. */
export type PaneEmptyReason = 'no-source-row' | 'no-upgrades';

/**
 * The main table also shows BiS-list rows below the cutoff, listed in
 * `notUpgradeKeys`. Worn rows below the cutoff are dropped: the player already
 * wears the item, so its gain is about 0. There is no empty text for "no BiS-list
 * item", because the run may have left such an item out before simming.
 */
export function paneRows(view: ResultsViewResult, pane: PaneId): PaneRows {
	const rows = pane === ALL_SLOTS_PANE ? view.rows : view.rows.filter(row => effectiveSlot(row) === pane);
	const missed = rows.filter(row => row.belowCutoffInView && !row.owned);
	const shownAnyway = missed.filter(onBisList);
	const main = rows.filter(inMainTable);
	const hadRowBeforeSourceFilter = pane === ALL_SLOTS_PANE || view.slotsBeforeSourceFilter?.includes(pane) === true;
	const sourceFilterEmptied =
		(rows.length === 0 && hadRowBeforeSourceFilter) || (main.length === 0 && view.panesWithMainBeforeSourceFilter?.includes(pane) === true);
	const emptyReason: PaneEmptyReason = view.sourcesHidden === true && sourceFilterEmptied ? 'no-source-row' : 'no-upgrades';
	return {
		main,
		notUpgradeKeys: new Set(shownAnyway.map(rowKey)),
		belowCutoff: missed.filter(row => !onBisList(row)),
		emptyReason,
	};
}

export const simmedBestFirst = (rows: readonly RankedItem[]): RankedItem[] => rows.filter(row => row.simmed !== false).sort((a, b) => b.deltaDps - a.deltaDps);

/** `applyView` takes only a complete ranking, so a stopped run builds its view here. */
export function stoppedView(result: StoppedRanking): ViewResult {
	const rows: ViewRow[] = result.items.filter(row => row.simmed !== false).map(row => ({ ...row, belowCutoffInView: row.belowCutoff }));
	const shortlist = rows.filter(row => !row.belowCutoffInView);
	return { rows, shortlist, belowCutoffCount: rows.length - shortlist.length, pinBisAvailable: false };
}

/** These only reshape a measured ranking, so changing one never marks a result stale. */
export type ViewToggleState = { withSetPotential: boolean; onlyBis: boolean };

export const NO_VIEW_TOGGLES: ViewToggleState = { withSetPotential: false, onlyBis: false };

export const hasBisRows = (ranking: Pick<Ranking, 'items'>): boolean => ranking.items.some(onBisList);

export const offeredToggles = (run: RunState): ViewToggleState =>
	run.status === 'done' ? { withSetPotential: true, onlyBis: hasBisRows(run.result) } : NO_VIEW_TOGGLES;

/** A toggle the tab does not show changes nothing, so a hidden control never filters rows. */
export const appliedToggles = (offered: ViewToggleState, toggles: ViewToggleState): ViewToggleState => ({
	withSetPotential: offered.withSetPotential && toggles.withSetPotential,
	onlyBis: offered.onlyBis && toggles.onlyBis,
});

/** Whether a row meets the cutoff depends on that row alone, so dropping rows only changes the below-cutoff count. */
function bisOnlyView(view: ViewResult): ResultsViewResult {
	const rows = view.rows.filter(onBisList);
	const shortlist = view.shortlist.filter(onBisList);
	const paneSlots = [...new Set(view.rows.map(effectiveSlot))];
	return { ...view, rows, shortlist, belowCutoffCount: rows.length - shortlist.length, paneSlots };
}

/** Built by `sourceOptions`, so "Filter by source" uses the same keys and counts as the pre-run Sources dialog. */
export type ViewSourceOptions = { raids: SourceOption[]; other: SourceOption[] };

export const offeredSourceKeys = (options: ViewSourceOptions): string[] => [...options.raids, ...options.other].map(option => option.key);

export const hiddenOfferedSourcesOf = (options: ViewSourceOptions, hidden: readonly string[]): string[] =>
	offeredSourceKeys(options).filter(key => hidden.includes(key));

export const withHiddenSourceToggled = (hidden: readonly string[], key: string): string[] =>
	hidden.includes(key) ? hidden.filter(k => k !== key) : [...hidden, key];

/**
 * Hide all keeps hidden the sources this view does not offer. A source that only
 * a later run offers is shown until the user hides it.
 */
export const withOfferedSourcesHidden = (hidden: readonly string[], offered: readonly string[]): string[] => [...new Set([...hidden, ...offered])];

/** A row stays while any of its sources is shown, so an item from two raids stays while either is. */
export function sourcesView(view: ResultsViewResult, hidden: readonly string[]): ResultsViewResult {
	const hiddenOfferedSources = hiddenOfferedSourcesOf(sourceOptions(view.rows), hidden);
	const kept = (row: ViewRow) => sourceKeysMatching(row).some(key => !hiddenOfferedSources.includes(key));
	const rows = view.rows.filter(kept);
	if (rows.length === view.rows.length) return view;
	const shortlist = view.shortlist.filter(kept);
	const paneSlots = view.paneSlots ?? [...new Set(view.rows.map(effectiveSlot))];
	const slotsBeforeSourceFilter = [...new Set(view.rows.map(effectiveSlot))];
	const mainBefore = view.rows.filter(inMainTable);
	const panesWithMainBeforeSourceFilter: PaneId[] = mainBefore.length > 0 ? [ALL_SLOTS_PANE, ...new Set(mainBefore.map(effectiveSlot))] : [];
	return {
		...view,
		rows,
		shortlist,
		belowCutoffCount: rows.length - shortlist.length,
		paneSlots,
		sourcesHidden: true,
		slotsBeforeSourceFilter,
		panesWithMainBeforeSourceFilter,
	};
}

/** Takes the toggles from `appliedToggles`. "Filter by source" applies after this, in `sourcesView`. */
export function resultsViewFor(run: RunState, { withSetPotential, onlyBis }: ViewToggleState): ResultsViewResult | undefined {
	switch (run.status) {
		case 'done': {
			const view = applyView(run.result, { withSetPotential });
			return onlyBis ? bisOnlyView(view) : view;
		}
		case 'stopped':
			return stoppedView(run.result);
		default:
			return undefined;
	}
}

/**
 * With Set potential on, the ΔDPS column sorts on the same value the view ranked
 * by (`sortKeyFor` in `view.ts`), so a column sort cannot disagree with the view's
 * own order.
 */
export function dpsSortKeyFor(ranking: Pick<Ranking, 'cutoff'> | undefined, withSetPotential: boolean): DpsSortKey | undefined {
	if (!ranking || !withSetPotential) return undefined;
	return row => row.deltaDps + rankableSetPotential(row, ranking.cutoff);
}
