import i18n from '@i18n/config';
import { render, within } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import englishCharacter from '../../../../../assets/locales/en/character.json';
import englishTranslations from '../../../../../assets/locales/en/translation.json';
import { fixtureRow, RANKING_FIXTURE } from '../../testing/ranking_fixture';

// The icon lookup fetches from wowhead; the row's own cells are under test.
vi.mock('@ui-kit/hooks/useActionId', () => ({ useActionId: () => ({ iconUrl: '', name: '', href: '', ready: true }) }));

const { ResultsTable } = await import('./ResultsTable');

beforeAll(() => {
	i18n.addResourceBundle('en', 'translation', englishTranslations, true, true);
	i18n.addResourceBundle('en', 'character', englishCharacter, true, true);
});
afterAll(() => {
	i18n.removeResourceBundle('en', 'translation');
	i18n.removeResourceBundle('en', 'character');
});

const cellsOf = (row: HTMLElement | undefined) =>
	row
		? within(row)
				.getAllByRole('cell')
				.map(cell => cell.textContent)
		: [];

describe('ResultsTable', () => {
	it('shows rank, item, slot, DPS change and source for every row, in order', () => {
		const { getByTestId } = render(<ResultsTable rows={RANKING_FIXTURE.items} />);
		const rows = within(getByTestId('upgrades-results-table')).getAllByTestId('upgrades-result-row');

		expect(rows).toHaveLength(RANKING_FIXTURE.items.length);
		expect(cellsOf(rows[0])).toEqual(['1', 'Torch of the Damned', 'Main Hand', '+45.7', 'Black Temple']);
	});

	it('keeps each row’s element when rows arrive ahead of it, because rows are keyed by item', () => {
		const [first, second] = [fixtureRow(0), fixtureRow(1)];
		const { getByTestId, rerender } = render(<ResultsTable rows={[second]} />);
		const before = getByTestId('upgrades-results-table').querySelector(`[data-item-id="${second.itemId}"]`);

		rerender(<ResultsTable rows={[first, second]} />);
		expect(getByTestId('upgrades-results-table').querySelector(`[data-item-id="${second.itemId}"]`)).toBe(before);
	});
});
