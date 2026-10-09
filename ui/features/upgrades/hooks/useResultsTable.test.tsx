import { type SortingState, useTable } from '@tanstack/react-table';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { RankedItem } from '../model/engine/rank';
import type { DpsSortKey } from '../model/results_sort';
import { fixtureRow } from '../testing/ranking_fixture';
import { RESULTS_TABLE_OPTIONS, resultsColumns } from './useResultsTable';

// Torch (weapon, Black Temple), Cursed Vision (head, Black Temple), Midnight Chestguard (chest, Hyjal Summit), Greatsword (weapon, PvP).
const ROWS = [fixtureRow(0), fixtureRow(2), fixtureRow(6), fixtureRow(3)];
const LABELS = {
	slot: (row: { slot: string }) => ({ weapon: 'Main Hand', head: 'Head', chest: 'Chest' })[row.slot] ?? row.slot,
	source: (row: { itemId: number }) => ({ 32332: 'Black Temple', 32235: 'Black Temple', 30905: 'Hyjal Summit', 33688: 'PvP' })[row.itemId] ?? '',
};

/** A results table over `rows` with the given sort held outside it, as the tab store holds it. */
const renderTable = (rows: readonly RankedItem[], initial: SortingState, dpsKey?: DpsSortKey) => {
	let sorting = initial;
	const hook = renderHook(() =>
		useTable({
			...RESULTS_TABLE_OPTIONS,
			data: rows,
			columns: resultsColumns(LABELS, dpsKey),
			state: { sorting },
			onSortingChange: updater => {
				sorting = typeof updater === 'function' ? updater(sorting) : updater;
			},
		}),
	);
	return {
		ids: () => hook.result.current.getRowModel().rows.map(row => row.original.itemId),
		click: (columnId: string) => {
			act(() => hook.result.current.getColumn(columnId)!.toggleSorting());
			hook.rerender();
		},
		sorting: () => sorting,
	};
};

const ids = (rows: readonly RankedItem[], sorting: SortingState, dpsKey?: DpsSortKey) => renderTable(rows, sorting, dpsKey).ids();

describe('a results column click', () => {
	it('starts a column at descending', () => {
		const table = renderTable(ROWS, []);
		table.click('item');
		expect(table.sorting()).toEqual([{ id: 'item', desc: true }]);
	});

	it('flips the direction on a second click of the same column, and never clears it', () => {
		const table = renderTable(ROWS, []);
		table.click('item');
		table.click('item');
		expect(table.sorting()).toEqual([{ id: 'item', desc: false }]);
		table.click('item');
		expect(table.sorting()).toEqual([{ id: 'item', desc: true }]);
	});

	it('starts a different column fresh at descending', () => {
		const table = renderTable(ROWS, [{ id: 'item', desc: false }]);
		table.click('source');
		expect(table.sorting()).toEqual([{ id: 'source', desc: true }]);
	});
});

describe('the results table sort', () => {
	it('keeps the engine order with no sort', () => {
		expect(ids(ROWS, [])).toEqual([32332, 32235, 30905, 33688]);
	});

	it('sorts by item name, ignoring case', () => {
		expect(ids(ROWS, [{ id: 'item', desc: false }])).toEqual([32235, 30905, 32332, 33688]);
		expect(ids(ROWS, [{ id: 'item', desc: true }])).toEqual([33688, 32332, 30905, 32235]);
	});

	it('sorts by ΔDPS', () => {
		expect(ids(ROWS, [{ id: 'delta_dps', desc: false }])).toEqual([30905, 33688, 32235, 32332]);
		expect(ids(ROWS, [{ id: 'delta_dps', desc: true }])).toEqual([32332, 32235, 33688, 30905]);
	});

	it('sorts by the slot label', () => {
		expect(ids(ROWS, [{ id: 'slot', desc: false }])).toEqual([30905, 32235, 32332, 33688]);
		expect(ids(ROWS, [{ id: 'slot', desc: true }])).toEqual([32332, 33688, 32235, 30905]);
	});

	it('keeps the engine order between rows with the same source, in both directions', () => {
		expect(ids(ROWS, [{ id: 'source', desc: true }])).toEqual([33688, 30905, 32332, 32235]);
		expect(ids(ROWS, [{ id: 'source', desc: false }])).toEqual([32332, 32235, 30905, 33688]);
	});

	it('leaves its input alone', () => {
		const input = [...ROWS];
		ids(input, [{ id: 'item', desc: false }]);
		expect(input.map(row => row.itemId)).toEqual([32332, 32235, 30905, 33688]);
	});
});

describe('the results table sort with a ΔDPS key', () => {
	it('sorts the ΔDPS column on the key it is given', () => {
		const boosted = (row: { itemId: number; deltaDps: number }) => row.deltaDps + (row.itemId === 30905 ? 100 : 0);
		expect(ids(ROWS, [{ id: 'delta_dps', desc: true }], boosted)).toEqual([30905, 32332, 32235, 33688]);
	});

	it('leaves the other columns alone', () => {
		const constant = () => 0;
		expect(ids(ROWS, [{ id: 'item', desc: false }], constant)).toEqual(ids(ROWS, [{ id: 'item', desc: false }]));
	});
});
