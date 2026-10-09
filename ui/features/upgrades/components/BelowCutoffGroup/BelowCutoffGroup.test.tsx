import { loadEnglishBundles } from '@features/upgrades/testing/locales';
import { SimHostProvider } from '@sim/context/SimHostContext';
import type { IndividualSimHost } from '@sim/sim_host';
import { fakeHost } from '@sim/testing';
import { fireEvent, render, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fixtureRow } from '../../testing/ranking_fixture';

// The row toggles read the page's store; `RowToggles.test.tsx` covers them.
vi.mock('../RowToggles', () => ({ FavoriteToggle: () => <span data-testid="favorite-stub" />, BatchToggle: () => <span data-testid="batch-stub" /> }));
vi.mock('@ui-kit/hooks/useActionId', () => ({ useActionId: () => ({ iconUrl: '', name: '', href: '', ready: true }) }));

// Every row, so the assertions are about the table's order rather than what it windowed; `useVirtualRows.test.tsx` covers the windowing.
vi.mock('../../hooks/useVirtualRows', () => ({
	useVirtualRows: (keys: readonly string[]) => ({ indexes: keys.map((_key, index) => index), paddingTop: 0, paddingBottom: 0, measureRow: () => {} }),
}));

const { BelowCutoffGroup } = await import('./BelowCutoffGroup');
const { useResultsTable } = await import('../../hooks/useResultsTable');
const { upgradesStoreFor } = await import('../../hooks/useUpgradesStore');
const { setSort } = await import('../../model/upgrades_store');
type RankedItem = import('../../model/engine/rank').RankedItem;

loadEnglishBundles({ character: true });

const ROWS = [fixtureRow(5), fixtureRow(3)];
const [FIRST_ID, SECOND_ID] = ROWS.map(row => String(row.itemId));
const CONTEXT = { itemOf: () => undefined, sim: fakeHost().sim, tip: {}, tagsOf: () => [] };
const HEAD = (
	<thead data-testid="head-stub">
		<tr />
	</thead>
);

// A page per test, so a sort one test stores does not reach the next.
let host: IndividualSimHost<any>;
beforeEach(() => {
	host = fakeHost({ player: { getSpec: () => undefined } });
});

/** The group over `rows` with its own table, as `ResultsPane` builds it, and its open state, as `ResultsPanes` keeps it. */
const Group = ({ rows }: { rows: readonly RankedItem[] }) => {
	const table = useResultsTable(rows, CONTEXT);
	const [open, setOpen] = useState(false);
	return <BelowCutoffGroup head={HEAD} table={table} rowContext={CONTEXT} open={open} onOpenChange={setOpen} />;
};
const group = () =>
	render(
		<SimHostProvider host={host}>
			<Group rows={ROWS} />
		</SimHostProvider>,
	);

describe('BelowCutoffGroup', () => {
	it('starts collapsed, with its row count, and renders no table until opened', () => {
		const { getByTestId, queryByTestId } = group();

		expect(getByTestId('upgrades-below-cutoff-trigger').textContent).toBe('2 item(s) below the cutoff');
		expect(queryByTestId('upgrades-results-table')).toBeNull();
	});

	it('renders the head it is given above its rows', () => {
		const { getByTestId } = group();
		fireEvent.click(getByTestId('upgrades-below-cutoff-trigger'));

		expect(within(getByTestId('upgrades-results-table')).getByTestId('head-stub')).not.toBeNull();
	});

	it('shows its rows, numbered from 1, when opened', () => {
		const { getByTestId } = group();
		fireEvent.click(getByTestId('upgrades-below-cutoff-trigger'));

		const table = getByTestId('upgrades-results-table');
		const rows = within(table).getAllByTestId('upgrades-result-row');
		expect(rows.map(row => [within(row).getAllByRole('cell')[0]?.textContent, row.dataset.itemId])).toEqual([
			['1', FIRST_ID],
			['2', SECOND_ID],
		]);
	});

	it('orders its rows by the shared sort', () => {
		setSort(upgradesStoreFor(host), [{ id: 'delta_dps', desc: true }]);
		const { getByTestId } = group();
		fireEvent.click(getByTestId('upgrades-below-cutoff-trigger'));

		const ids = within(getByTestId('upgrades-results-table'))
			.getAllByTestId('upgrades-result-row')
			.map(row => row.dataset.itemId);
		expect(ids).toEqual([SECOND_ID, FIRST_ID]);
	});
});
