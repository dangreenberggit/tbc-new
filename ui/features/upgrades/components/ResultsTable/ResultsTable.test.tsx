import i18n from '@i18n/config';
import { fireEvent, render, within } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import englishCharacter from '../../../../../assets/locales/en/character.json';
import englishTranslations from '../../../../../assets/locales/en/translation.json';
import { fixtureRow, RANKING_FIXTURE } from '../../testing/ranking_fixture';

// The row toggles read the page's store; `RowToggles.test.tsx` covers them.
vi.mock('../RowToggles', () => ({ FavoriteToggle: () => <span data-testid="favorite-stub" />, BatchToggle: () => <span data-testid="batch-stub" /> }));
// The icon lookup fetches from wowhead; the row's own cells are under test.
vi.mock('@ui-kit/hooks/useActionId', () => ({ useActionId: () => ({ iconUrl: '', name: '', href: '', ready: true }) }));

const { ResultRows, ResultsTable } = await import('./ResultsTable');
const { PlainResultsHead, SortableResultsHead } = await import('./ResultsTableHead');
type RowContext = import('./ResultRow').RowContext;
type ResultsSort = import('../../model/results_sort').ResultsSort;
type RankedItem = import('../../model/engine/rank').RankedItem;

beforeAll(() => {
	i18n.addResourceBundle('en', 'translation', englishTranslations, true, true);
	i18n.addResourceBundle('en', 'character', englishCharacter, true, true);
});
afterAll(() => {
	i18n.removeResourceBundle('en', 'translation');
	i18n.removeResourceBundle('en', 'character');
});

const CONTEXT: RowContext = { itemOf: () => undefined, tip: {}, tagsOf: () => [] };
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

/** A table with no head, as the below-cutoff group composes it. */
const bare = (rows: readonly RankedItem[], sort?: ResultsSort) => (
	<ResultsTable>
		<ResultRows rows={rows} rowContext={CONTEXT} sort={sort} />
	</ResultsTable>
);

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
		const { getByTestId } = render(bare(FOUR, { key: 'item', dir: 'asc' }));
		const table = getByTestId('upgrades-results-table');

		expect(namesOf(table)).toEqual(["Cataclysm's Edge", 'Cursed Vision of Sargeras', 'Torch of the Damned', "Vengeful Gladiator's Greatsword"]);
		expect(positionsOf(table)).toEqual(['1', '2', '3', '4']);
	});

	it('keeps the order it is given when there is no sort', () => {
		const { getByTestId } = render(bare(FOUR));
		expect(namesOf(getByTestId('upgrades-results-table'))).toEqual(FOUR.map(row => row.name));
	});

	it('asks for a sort by the header clicked, and marks the sorted column for assistive tech', () => {
		const onSort = vi.fn();
		const { getByTestId, getAllByRole } = render(
			<ResultsTable>
				<SortableResultsHead sort={{ key: 'delta_dps', dir: 'desc' }} onSort={onSort} />
				<ResultRows rows={FOUR} rowContext={CONTEXT} sort={{ key: 'delta_dps', dir: 'desc' }} />
			</ResultsTable>,
		);

		fireEvent.click(getByTestId('upgrades-sort-source'));
		fireEvent.click(getByTestId('upgrades-sort-item'));
		expect(onSort.mock.calls).toEqual([['source'], ['item']]);

		const ariaSorts = getAllByRole('columnheader').map(th => th.getAttribute('aria-sort'));
		expect(ariaSorts).toEqual([null, 'none', 'none', 'descending', 'none', null, null]);
		expect(getByTestId('upgrades-sort-delta_dps').textContent).toBe('DPS▼sorted descending');
	});

	it('has a plain head with no sort buttons while a run is in flight', () => {
		const { getByTestId, queryByTestId } = render(
			<ResultsTable data-provisional="true">
				<PlainResultsHead />
				<ResultRows rows={FOUR} rowContext={CONTEXT} />
			</ResultsTable>,
		);

		expect(getByTestId('upgrades-results-table').dataset.provisional).toBe('true');
		expect(queryByTestId('upgrades-sort-item')).toBeNull();
		expect(within(getByTestId('upgrades-results-table')).getAllByRole('columnheader')).toHaveLength(7);
	});

	it('has no head when composed without one, and still sorts and numbers its rows', () => {
		const { getByTestId } = render(bare(FOUR, { key: 'item', dir: 'desc' }));
		const table = getByTestId('upgrades-results-table');

		expect(table.querySelector('thead')).toBeNull();
		expect(positionsOf(table)).toEqual(['1', '2', '3', '4']);
		expect(namesOf(table)[0]).toBe("Vengeful Gladiator's Greatsword");
	});
});
