import { loadEnglishBundles } from '@features/upgrades/testing/locales';
import { fakeHost } from '@sim/testing';
import { fireEvent, render, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { fixtureRow } from '../../testing/ranking_fixture';

// The row toggles read the page's store; `RowToggles.test.tsx` covers them.
vi.mock('../RowToggles', () => ({ FavoriteToggle: () => <span data-testid="favorite-stub" />, BatchToggle: () => <span data-testid="batch-stub" /> }));
vi.mock('@ui-kit/hooks/useActionId', () => ({ useActionId: () => ({ iconUrl: '', name: '', href: '', ready: true }) }));

const { BelowCutoffGroup } = await import('./BelowCutoffGroup');

loadEnglishBundles({ character: true });

const ROWS = [fixtureRow(5), fixtureRow(3)];
const [FIRST_ID, SECOND_ID] = ROWS.map(row => String(row.itemId));
const CONTEXT = { itemOf: () => undefined, sim: fakeHost().sim, tip: {}, tagsOf: () => [] };
const HEAD = (
	<thead data-testid="head-stub">
		<tr />
	</thead>
);

describe('BelowCutoffGroup', () => {
	it('starts collapsed, with its row count, and renders no table until opened', () => {
		const { getByTestId, queryByTestId } = render(<BelowCutoffGroup head={HEAD} rows={ROWS} rowContext={CONTEXT} />);

		expect(getByTestId('upgrades-below-cutoff-trigger').textContent).toBe('2 item(s) below the cutoff');
		expect(queryByTestId('upgrades-results-table')).toBeNull();
	});

	it('renders the head it is given above its rows', () => {
		const { getByTestId } = render(<BelowCutoffGroup head={HEAD} rows={ROWS} rowContext={CONTEXT} />);
		fireEvent.click(getByTestId('upgrades-below-cutoff-trigger'));

		expect(within(getByTestId('upgrades-results-table')).getByTestId('head-stub')).not.toBeNull();
	});

	it('shows its rows, numbered from 1, when opened', () => {
		const { getByTestId } = render(<BelowCutoffGroup head={HEAD} rows={ROWS} rowContext={CONTEXT} />);
		fireEvent.click(getByTestId('upgrades-below-cutoff-trigger'));

		const table = getByTestId('upgrades-results-table');
		const rows = within(table).getAllByTestId('upgrades-result-row');
		expect(rows.map(row => [within(row).getAllByRole('cell')[0]?.textContent, row.dataset.itemId])).toEqual([
			['1', FIRST_ID],
			['2', SECOND_ID],
		]);
	});

	it('orders its rows by the shared sort', () => {
		const { getByTestId } = render(<BelowCutoffGroup head={HEAD} rows={ROWS} rowContext={CONTEXT} sort={{ key: 'delta_dps', dir: 'desc' }} />);
		fireEvent.click(getByTestId('upgrades-below-cutoff-trigger'));

		const ids = within(getByTestId('upgrades-results-table'))
			.getAllByTestId('upgrades-result-row')
			.map(row => row.dataset.itemId);
		expect(ids).toEqual([SECOND_ID, FIRST_ID]);
	});
});
