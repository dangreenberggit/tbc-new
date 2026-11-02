import { loadEnglishBundles } from '@features/upgrades/testing/locales';
import { SimHostProvider } from '@sim/context/SimHostContext';
import type { IndividualSimHost } from '@sim/sim_host';
import { fireEvent, render, within } from '@testing-library/react';
import { type ComponentProps, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RankedItem } from '../../model/engine/rank';
import type { PaneRows } from '../../model/results_view';
import { fakeTabHost } from '../../testing/fake_tab_host';
import { fixtureRow, RANKING_FIXTURE } from '../../testing/ranking_fixture';

// The row toggles read the page's store; `RowToggles.test.tsx` covers them.
vi.mock('../RowToggles', () => ({ FavoriteToggle: () => <span data-testid="favorite-stub" />, BatchToggle: () => <span data-testid="batch-stub" /> }));
vi.mock('@ui-kit/hooks/useActionId', () => ({ useActionId: () => ({ iconUrl: '', name: '', href: '', ready: true }) }));

// Every row, so the assertions are about the table's order rather than what it windowed; `useVirtualRows.test.tsx` covers the windowing.
vi.mock('../../hooks/useVirtualRows', () => ({
	useVirtualRows: (keys: readonly string[]) => ({ indexes: keys.map((_key, index) => index), paddingTop: 0, paddingBottom: 0, measureRow: () => {} }),
}));

const { ResultsPane } = await import('./ResultsPane');
const { upgradesStoreFor } = await import('../../hooks/useUpgradesStore');

loadEnglishBundles({ character: true });

const CONTEXT = { itemOf: () => undefined, sim: fakeTabHost().sim, tip: {}, tagsOf: () => [] };

// A page per test, so a sort one test stores does not reach the next.
let host: IndividualSimHost<any>;
beforeEach(() => {
	host = fakeTabHost({ player: { getSpec: () => undefined } });
});
type PaneProps = Omit<ComponentProps<typeof ResultsPane>, 'groupOpen' | 'onGroupOpenChange'>;
/** The pane with its group's open state, as `ResultsPanes` keeps it. */
const Pane = (props: PaneProps) => {
	const [groupOpen, setGroupOpen] = useState(false);
	return <ResultsPane {...props} groupOpen={groupOpen} onGroupOpenChange={setGroupOpen} />;
};
/** A pane's rows as `paneRows` returns them, with no row in the main table marked as not an upgrade. */
const paneRowsOf = (main: readonly RankedItem[], belowCutoff: readonly RankedItem[]): PaneRows => ({
	main: main.map(row => ({ ...row, belowCutoffInView: false })),
	notUpgrades: new Set(),
	belowCutoff: belowCutoff.map(row => ({ ...row, belowCutoffInView: true })),
	emptyReason: 'no-upgrades',
});
const onPage = (props: PaneProps) =>
	render(
		<SimHostProvider host={host}>
			<Pane {...props} />
		</SimHostProvider>,
	);

describe('ResultsPane', () => {
	it('shows the main table as a sortable table and the rest in a collapsed group', () => {
		const { getAllByTestId, getByTestId } = onPage({ rows: paneRowsOf([fixtureRow(0), fixtureRow(1)], [fixtureRow(5)]), rowContext: CONTEXT });

		expect(getAllByTestId('upgrades-results-table')).toHaveLength(1);
		expect(within(getByTestId('upgrades-results-table')).getAllByTestId('upgrades-result-row')).toHaveLength(2);
		expect(getByTestId('upgrades-sort-item')).not.toBeNull();
		expect(getByTestId('upgrades-below-cutoff-trigger').textContent).toBe('1 more item');
	});

	// Owner, 2026-11-02: players "dont know a cutoff exists and we shouldnt have to explain it either".
	it('names the bar as a gain in DPS on the group once a ranking is shown, never as a cutoff', () => {
		const rowContext = { ...CONTEXT, tip: { ranking: RANKING_FIXTURE } };
		const one = onPage({ rows: paneRowsOf([fixtureRow(0)], [fixtureRow(5)]), rowContext });
		expect(one.getByTestId('upgrades-below-cutoff-trigger').textContent).toBe('1 item that gains less than 3 DPS');
		one.unmount();

		const two = onPage({ rows: paneRowsOf([fixtureRow(0)], [fixtureRow(5), fixtureRow(3)]), rowContext });
		expect(two.getByTestId('upgrades-below-cutoff-trigger').textContent).toBe('2 items that gain less than 3 DPS');
	});

	it('names the group columns for screen readers only, with the shared sort, under the main table head', () => {
		upgradesStoreFor(host)
			.getState()
			.setSort([{ id: 'delta_dps', desc: true }]);
		const { getByTestId } = onPage({ rows: paneRowsOf([fixtureRow(0)], [fixtureRow(5)]), rowContext: CONTEXT });
		const group = getByTestId('upgrades-below-cutoff');
		fireEvent.click(within(group).getByTestId('upgrades-below-cutoff-trigger'));

		const headers = within(within(group).getByTestId('upgrades-results-table')).getAllByRole('columnheader');
		expect(headers.map(header => header.textContent)).toEqual(['Rank', 'Item', 'DPS', 'Slot', 'Source', 'Favorite', 'Batch sim']);
		expect(headers.map(header => header.getAttribute('aria-sort'))).toEqual([null, 'none', 'descending', 'none', 'none', null, null]);
		expect(within(group).queryByRole('button', { name: /^Item/ })).toBeNull();
	});

	it('gives the group its own sortable head when no main table sits above it', () => {
		const { getByTestId } = onPage({ rows: paneRowsOf([], [fixtureRow(5)]), rowContext: CONTEXT });
		const group = getByTestId('upgrades-below-cutoff');
		fireEvent.click(within(group).getByTestId('upgrades-below-cutoff-trigger'));

		expect(within(group).getByTestId('upgrades-sort-item')).not.toBeNull();
	});

	it('has no group when every row cleared the cutoff', () => {
		const { queryByTestId } = onPage({ rows: paneRowsOf([fixtureRow(0)], []), rowContext: CONTEXT });
		expect(queryByTestId('upgrades-below-cutoff')).toBeNull();
	});

	// Ticket 748: "No upgrades found" above a row that gained DPS without clearing the bar was false (owner, 2026-11-02:
	// "there could be upgrades but below the cutoff. so it's now lying"), so the closed group is all the pane shows.
	it('shows only the closed group, with no empty-state message, when the only row gained DPS below the bar', () => {
		const gainedBelowBar = fixtureRow(5);
		expect(gainedBelowBar.deltaDps).toBeGreaterThan(0);
		expect(gainedBelowBar.deltaDps).toBeLessThan(RANKING_FIXTURE.cutoff.absDps);
		const rowContext = { ...CONTEXT, tip: { ranking: RANKING_FIXTURE } };
		const { getByTestId, queryByTestId } = onPage({ rows: paneRowsOf([], [gainedBelowBar]), rowContext });

		expect(queryByTestId('upgrades-empty-state')).toBeNull();
		expect(queryByTestId('upgrades-results-table')).toBeNull();
		expect(getByTestId('upgrades-below-cutoff-trigger').textContent).toBe('1 item that gains less than 3 DPS');
	});

	it('says it has no items to show, and suggests wider filters, when the pane has no row at all', () => {
		const { getByTestId } = onPage({ rows: paneRowsOf([], []), rowContext: CONTEXT });
		expect(getByTestId('upgrades-empty-state').textContent).toBe('No items to showTry widening your filters.');
	});

	// "No rows from the shown sources." would be false above rows from the shown sources.
	it('shows no empty-state message beside the group when Filter by source emptied the main table', () => {
		const { getByTestId, queryByTestId } = onPage({ rows: { ...paneRowsOf([], [fixtureRow(5)]), emptyReason: 'no-source-row' }, rowContext: CONTEXT });
		expect(queryByTestId('upgrades-empty-state')).toBeNull();
		expect(getByTestId('upgrades-below-cutoff')).not.toBeNull();
	});

	it('says no row comes from the shown sources when Filter by source emptied the pane', () => {
		const { getByTestId } = onPage({ rows: { ...paneRowsOf([], []), emptyReason: 'no-source-row' }, rowContext: CONTEXT });
		expect(getByTestId('upgrades-empty-state').textContent).toBe('No rows from the shown sources.');
	});
});
