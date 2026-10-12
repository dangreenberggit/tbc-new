/**
 * Which rows each results pane shows, as the old tab chose them (cb561067
 * `upgrades_tab.tsx`): an "Upgrades" pane plus one pane per slot with a row,
 * each split into its main table and its below-cutoff group. Under BiS only, a
 * slot keeps its pane when the filter removes all its rows (`tabSlots`, ticket
 * 614). Pure; the panes render what this returns.
 */

import { setBonusNoiseFloorDps } from './engine/cutoff';
import { type SimSlotName, simSlotsForPoolSlot } from './engine/pool';
import type { RankedItem, Ranking } from './engine/rank';
import { SIM_ORDER } from './engine/slots';
import { applyView, rankableSetPotential, type ViewResult, type ViewRow } from './engine/view';
import type { DpsSortKey } from './results_columns';
import type { RunState, StoppedRanking } from './run_state';
import { type SourceOption, sourceMatches, sourceOptions, validSourceKeysOf } from './settings_pool';

export const SHOPPING_LIST_TAB = 'shopping-list';

export type ResultsTabId = typeof SHOPPING_LIST_TAB | SimSlotName;

/**
 * `slotChoice` is set only where a pool slot maps to two sim slots. Casting
 * `row.slot` instead is unsound: `weapon`, `finger` and `trinket` are pool
 * slots, not sim slots.
 */
export const effectiveSlot = (row: Pick<RankedItem, 'slot' | 'slotChoice'>): SimSlotName => row.slotChoice ?? simSlotsForPoolSlot(row.slot)[0]!;

/** One item can rank in two slots (a ring in either finger), so the item id alone is not unique. */
export const rowKey = (row: Pick<RankedItem, 'itemId' | 'slot'>): string => `${row.itemId}:${row.slot}`;

/**
 * A view as the results area renders it. `tabSlots` is set on a view that a
 * display filter cut down: it names the slots of the view before the cut, so
 * each keeps its tab. The old tab's rule (cb561067 `upgrades_tab.tsx`): "a
 * display filter must change which rows a pane shows, never which panes
 * exist" (ticket 614). `bisOnly` is set on a view cut to its BiS-list rows;
 * `sourcesHidden` on one that "Filter by source" cut by at least one row.
 */
export type ResultsViewResult = ViewResult & { tabSlots?: readonly SimSlotName[]; bisOnly?: true; sourcesHidden?: true };

/**
 * The slot tabs: every slot with a row, in sim order, counted by its
 * above-cutoff rows. A slot whose rows are all below the cutoff, or that a
 * display filter emptied, keeps its tab at 0, so the user can open it and see
 * why it is empty.
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

/** On some phase's BiS list, as the old tab's `isBisTagged` tested it: a BiS or an Alt tag. */
const onBisList = (row: Pick<RankedItem, 'bisTags'>): boolean => row.bisTags.length > 0;

export type PaneRows = { main: ViewRow[]; notUpgrades: ReadonlySet<string>; belowCutoff: ViewRow[]; noBisListRow: boolean };

/**
 * One pane's rows: its main table, the keys of the rows in that table that
 * miss the cutoff, and its below-cutoff group.
 *
 * The main table is the rows that meet the cutoff plus, by the owner's ruling
 * on ticket 528 (option A, 2026-10-11), the BiS-list rows that miss it, in the
 * view's order, so each sits where its gain puts it. `notUpgrades` marks those
 * rows; the slot counts and the export still read only the rows that meet the
 * cutoff (`slotTabs`, `view.shortlist`).
 *
 * Owned rows stay out of the below-cutoff group, and so out of the main table
 * when they miss the cutoff: an owned item is re-simmed into the slot it
 * already fills, so its delta is about 0 by construction and would only list
 * the gear the player wears.
 *
 * `noBisListRow` is true for a slot pane of a BiS-only view that has no row at
 * all, so the pane can say the slot has no BiS-list item instead of saying
 * every candidate simmed at or below the worn gear. A slot whose only BiS-list
 * row is owned and misses the cutoff does have one, so it stays false there.
 */
export function paneRows(view: ResultsViewResult, tab: ResultsTabId): PaneRows {
	const rows = tab === SHOPPING_LIST_TAB ? view.rows : view.rows.filter(row => effectiveSlot(row) === tab);
	const missed = rows.filter(row => row.belowCutoffInView && !row.owned);
	const shownAnyway = missed.filter(onBisList);
	return {
		main: rows.filter(row => !row.belowCutoffInView || shownAnyway.includes(row)),
		notUpgrades: new Set(shownAnyway.map(rowKey)),
		belowCutoff: missed.filter(row => !onBisList(row)),
		noBisListRow: view.bisOnly === true && tab !== SHOPPING_LIST_TAB && rows.length === 0,
	};
}

/** The rows a running table shows: only measured rows, best first. */
export const landedRows = (rows: readonly RankedItem[]): RankedItem[] => rows.filter(row => row.simmed !== false).sort((a, b) => b.deltaDps - a.deltaDps);

/**
 * A stopped run's rows as a view. `applyView` accepts only a complete ranking
 * on purpose (`rank.ts` on `Ranking.complete`), so a partial gets its own
 * list, as the old tab built one: the simmed rows in engine order, split on
 * the engine's own cutoff verdict.
 */
export function stoppedView(result: StoppedRanking): ViewResult {
	const rows: ViewRow[] = result.items.filter(row => row.simmed !== false).map(row => ({ ...row, belowCutoffInView: row.belowCutoff }));
	const shortlist = rows.filter(row => !row.belowCutoffInView);
	return { rows, shortlist, belowCutoffCount: rows.length - shortlist.length, pinBisAvailable: false };
}

/**
 * The two view toggles of a finished run (old tab C5). They reshape a ranking
 * already measured and never change a run, so they are not run settings and
 * do not mark a result stale.
 */
export type ViewToggles = { withSetPotential: boolean; onlyBis: boolean };

export const NO_VIEW_TOGGLES: ViewToggles = { withSetPotential: false, onlyBis: false };

/** Whether BiS only has anything to keep. */
export const hasBisRows = (ranking: Pick<Ranking, 'items'>): boolean => ranking.items.some(onBisList);

/**
 * The toggles the tab shows for `run`: both on a finished run only, and BiS
 * only only when some row is on a BiS list, as the old tab chose.
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
	return { ...view, rows, shortlist, belowCutoffCount: rows.length - shortlist.length, tabSlots, bisOnly: true };
}

/** The sources "Filter by source" lists, keyed and counted as the pre-run Sources dialog keys and counts them. */
export type ViewSourceOptions = { raids: SourceOption[]; other: SourceOption[] };

/**
 * The sources of `rows`, which are the view's rows before the source cut, so
 * the dialog never lists a source no row on screen carries. Raid zones first,
 * then zoneless buckets, each in first-seen order (`sourceOptions`).
 */
export const viewSourceOptions = (rows: readonly ViewRow[]): ViewSourceOptions => sourceOptions(rows);

/**
 * A view cut to the rows of the sources not in `hidden`. A row stays while
 * some shown source matches it, which is the pre-run Sources rule
 * (`effectivePool`), so an item from two raids stays while either is shown.
 * A hidden key the view does not offer changes nothing. Like `bisOnlyView`,
 * only the count below the cutoff changes, and every slot keeps its tab.
 */
export function sourcesView(view: ResultsViewResult, hidden: readonly string[]): ResultsViewResult {
	const shown = validSourceKeysOf(view.rows).filter(key => !hidden.includes(key));
	const kept = (row: ViewRow) => shown.some(key => sourceMatches(row, key));
	const rows = view.rows.filter(kept);
	if (rows.length === view.rows.length) return view;
	const shortlist = view.shortlist.filter(kept);
	const tabSlots = view.tabSlots ?? [...new Set(view.rows.map(effectiveSlot))];
	return { ...view, rows, shortlist, belowCutoffCount: rows.length - shortlist.length, tabSlots, sourcesHidden: true };
}

/**
 * The view a settled run renders under `applied` (from `appliedToggles`) and
 * the sources "Filter by source" hides; nothing before a run settles.
 */
export function resultsViewFor(run: RunState, { withSetPotential, onlyBis }: ViewToggles, hiddenSources: readonly string[] = []): ResultsViewResult | undefined {
	const bySource = (view: ResultsViewResult) => (hiddenSources.length > 0 ? sourcesView(view, hiddenSources) : view);
	switch (run.status) {
		case 'done': {
			const view = applyView(run.result, { withSetPotential });
			return bySource(onlyBis ? bisOnlyView(view) : view);
		}
		case 'stopped':
			return bySource(stoppedView(run.result));
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
	const noiseFloorDps = setBonusNoiseFloorDps(ranking.cutoff);
	return row => row.deltaDps + rankableSetPotential(row, noiseFloorDps);
}
