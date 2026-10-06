import { describe, expect, it } from 'vitest';

import { fixtureRow, RANKING_FIXTURE, STOPPED_FIXTURE } from '../testing/ranking_fixture';
import { applyView } from './engine/view';
import { effectiveSlot, landedRows, paneRows, resultsViewFor, rowKey, SHOPPING_LIST_TAB, slotTabs, stoppedView } from './results_view';

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

describe('resultsViewFor', () => {
	it('views a finished run through applyView', () => {
		expect(resultsViewFor({ status: 'done', runId: 1, result: RANKING_FIXTURE })).toEqual(VIEW);
	});

	it('views a stopped run through stoppedView', () => {
		expect(resultsViewFor({ status: 'stopped', runId: 1, result: STOPPED_FIXTURE })).toEqual(stoppedView(STOPPED_FIXTURE));
	});

	it('has no view before a run settles', () => {
		expect(resultsViewFor({ status: 'idle' })).toBeUndefined();
		expect(resultsViewFor({ status: 'running', runId: 1, startedAt: 0, landedRows: [] })).toBeUndefined();
	});
});
