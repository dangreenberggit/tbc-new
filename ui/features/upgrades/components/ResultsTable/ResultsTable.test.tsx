import { loadEnglishBundles } from '@features/upgrades/testing/locales';
import { SimHostProvider } from '@sim/context/SimHostContext';
import type { IndividualSimHost } from '@sim/sim_host';
import { fakeHost } from '@sim/testing';
import type { SortingState } from '@tanstack/react-table';
import { fireEvent, render, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fixtureRow, RANKING_FIXTURE } from '../../testing/ranking_fixture';

// The row toggles read the page's store; `RowToggles.test.tsx` covers them.
vi.mock('../RowToggles', () => ({ FavoriteToggle: () => <span data-testid="favorite-stub" />, BatchToggle: () => <span data-testid="batch-stub" /> }));
// The icon lookup fetches from wowhead; the row's own cells are under test.
vi.mock('@ui-kit/hooks/useActionId', () => ({ useActionId: () => ({ iconUrl: '', name: '', href: '', ready: true }) }));

// Every row, so the assertions are about the table's order rather than what it windowed; `useVirtualRows.test.tsx` covers the windowing.
vi.mock('../../hooks/useVirtualRows', () => ({
	useVirtualRows: (keys: readonly string[]) => ({ indexes: keys.map((_key, index) => index), paddingTop: 0, paddingBottom: 0, measureRow: () => {} }),
}));

const { ProvisionalResultsTable, ResultRows, ResultsTable } = await import('./ResultsTable');
const { ScreenReaderResultsHead, SortableResultsHead } = await import('./ResultsTableHead');
const { useResultsTable } = await import('../../hooks/useResultsTable');
const { selectSort, upgradesStoreFor } = await import('../../hooks/useUpgradesStore');
const { setSort } = await import('../../model/upgrades_store');
type RowContext = import('./ResultRow').RowContext;
type RankedItem = import('../../model/engine/rank').RankedItem;

loadEnglishBundles({ character: true });

const CONTEXT: RowContext = { itemOf: () => undefined, sim: fakeHost().sim, tip: {}, tagsOf: () => [] };
const FOUR = [fixtureRow(3), fixtureRow(0), fixtureRow(2), fixtureRow(1)];

const cellsOf = (row: HTMLElement | undefined) =>
	row
		? within(row)
				.getAllByRole('cell')
				.map(cell => cell.textContent)
		: [];

const rowsOf = (table: HTMLElement) => within(table).getAllByTestId('upgrades-result-row');
const namesOf = (table: HTMLElement) => rowsOf(table).map(row => within(row).getByTestId('upgrades-item-name').textContent);
const positionsOf = (table: HTMLElement) => rowsOf(table).map(row => cellsOf(row)[0]);

// A page per test, so a sort one test stores does not reach the next.
let host: IndividualSimHost<any>;
beforeEach(() => {
	host = fakeHost({ player: { getSpec: () => undefined } });
});
const onPage = (node: ReactNode) => <SimHostProvider host={host}>{node}</SimHostProvider>;
const storeSort = (sorting: SortingState) => setSort(upgradesStoreFor(host), sorting);
const storedSort = () => selectSort(upgradesStoreFor(host).getState());

/** A table with no head, as the below-cutoff group composes it. */
const Bare = ({ rows }: { rows: readonly RankedItem[] }) => {
	const table = useResultsTable(rows, CONTEXT);
	return (
		<ResultsTable>
			<ResultRows table={table} rowContext={CONTEXT} />
		</ResultsTable>
	);
};

/** A settled table with its sortable head, as the shortlist composes it. */
const Sortable = ({ rows }: { rows: readonly RankedItem[] }) => {
	const table = useResultsTable(rows, CONTEXT);
	return (
		<ResultsTable>
			<SortableResultsHead table={table} />
			<ResultRows table={table} rowContext={CONTEXT} />
		</ResultsTable>
	);
};

/** A table under another table's head, as the below-cutoff group sits under a shortlist. */
const UnderAnotherHead = ({ rows }: { rows: readonly RankedItem[] }) => {
	const table = useResultsTable(rows, CONTEXT);
	return (
		<ResultsTable>
			<ScreenReaderResultsHead table={table} />
			<ResultRows table={table} rowContext={CONTEXT} />
		</ResultsTable>
	);
};

const bare = (rows: readonly RankedItem[], sorting?: SortingState) => {
	if (sorting) storeSort(sorting);
	return onPage(<Bare rows={rows} />);
};

describe('ResultsTable', () => {
	it('shows rank, item, slot, DPS change and source for every row, in order', () => {
		const { getByTestId } = render(bare(RANKING_FIXTURE.items));
		const rows = rowsOf(getByTestId('upgrades-results-table'));

		expect(rows).toHaveLength(RANKING_FIXTURE.items.length);
		expect(cellsOf(rows[0]).slice(0, 5)).toEqual(['1', 'Torch of the DamnedBiS', 'Main Hand', '+45.7', 'Black Temple']);
	});

	it('keeps each row’s element when rows arrive ahead of it, because rows are keyed by item', () => {
		const [first, second] = [fixtureRow(0), fixtureRow(1)];
		const { getByTestId, rerender } = render(bare([second]));
		const before = getByTestId('upgrades-results-table').querySelector(`[data-item-id="${second.itemId}"]`);

		rerender(bare([first, second]));
		expect(getByTestId('upgrades-results-table').querySelector(`[data-item-id="${second.itemId}"]`)).toBe(before);
	});

	it('orders rows by the sort it is given and numbers them in the order shown', () => {
		const { getByTestId } = render(bare(FOUR, [{ id: 'item', desc: false }]));
		const table = getByTestId('upgrades-results-table');

		expect(namesOf(table)).toEqual(["Cataclysm's Edge", 'Cursed Vision of Sargeras', 'Torch of the Damned', "Vengeful Gladiator's Greatsword"]);
		expect(positionsOf(table)).toEqual(['1', '2', '3', '4']);
	});

	it('keeps the order it is given when there is no sort', () => {
		const { getByTestId } = render(bare(FOUR));
		expect(namesOf(getByTestId('upgrades-results-table'))).toEqual(FOUR.map(row => row.name));
	});

	it('marks the sorted column for assistive tech, and stores the sort of the header clicked', () => {
		storeSort([{ id: 'delta_dps', desc: true }]);
		const { getByTestId, getAllByRole } = render(onPage(<Sortable rows={FOUR} />));

		const ariaSorts = getAllByRole('columnheader').map(th => th.getAttribute('aria-sort'));
		expect(ariaSorts).toEqual([null, 'none', 'none', 'descending', 'none', null, null]);
		expect(getByTestId('upgrades-sort-delta_dps').textContent).toBe('DPS▼sorted descending');

		fireEvent.click(getByTestId('upgrades-sort-source'));
		expect(storedSort()).toEqual([{ id: 'source', desc: true }]);
		fireEvent.click(getByTestId('upgrades-sort-item'));
		expect(storedSort()).toEqual([{ id: 'item', desc: true }]);
		fireEvent.click(getByTestId('upgrades-sort-item'));
		expect(storedSort()).toEqual([{ id: 'item', desc: false }]);
		expect(getByTestId('upgrades-sort-item').textContent).toBe('Item▲sorted ascending');
		expect(namesOf(getByTestId('upgrades-results-table'))).toEqual([
			"Cataclysm's Edge",
			'Cursed Vision of Sargeras',
			'Torch of the Damned',
			"Vengeful Gladiator's Greatsword",
		]);
	});

	it('has a plain head with no sort buttons while a run is in flight, and keeps the order given whatever the stored sort', () => {
		storeSort([{ id: 'item', desc: false }]);
		const { getByTestId, queryByTestId } = render(onPage(<ProvisionalResultsTable rows={FOUR} rowContext={CONTEXT} />));

		expect(getByTestId('upgrades-results-table').dataset.provisional).toBe('true');
		expect(queryByTestId('upgrades-sort-item')).toBeNull();
		expect(within(getByTestId('upgrades-results-table')).getAllByRole('columnheader')).toHaveLength(7);
		expect(namesOf(getByTestId('upgrades-results-table'))).toEqual(FOUR.map(row => row.name));
	});

	it('has no head when composed without one, and still sorts and numbers its rows', () => {
		const { getByTestId } = render(bare(FOUR, [{ id: 'item', desc: true }]));
		const table = getByTestId('upgrades-results-table');

		expect(table.querySelector('thead')).toBeNull();
		expect(positionsOf(table)).toEqual(['1', '2', '3', '4']);
		expect(namesOf(table)[0]).toBe("Vengeful Gladiator's Greatsword");
	});

	it('gives a table with a visible head and one with a screen-reader head the same column widths, one per head cell', () => {
		const widths = (table: HTMLElement) => [...table.querySelectorAll('col')].map(col => col.className);
		const { getAllByTestId } = render(
			onPage(
				<>
					<ProvisionalResultsTable rows={FOUR} rowContext={CONTEXT} />
					<UnderAnotherHead rows={FOUR} />
				</>,
			),
		);
		const [visible, screenReader] = getAllByTestId('upgrades-results-table') as [HTMLElement, HTMLElement];

		expect(widths(visible)).toHaveLength(visible.querySelectorAll('thead th').length);
		expect(widths(screenReader)).toHaveLength(screenReader.querySelectorAll('thead th').length);
		expect(widths(screenReader)).toEqual(widths(visible));
	});
});
