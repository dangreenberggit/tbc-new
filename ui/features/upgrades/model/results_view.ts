/**
 * Which rows each results pane shows: an "Upgrades" pane plus one pane per slot
 * with a row, each split into its main table and its below-cutoff group. Pure.
 */

import { type SimSlotName, simSlotsForPoolSlot } from './engine/pool';
import type { RankedItem, Ranking } from './engine/rank';
import { SIM_ORDER } from './engine/slots';
import { applyView, rankableSetPotential, type ViewResult, type ViewRow } from './engine/view';
import type { DpsSortKey } from './results_columns';
import type { RunState, StoppedRanking } from './run_state';
import { sourceKeysMatching, type SourceOption, sourceOptions } from './settings_pool';

export const SHOPPING_LIST_TAB = 'shopping-list';

export type ResultsTabId = typeof SHOPPING_LIST_TAB | SimSlotName;

/**
 * `slotChoice` is set on every weapon row and wherever a pool slot maps to
 * two sim slots. Casting `row.slot` instead is unsound: `weapon`, `finger`
 * and `trinket` are pool slots, not sim slots.
 */
export const effectiveSlot = (row: Pick<RankedItem, 'slot' | 'slotChoice'>): SimSlotName => row.slotChoice ?? simSlotsForPoolSlot(row.slot)[0]!;

/** One item can rank in two slots (a ring in either finger), so the item id alone is not unique. */
export const rowKey = (row: Pick<RankedItem, 'itemId' | 'slot'>): string => `${row.itemId}:${row.slot}`;

/**
 * A view as the results area renders it. `tabSlots` keeps the slots from before a
 * display filter, so a filter never removes a pane. The source-cut fields record
 * what "Filter by source" removed, for `paneRows`' empty text.
 */
export type ResultsViewResult = ViewResult & {
	tabSlots?: readonly SimSlotName[];
	sourcesHidden?: true;
	slotsBeforeSourceCut?: readonly SimSlotName[];
	panesWithMainBeforeSourceCut?: readonly ResultsTabId[];
};

/**
 * The slot tabs: every slot with a row, in sim order, counted by its above-cutoff
 * rows. A slot with none, or one a display filter emptied, keeps its tab at 0 so
 * the user can open it and see why.
 */
export function slotTabs(view: ResultsViewResult): Array<{ id: SimSlotName; count: number }> {
	const counts = new Map<SimSlotName, number>(view.tabSlots?.map(slot => [slot, 0]));
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

/** A row a pane's main table shows: one that meets the cutoff, or a BiS-list row that misses it and is not owned (`paneRows`). */
const inMainTable = (row: ViewRow): boolean => !row.belowCutoffInView || (!row.owned && onBisList(row));

export type PaneRows = {
	main: ViewRow[];
	notUpgrades: ReadonlySet<string>;
	belowCutoff: ViewRow[];
	emptyReason: PaneEmptyReason;
};

/** What a pane says when it shows no row: beside a below-cutoff group with rows, any such text would be false (`paneRows`). */
export type PaneEmptyReason = 'no-source-row' | 'no-upgrades';

/**
 * One pane's rows. The main table holds the rows that meet the cutoff plus the
 * BiS-list rows that miss it (`notUpgrades`); owned rows that miss it are dropped,
 * as a re-simmed owned item's delta is about 0 by construction. `emptyReason` is
 * `no-source-row` only when "Filter by source" emptied the pane. No reason says a
 * slot has no BiS-list item: the run cuts candidates before the sim.
 */
export function paneRows(view: ResultsViewResult, tab: ResultsTabId): PaneRows {
	const rows = tab === SHOPPING_LIST_TAB ? view.rows : view.rows.filter(row => effectiveSlot(row) === tab);
	const missed = rows.filter(row => row.belowCutoffInView && !row.owned);
	const shownAnyway = missed.filter(onBisList);
	const main = rows.filter(inMainTable);
	const hadRowBeforeSourceCut = tab === SHOPPING_LIST_TAB || view.slotsBeforeSourceCut?.includes(tab) === true;
	const sourceCutEmptied = (rows.length === 0 && hadRowBeforeSourceCut) || (main.length === 0 && view.panesWithMainBeforeSourceCut?.includes(tab) === true);
	const emptyReason: PaneEmptyReason = view.sourcesHidden === true && sourceCutEmptied ? 'no-source-row' : 'no-upgrades';
	return {
		main,
		notUpgrades: new Set(shownAnyway.map(rowKey)),
		belowCutoff: missed.filter(row => !onBisList(row)),
		emptyReason,
	};
}

/** The rows a running table shows: only measured rows, best first. */
export const landedRows = (rows: readonly RankedItem[]): RankedItem[] => rows.filter(row => row.simmed !== false).sort((a, b) => b.deltaDps - a.deltaDps);

/**
 * A stopped run's rows as a view. `applyView` takes only a complete ranking
 * (`Ranking.complete`), so a partial lists its simmed rows in engine order, split
 * on the engine's own cutoff verdict.
 */
export function stoppedView(result: StoppedRanking): ViewResult {
	const rows: ViewRow[] = result.items.filter(row => row.simmed !== false).map(row => ({ ...row, belowCutoffInView: row.belowCutoff }));
	const shortlist = rows.filter(row => !row.belowCutoffInView);
	return { rows, shortlist, belowCutoffCount: rows.length - shortlist.length, pinBisAvailable: false };
}

/** A finished run's view toggles. They reshape a measured ranking, so they are not run settings and never mark a result stale. */
export type ViewToggles = { withSetPotential: boolean; onlyBis: boolean };

export const NO_VIEW_TOGGLES: ViewToggles = { withSetPotential: false, onlyBis: false };

/** Whether BiS only has anything to keep. */
export const hasBisRows = (ranking: Pick<Ranking, 'items'>): boolean => ranking.items.some(onBisList);

/**
 * The toggles the tab shows for `run`: both on a finished run only, and BiS
 * only only when some row is on a BiS list.
 */
export const offeredToggles = (run: RunState): ViewToggles =>
	run.status === 'done' ? { withSetPotential: true, onlyBis: hasBisRows(run.result) } : NO_VIEW_TOGGLES;

/** The toggles that act, given the ones offered: one the tab does not show changes nothing, so a hidden control never filters rows. */
export const appliedToggles = (offered: ViewToggles, toggles: ViewToggles): ViewToggles => ({
	withSetPotential: offered.withSetPotential && toggles.withSetPotential,
	onlyBis: offered.onlyBis && toggles.onlyBis,
});

/**
 * A view cut to its BiS-list rows. Each row's cutoff verdict depends on that
 * row alone, so dropping rows changes only the count below the cutoff. Every
 * slot of the whole view keeps its tab.
 */
function bisOnlyView(view: ViewResult): ResultsViewResult {
	const rows = view.rows.filter(onBisList);
	const shortlist = view.shortlist.filter(onBisList);
	const tabSlots = [...new Set(view.rows.map(effectiveSlot))];
	return { ...view, rows, shortlist, belowCutoffCount: rows.length - shortlist.length, tabSlots };
}

/**
 * The sources "Filter by source" lists: `sourceOptions` of the view's rows before
 * the source cut, keyed and counted as the pre-run Sources dialog does.
 */
export type ViewSourceOptions = { raids: SourceOption[]; other: SourceOption[] };

/** The keys of the sources a view offers, raids first. */
export const offeredSourceKeys = (options: ViewSourceOptions): string[] => [...options.raids, ...options.other].map(option => option.key);

/** The hidden sources that act on a view offering `options`: a hidden source the view does not offer hides nothing there. */
export const offeredHidden = (options: ViewSourceOptions, hidden: readonly string[]): string[] =>
	offeredSourceKeys(options).filter(key => hidden.includes(key));

/** The hidden sources with `key` hidden if it was shown, and shown if it was hidden. */
export const withViewSourceToggled = (hidden: readonly string[], key: string): string[] =>
	hidden.includes(key) ? hidden.filter(k => k !== key) : [...hidden, key];

/**
 * The hidden sources after Hide all: every source the view offers now. A
 * hidden source the view does not offer stays hidden; one that only a later
 * run offers is shown then until the user hides it.
 */
export const withOfferedSourcesHidden = (hidden: readonly string[], offered: readonly string[]): string[] => [...new Set([...hidden, ...offered])];

/**
 * A view cut to the rows of the sources not in `hidden`. A row stays while any
 * source key it matches is shown, so an item from two raids stays while either is.
 * As with `bisOnlyView`, only the below-cutoff count changes and every slot keeps its tab.
 */
export function sourcesView(view: ResultsViewResult, hidden: readonly string[]): ResultsViewResult {
	const acting = offeredHidden(sourceOptions(view.rows), hidden);
	const kept = (row: ViewRow) => sourceKeysMatching(row).some(key => !acting.includes(key));
	const rows = view.rows.filter(kept);
	if (rows.length === view.rows.length) return view;
	const shortlist = view.shortlist.filter(kept);
	const tabSlots = view.tabSlots ?? [...new Set(view.rows.map(effectiveSlot))];
	const slotsBeforeSourceCut = [...new Set(view.rows.map(effectiveSlot))];
	const mainBefore = view.rows.filter(inMainTable);
	const panesWithMainBeforeSourceCut: ResultsTabId[] = mainBefore.length > 0 ? [SHOPPING_LIST_TAB, ...new Set(mainBefore.map(effectiveSlot))] : [];
	return {
		...view,
		rows,
		shortlist,
		belowCutoffCount: rows.length - shortlist.length,
		tabSlots,
		sourcesHidden: true,
		slotsBeforeSourceCut,
		panesWithMainBeforeSourceCut,
	};
}

/**
 * The view a settled run renders under `applied` (from `appliedToggles`),
 * before "Filter by source" cuts it (`sourcesView`); nothing before a run
 * settles.
 */
export function resultsViewFor(run: RunState, { withSetPotential, onlyBis }: ViewToggles): ResultsViewResult | undefined {
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
 * What the ΔDPS column sorts on: with Set potential, the same ΔDPS plus set
 * credit `applyView` ranked on (`view.ts` `sortKeyFor`), so a column sort
 * cannot disagree with the view's own order; else the bare ΔDPS (undefined).
 */
export function dpsSortKeyFor(ranking: Pick<Ranking, 'cutoff'> | undefined, withSetPotential: boolean): DpsSortKey | undefined {
	if (!ranking || !withSetPotential) return undefined;
	return row => row.deltaDps + rankableSetPotential(row, ranking.cutoff);
}
