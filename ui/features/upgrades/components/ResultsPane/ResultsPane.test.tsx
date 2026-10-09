import { loadEnglishBundles } from '@features/upgrades/testing/locales';
import { SimHostProvider } from '@sim/context/SimHostContext';
import type { IndividualSimHost } from '@sim/sim_host';
import { fakeHost } from '@sim/testing';
import { fireEvent, render, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fixtureRow } from '../../testing/ranking_fixture';

// The row toggles read the page's store; `RowToggles.test.tsx` covers them.
vi.mock('../RowToggles', () => ({ FavoriteToggle: () => <span data-testid="favorite-stub" />, BatchToggle: () => <span data-testid="batch-stub" /> }));
vi.mock('@ui-kit/hooks/useActionId', () => ({ useActionId: () => ({ iconUrl: '', name: '', href: '', ready: true }) }));

const { ResultsPane } = await import('./ResultsPane');
const { upgradesStoreFor } = await import('../../hooks/useUpgradesStore');
const { setSort } = await import('../../model/upgrades_store');

loadEnglishBundles({ character: true });

const CONTEXT = { itemOf: () => undefined, sim: fakeHost().sim, tip: {}, tagsOf: () => [] };

// A page per test, so a sort one test stores does not reach the next.
let host: IndividualSimHost<any>;
beforeEach(() => {
	host = fakeHost({ player: { getSpec: () => undefined } });
});
const onPage = (node: ReactNode) => render(<SimHostProvider host={host}>{node}</SimHostProvider>);

describe('ResultsPane', () => {
	it('shows the shortlist in a sortable table and the rest in a collapsed group', () => {
		const { getAllByTestId, getByTestId } = onPage(
			<ResultsPane shortlist={[fixtureRow(0), fixtureRow(1)]} belowCutoff={[fixtureRow(5)]} rowContext={CONTEXT} />,
		);

		expect(getAllByTestId('upgrades-results-table')).toHaveLength(1);
		expect(within(getByTestId('upgrades-results-table')).getAllByTestId('upgrades-result-row')).toHaveLength(2);
		expect(getByTestId('upgrades-sort-item')).not.toBeNull();
		expect(getByTestId('upgrades-below-cutoff-trigger').textContent).toBe('1 item(s) below the cutoff');
	});

	it('names the group columns for screen readers only, with the shared sort, under the shortlist head', () => {
		setSort(upgradesStoreFor(host), [{ id: 'delta_dps', desc: true }]);
		const { getByTestId } = onPage(<ResultsPane shortlist={[fixtureRow(0)]} belowCutoff={[fixtureRow(5)]} rowContext={CONTEXT} />);
		const group = getByTestId('upgrades-below-cutoff');
		fireEvent.click(within(group).getByTestId('upgrades-below-cutoff-trigger'));

		const headers = within(within(group).getByTestId('upgrades-results-table')).getAllByRole('columnheader');
		expect(headers.map(header => header.textContent)).toEqual(['Rank', 'Item', 'Slot', 'DPS', 'Source', 'Favorite', 'Batch sim']);
		expect(headers.map(header => header.getAttribute('aria-sort'))).toEqual([null, 'none', 'none', 'descending', 'none', null, null]);
		expect(within(group).queryByRole('button', { name: /^Item/ })).toBeNull();
	});

	it('gives the group its own sortable head when no shortlist sits above it', () => {
		const { getByTestId } = onPage(<ResultsPane shortlist={[]} belowCutoff={[fixtureRow(5)]} rowContext={CONTEXT} />);
		const group = getByTestId('upgrades-below-cutoff');
		fireEvent.click(within(group).getByTestId('upgrades-below-cutoff-trigger'));

		expect(within(group).getByTestId('upgrades-sort-item')).not.toBeNull();
	});

	it('has no group when every row cleared the cutoff', () => {
		const { queryByTestId } = onPage(<ResultsPane shortlist={[fixtureRow(0)]} belowCutoff={[]} rowContext={CONTEXT} />);
		expect(queryByTestId('upgrades-below-cutoff')).toBeNull();
	});

	it('says no row cleared the cutoff in place of an empty table', () => {
		const { getByTestId, queryByTestId } = onPage(<ResultsPane shortlist={[]} belowCutoff={[fixtureRow(5)]} rowContext={CONTEXT} />);

		expect(queryByTestId('upgrades-results-table')).toBeNull();
		expect(getByTestId('upgrades-empty-state').textContent).toContain('No upgrades found');
		expect(getByTestId('upgrades-below-cutoff')).not.toBeNull();
	});
});
