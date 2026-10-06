import { describe, expect, it } from 'vitest';

import { fixtureRow } from '../testing/ranking_fixture';
import { nextSort, sortRows } from './results_sort';

const ids = (rows: ReadonlyArray<{ itemId: number }>) => rows.map(row => row.itemId);

// Torch (weapon, Black Temple), Cursed Vision (head, Black Temple), Midnight Chestguard (chest, Hyjal Summit), Greatsword (weapon, PvP).
const ROWS = [fixtureRow(0), fixtureRow(2), fixtureRow(6), fixtureRow(3)];
const LABELS = {
	slot: (row: { slot: string }) => ({ weapon: 'Main Hand', head: 'Head', chest: 'Chest' })[row.slot] ?? row.slot,
	source: (row: { itemId: number }) => ({ 32332: 'Black Temple', 32235: 'Black Temple', 30905: 'Hyjal Summit', 33688: 'PvP' })[row.itemId] ?? '',
};

describe('nextSort', () => {
	it('starts a column at descending', () => {
		expect(nextSort(undefined, 'item')).toEqual({ key: 'item', dir: 'desc' });
	});

	it('flips the direction on a second click of the same column', () => {
		expect(nextSort({ key: 'item', dir: 'desc' }, 'item')).toEqual({ key: 'item', dir: 'asc' });
		expect(nextSort({ key: 'item', dir: 'asc' }, 'item')).toEqual({ key: 'item', dir: 'desc' });
	});

	it('starts a different column fresh at descending', () => {
		expect(nextSort({ key: 'item', dir: 'asc' }, 'source')).toEqual({ key: 'source', dir: 'desc' });
	});
});

describe('sortRows', () => {
	it('keeps the engine order with no sort', () => {
		expect(ids(sortRows(ROWS, undefined, LABELS))).toEqual([32332, 32235, 30905, 33688]);
	});

	it('sorts by item name, ignoring case', () => {
		expect(ids(sortRows(ROWS, { key: 'item', dir: 'asc' }, LABELS))).toEqual([32235, 30905, 32332, 33688]);
		expect(ids(sortRows(ROWS, { key: 'item', dir: 'desc' }, LABELS))).toEqual([33688, 32332, 30905, 32235]);
	});

	it('sorts by ΔDPS', () => {
		expect(ids(sortRows(ROWS, { key: 'delta_dps', dir: 'asc' }, LABELS))).toEqual([30905, 33688, 32235, 32332]);
	});

	it('sorts by the slot label', () => {
		expect(ids(sortRows(ROWS, { key: 'slot', dir: 'asc' }, LABELS))).toEqual([30905, 32235, 32332, 33688]);
	});

	it('keeps the engine order between rows with the same source', () => {
		expect(ids(sortRows(ROWS, { key: 'source', dir: 'desc' }, LABELS))).toEqual([33688, 30905, 32332, 32235]);
		expect(ids(sortRows(ROWS, { key: 'source', dir: 'asc' }, LABELS))).toEqual([32332, 32235, 30905, 33688]);
	});

	it('returns a new array and leaves its input alone', () => {
		const input = [...ROWS];
		sortRows(input, { key: 'item', dir: 'asc' }, LABELS);
		expect(ids(input)).toEqual([32332, 32235, 30905, 33688]);
	});
});
