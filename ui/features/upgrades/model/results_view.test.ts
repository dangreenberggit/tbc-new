import { describe, expect, it } from 'vitest';

import { fixtureRow, RANKING_FIXTURE, STOPPED_FIXTURE } from '../testing/ranking_fixture';
import type { RankedItem, Ranking } from './engine/rank';
import { applyView } from './engine/view';
import {
	appliedToggles,
	dpsSortKeyFor,
	effectiveSlot,
	hasBisRows,
	landedRows,
	NO_VIEW_TOGGLES,
	offeredToggles,
	paneRows,
	resultsViewFor,
	rowKey,
	SHOPPING_LIST_TAB,
	slotTabs,
	stoppedView,
} from './results_view';

const ids = (rows: ReadonlyArray<{ itemId: number }>) => rows.map(row => row.itemId);
const VIEW = applyView(RANKING_FIXTURE);
const helm = fixtureRow(5);

describe('effectiveSlot and rowKey', () => {
	it('takes the sim slot the engine chose, else the first one the pool slot maps to', () => {
		expect(effectiveSlot(fixtureRow(0))).toBe('mainhand');
		expect(effectiveSlot(fixtureRow(7))).toBe('trinket1');
	});

	it('keys a row by item and slot', () => {
		expect(rowKey(fixtureRow(0))).toBe('32332:weapon');
	});
});

describe('slotTabs', () => {
	it('lists the slots with a row in sim order, each with its above-cutoff count', () => {
		expect(slotTabs(VIEW)).toEqual([
			{ id: 'head', count: 2 },
			{ id: 'chest', count: 2 },
			{ id: 'legs', count: 1 },
			{ id: 'trinket1', count: 1 },
			{ id: 'mainhand', count: 4 },
		]);
	});

	it('keeps a slot whose rows are all below the cutoff, with a count of 0', () => {
		expect(slotTabs(applyView({ ...RANKING_FIXTURE, items: [helm] }))).toEqual([{ id: 'head', count: 0 }]);
	});
});

describe('paneRows', () => {
	it('splits the Upgrades pane into the shortlist and the below-cutoff rows', () => {
		const pane = paneRows(VIEW, SHOPPING_LIST_TAB);
		expect(ids(pane.shortlist)).toEqual([32332, 30902, 32235, 33688, 28830, 30989, 29993, 30990, 30993, 30905]);
		expect(ids(pane.belowCutoff)).toEqual([32373]);
	});

	it('splits a slot pane the same way over that slot’s rows', () => {
		const pane = paneRows(VIEW, 'head');
		expect(ids(pane.shortlist)).toEqual([32235, 30989]);
		expect(ids(pane.belowCutoff)).toEqual([32373]);
	});

	it('leaves owned rows out of the below-cutoff group', () => {
		const ownedHelm = { ...helm, itemId: 30987, owned: true };
		const pane = paneRows(applyView({ ...RANKING_FIXTURE, items: [helm, ownedHelm] }), 'head');
		expect(ids(pane.belowCutoff)).toEqual([32373]);
	});
});

describe('landedRows', () => {
	it('drops rows Stop never simmed and orders the rest by ΔDPS, highest first', () => {
		const rows = [fixtureRow(4), STOPPED_FIXTURE.items.at(-1)!, fixtureRow(1), fixtureRow(9)];
		expect(ids(landedRows(rows))).toEqual([30902, 30990, 30993]);
	});
});

describe('stoppedView', () => {
	const view = stoppedView(STOPPED_FIXTURE);

	it('shows the simmed rows in engine order and drops the placeholders', () => {
		expect(ids(view.rows)).toEqual([32332, 30902, 32235, 33688, 28830, 30989, 29993, 30990, 30993, 30905, 32373]);
	});

	it('splits on the engine’s own cutoff verdict', () => {
		expect(ids(view.shortlist)).toEqual([32332, 30902, 32235, 33688, 28830, 30989, 29993, 30990, 30993, 30905]);
		expect(view.belowCutoffCount).toBe(1);
		expect(view.rows.find(row => row.itemId === 32373)?.belowCutoffInView).toBe(true);
	});

	it('offers no BiS pin and no groups', () => {
		expect(view.pinBisAvailable).toBe(false);
		expect(view.groups).toBeUndefined();
	});
});

// Lightbringer Faceguard (4.42) with a measured 2-piece bonus, so Set potential credits it past Dragonspine Trophy (5.2).
const faceguard: RankedItem = {
	...fixtureRow(10),
	setContext: { ...fixtureRow(10).setContext!, futureBonuses: [{ threshold: 2, piecesNeeded: 1, dps: 20.04, pieces: [], breaks: [] }] },
};
const WITH_POTENTIAL: Ranking = { ...RANKING_FIXTURE, items: RANKING_FIXTURE.items.map(row => (row.itemId === faceguard.itemId ? faceguard : row)) };
const done = (result: Ranking) => ({ status: 'done' as const, runId: 1, result });
const SET_POTENTIAL = { ...NO_VIEW_TOGGLES, withSetPotential: true };
const ONLY_BIS = { ...NO_VIEW_TOGGLES, onlyBis: true };

describe('resultsViewFor', () => {
	it('views a finished run through applyView', () => {
		expect(resultsViewFor(done(RANKING_FIXTURE), NO_VIEW_TOGGLES)).toEqual(VIEW);
	});

	it('views a stopped run through stoppedView', () => {
		expect(resultsViewFor({ status: 'stopped', runId: 1, result: STOPPED_FIXTURE }, NO_VIEW_TOGGLES)).toEqual(stoppedView(STOPPED_FIXTURE));
	});

	it('has no view before a run settles', () => {
		expect(resultsViewFor({ status: 'idle' }, NO_VIEW_TOGGLES)).toBeUndefined();
		expect(resultsViewFor({ status: 'running', runId: 1, startedAt: 0, landedRows: [], stopping: false }, NO_VIEW_TOGGLES)).toBeUndefined();
	});

	it('with Set potential, ranks a row by its ΔDPS plus its set credit', () => {
		const faceguardBeforeTrophy = (toggles: typeof NO_VIEW_TOGGLES) => {
			const order = ids(resultsViewFor(done(WITH_POTENTIAL), toggles)!.shortlist);
			return order.indexOf(30989) < order.indexOf(28830);
		};
		expect(faceguardBeforeTrophy(NO_VIEW_TOGGLES)).toBe(false);
		expect(faceguardBeforeTrophy(SET_POTENTIAL)).toBe(true);
	});

	it('with BiS only, keeps the rows on a BiS list and recounts the rows below the cutoff', () => {
		const view = resultsViewFor(done(RANKING_FIXTURE), ONLY_BIS)!;
		expect(ids(view.rows)).toEqual([32332, 32235, 28830]);
		expect(ids(view.shortlist)).toEqual([32332, 32235, 28830]);
		expect(view.belowCutoffCount).toBe(0);
	});
});

describe('hasBisRows', () => {
	it('is true when any row carries a BiS or Alt tag', () => {
		expect(hasBisRows(RANKING_FIXTURE)).toBe(true);
		expect(hasBisRows({ items: [fixtureRow(1)] })).toBe(false);
		expect(hasBisRows({ items: [fixtureRow(7)] })).toBe(true);
	});
});

describe('offeredToggles and appliedToggles', () => {
	const stopped = { status: 'stopped' as const, runId: 1, result: STOPPED_FIXTURE };
	const untagged = { ...RANKING_FIXTURE, items: RANKING_FIXTURE.items.map(row => ({ ...row, bisTags: [] })) };
	const both = { withSetPotential: true, onlyBis: true };

	it('offers both toggles on a finished run with a BiS-list row, Set potential alone without one, and neither otherwise', () => {
		expect(offeredToggles(done(RANKING_FIXTURE))).toEqual(both);
		expect(offeredToggles(done(untagged))).toEqual(SET_POTENTIAL);
		expect(offeredToggles(stopped)).toEqual(NO_VIEW_TOGGLES);
		expect(offeredToggles({ status: 'idle' })).toEqual(NO_VIEW_TOGGLES);
	});

	it('applies only the toggles on offer, so a hidden BiS only never filters rows', () => {
		const applied = (run: Parameters<typeof offeredToggles>[0]) => appliedToggles(offeredToggles(run), both);
		expect(applied(done(RANKING_FIXTURE))).toEqual(both);
		expect(applied(done(untagged))).toEqual(SET_POTENTIAL);
		expect(applied(stopped)).toEqual(NO_VIEW_TOGGLES);
	});
});

describe('dpsSortKeyFor', () => {
	it('is the bare ΔDPS (undefined) with Set potential off or no finished ranking', () => {
		expect(dpsSortKeyFor(WITH_POTENTIAL, false)).toBeUndefined();
		expect(dpsSortKeyFor(undefined, true)).toBeUndefined();
	});

	it('adds the set credit the view ranked on, so the column sort agrees with the view', () => {
		const key = dpsSortKeyFor(WITH_POTENTIAL, true)!;
		expect(key(faceguard)).toBeGreaterThan(5.2);
		expect(key(fixtureRow(7))).toBe(5.2);
	});
});
