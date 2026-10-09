import { loadEnglishBundles } from '@features/upgrades/testing/locales';
import { SimHostProvider } from '@sim/context/SimHostContext';
import { fakeHost } from '@sim/testing';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import type { RowContext } from '../components/ResultsTable/ResultRow';
import type { RankedItem } from '../model/engine/rank';
import type { DpsSortKey } from '../model/results_columns';
import { type ResultsSort, selectSort, setSort } from '../model/upgrades_store';
import { fixtureRow } from '../testing/ranking_fixture';
import { useResultsTable } from './useResultsTable';
import { upgradesStoreFor } from './useUpgradesStore';

loadEnglishBundles({ character: true });

// Torch (weapon, Black Temple), Cursed Vision (head, Black Temple), Midnight Chestguard (chest, Hyjal Summit), Greatsword (weapon, PvP).
const ROWS = [fixtureRow(0), fixtureRow(2), fixtureRow(6), fixtureRow(3)];

// A page per test, so a sort one test stores does not reach the next.
let host: ReturnType<typeof fakeHost>;
beforeEach(() => {
	host = fakeHost({ player: { getSpec: () => undefined } });
});

const storedSort = () => selectSort(upgradesStoreFor(host).getState());

interface TableSetup {
	dpsKey?: DpsSortKey;
	sortable?: boolean;
}

/** A results table on the test's page, with `stored` as the tab store's sort before it renders. */
const renderTable = (rows: readonly RankedItem[], stored: ResultsSort, { dpsKey, sortable }: TableSetup = {}) => {
	setSort(upgradesStoreFor(host), stored);
	const context: RowContext = { itemOf: () => undefined, sim: host.sim, tip: {}, tagsOf: () => [], dpsKey };
	let renders = 0;
	const hook = renderHook(
		() => {
			renders++;
			return useResultsTable(rows, context, { sortable });
		},
		{ wrapper: ({ children }: { children: ReactNode }) => <SimHostProvider host={host}>{children}</SimHostProvider> },
	);
	return {
		ids: () => hook.result.current.getRowModel().rows.map(row => row.original.itemId),
		click: (columnId: string) => act(() => hook.result.current.getColumn(columnId)!.toggleSorting()),
		renders: () => renders,
	};
};

const ids = (rows: readonly RankedItem[], sorting: ResultsSort, dpsKey?: DpsSortKey) => renderTable(rows, sorting, { dpsKey }).ids();

describe('a results column click', () => {
	it('starts a column at descending', () => {
		const table = renderTable(ROWS, []);
		table.click('item');
		expect(storedSort()).toEqual([{ id: 'item', desc: true }]);
	});

	it('flips the direction on a second click of the same column, and never clears it', () => {
		const table = renderTable(ROWS, []);
		table.click('item');
		table.click('item');
		expect(storedSort()).toEqual([{ id: 'item', desc: false }]);
		table.click('item');
		expect(storedSort()).toEqual([{ id: 'item', desc: true }]);
	});

	it('starts a different column fresh at descending', () => {
		const table = renderTable(ROWS, [{ id: 'item', desc: false }]);
		table.click('source');
		expect(storedSort()).toEqual([{ id: 'source', desc: true }]);
	});

	it('reorders every other sortable table on the page', () => {
		const clicked = renderTable(ROWS, []);
		const other = renderTable(ROWS, []);
		clicked.click('item');
		expect(other.ids()).toEqual([33688, 32332, 30905, 32235]);
	});
});

describe('a table of a run in flight', () => {
	it('keeps the order it is given whatever the stored sort, and a sort click elsewhere does not re-render it', () => {
		const inFlight = renderTable(ROWS, [{ id: 'item', desc: false }], { sortable: false });
		const settled = renderTable(ROWS, []);
		expect(inFlight.ids()).toEqual([32332, 32235, 30905, 33688]);

		const before = inFlight.renders();
		settled.click('slot');
		expect(inFlight.renders()).toBe(before);
		expect(inFlight.ids()).toEqual([32332, 32235, 30905, 33688]);
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
