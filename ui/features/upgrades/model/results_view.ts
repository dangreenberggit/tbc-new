/**
 * Which rows each results pane shows, as the old tab chose them (cb561067
 * `upgrades_tab.tsx`): an "Upgrades" pane plus one pane per slot with a row,
 * each split into its shortlist and its below-cutoff group. Pure; the panes
 * render what this returns.
 */

import { type SimSlotName, simSlotsForPoolSlot } from './engine/pool';
import type { RankedItem } from './engine/rank';
import { SIM_ORDER } from './engine/slots';
import { applyView, type ViewResult, type ViewRow } from './engine/view';
import type { RunState, StoppedRanking } from './run_reducer';

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
 * The slot tabs: every slot with a row, in sim order, counted by its
 * above-cutoff rows. A slot whose rows are all below the cutoff keeps its tab
 * at 0, so the user can open it and see why it is empty.
 */
export function slotTabs(view: ViewResult): Array<{ id: SimSlotName; count: number }> {
	const counts = new Map<SimSlotName, number>();
	for (const row of view.rows) {
		const slot = effectiveSlot(row);
		counts.set(slot, (counts.get(slot) ?? 0) + (row.belowCutoffInView ? 0 : 1));
	}
	return SIM_ORDER.flatMap(slot => {
		const count = counts.get(slot as SimSlotName);
		return count === undefined ? [] : [{ id: slot as SimSlotName, count }];
	});
}

/**
 * One pane's rows. Owned rows stay out of the below-cutoff group: an owned
 * item is re-simmed into the slot it already fills, so its delta is about 0
 * by construction and the group would only list the gear the player wears.
 */
export function paneRows(view: ViewResult, tab: ResultsTabId): { shortlist: ViewRow[]; belowCutoff: ViewRow[] } {
	const rows = tab === SHOPPING_LIST_TAB ? view.rows : view.rows.filter(row => effectiveSlot(row) === tab);
	const shortlist = tab === SHOPPING_LIST_TAB ? view.shortlist : rows.filter(row => !row.belowCutoffInView);
	return { shortlist, belowCutoff: rows.filter(row => row.belowCutoffInView && !row.owned) };
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

/** The view a settled run renders; nothing before a run settles. */
export function resultsViewFor(run: RunState): ViewResult | undefined {
	switch (run.status) {
		case 'done':
			return applyView(run.result);
		case 'stopped':
			return stoppedView(run.result);
		default:
			return undefined;
	}
}
