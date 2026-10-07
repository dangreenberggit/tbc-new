import i18n from '@i18n/config';
import { fireEvent, render, within } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import englishCharacter from '../../../../../assets/locales/en/character.json';
import englishTranslations from '../../../../../assets/locales/en/translation.json';
import { fixtureRow } from '../../testing/ranking_fixture';

// The row toggles read the page's store; `RowToggles.test.tsx` covers them.
vi.mock('../RowToggles', () => ({ FavoriteToggle: () => <span data-testid="favorite-stub" />, BatchToggle: () => <span data-testid="batch-stub" /> }));
vi.mock('@ui-kit/hooks/useActionId', () => ({ useActionId: () => ({ iconUrl: '', name: '', href: '', ready: true }) }));

const { BelowCutoffGroup } = await import('./BelowCutoffGroup');

beforeAll(() => {
	i18n.addResourceBundle('en', 'translation', englishTranslations, true, true);
	i18n.addResourceBundle('en', 'character', englishCharacter, true, true);
});
afterAll(() => {
	i18n.removeResourceBundle('en', 'translation');
	i18n.removeResourceBundle('en', 'character');
});

const ROWS = [fixtureRow(5), fixtureRow(3)];
const [FIRST_ID, SECOND_ID] = ROWS.map(row => String(row.itemId));
const CONTEXT = { itemOf: () => undefined, tip: {}, tagsOf: () => [] };

describe('BelowCutoffGroup', () => {
	it('starts collapsed, with its row count, and renders no table until opened', () => {
		const { getByTestId, queryByTestId } = render(<BelowCutoffGroup rows={ROWS} rowContext={CONTEXT} />);

		expect(getByTestId('upgrades-below-cutoff-trigger').textContent).toBe('2 item(s) below the cutoff');
		expect(queryByTestId('upgrades-results-table')).toBeNull();
	});

	it('shows its rows, numbered from 1, when opened, in a table with no head of its own', () => {
		const { getByTestId } = render(<BelowCutoffGroup rows={ROWS} rowContext={CONTEXT} />);
		fireEvent.click(getByTestId('upgrades-below-cutoff-trigger'));

		const table = getByTestId('upgrades-results-table');
		expect(table.querySelector('thead')).toBeNull();
		const rows = within(table).getAllByTestId('upgrades-result-row');
		expect(rows.map(row => [within(row).getAllByRole('cell')[0]?.textContent, row.dataset.itemId])).toEqual([
			['1', FIRST_ID],
			['2', SECOND_ID],
		]);
	});

	it('orders its rows by the shared sort', () => {
		const { getByTestId } = render(<BelowCutoffGroup rows={ROWS} rowContext={CONTEXT} sort={{ key: 'delta_dps', dir: 'desc' }} />);
		fireEvent.click(getByTestId('upgrades-below-cutoff-trigger'));

		const ids = within(getByTestId('upgrades-results-table'))
			.getAllByTestId('upgrades-result-row')
			.map(row => row.dataset.itemId);
		expect(ids).toEqual([SECOND_ID, FIRST_ID]);
	});
});
