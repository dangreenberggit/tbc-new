import { loadEnglishBundles } from '@features/upgrades/testing/locales';
import { SimHostProvider } from '@sim/context/SimHostContext';
import type { IndividualSimHost } from '@sim/sim_host';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RankedItem } from '../../model/engine/rank';
import { applyView } from '../../model/engine/view';
import { resultsViewFor, type ResultsViewResult, stoppedView } from '../../model/results_view';
import { fakeTabHost } from '../../testing/fake_tab_host';
import { RANKING_FIXTURE, STOPPED_FIXTURE } from '../../testing/ranking_fixture';

// The row toggles read the page's store; `RowToggles.test.tsx` covers them.
vi.mock('../RowToggles', () => ({ FavoriteToggle: () => <span data-testid="favorite-stub" />, BatchToggle: () => <span data-testid="batch-stub" /> }));
vi.mock('@ui-kit/hooks/useActionId', () => ({ useActionId: () => ({ iconUrl: '', name: '', href: '', ready: true }) }));

// Every row, so the assertions are about the table's order rather than what it windowed; `useVirtualRows.test.tsx` covers the windowing.
vi.mock('../../hooks/useVirtualRows', () => ({
	useVirtualRows: (keys: readonly string[]) => ({ indexes: keys.map((_key, index) => index), paddingTop: 0, paddingBottom: 0, measureRow: () => {} }),
}));

const { ResultsPanes } = await import('./ResultsPanes');

loadEnglishBundles({ character: true });

const CONTEXT = { itemOf: () => undefined, sim: fakeTabHost().sim, tip: {}, tagsOf: () => [] };
const VIEW = applyView(RANKING_FIXTURE);

// A page per test, so a sort one test stores does not reach the next.
let host: IndividualSimHost<any>;
beforeEach(() => {
	host = fakeTabHost({ player: { getSpec: () => undefined } });
});
const panes = (view: ResultsViewResult) => (
	<SimHostProvider host={host}>
		<ResultsPanes view={view} rowContext={CONTEXT} />
	</SimHostProvider>
);

const tabStrip = (container: HTMLElement) => within(within(container).getByTestId('upgrades-tab-tabs'));
const tabLabels = (container: HTMLElement) =>
	tabStrip(container)
		.getAllByRole('tab')
		.map(tab => tab.textContent);
const clickTab = (container: HTMLElement, label: string) => fireEvent.click(tabStrip(container).getByRole('tab', { name: new RegExp(`^${label}`) }));
const activePane = (container: HTMLElement) => {
	const panes = [...container.querySelectorAll<HTMLElement>('[data-testid="tab-pane"]')].filter(pane => !pane.hidden && !pane.hasAttribute('inert'));
	expect(panes).toHaveLength(1);
	return panes[0]!;
};
const namesIn = (pane: HTMLElement) =>
	within(pane)
		.queryAllByTestId('upgrades-item-name')
		.map(name => name.textContent);

describe('ResultsPanes', () => {
	it('offers the Upgrades list and one tab per slot with a row, in slot order, counting each slot’s shortlist', () => {
		const { container } = render(panes(VIEW));
		expect(tabLabels(container)).toEqual(['Upgrades', 'Head (2)', 'Chest (2)', 'Legs (1)', 'Trinket 1 (1)', 'Main Hand (4)']);
	});

	// Only the shown pane is mounted (ticket 565), so only its tab can name the pane it controls.
	it('links the shown tab to its pane and the other tabs to none', async () => {
		const { container } = render(panes(VIEW));
		const controls = () =>
			tabStrip(container)
				.getAllByRole('tab')
				.map(tab => tab.getAttribute('aria-controls'));
		expect(controls()).toEqual(['upgrades-pane-shopping-list', '', '', '', '', '']);
		expect(container.querySelector('#upgrades-pane-shopping-list')?.getAttribute('data-testid')).toBe('tab-pane');

		clickTab(container, 'Head');
		expect(controls()).toEqual(['', 'upgrades-pane-head', '', '', '', '']);
		await waitFor(() => expect(container.querySelector('#upgrades-pane-head')?.getAttribute('data-testid')).toBe('tab-pane'));
	});

	it('keeps no hidden pane in the document', async () => {
		const { container } = render(panes(VIEW));
		expect(container.querySelectorAll('[data-testid="tab-pane"]')).toHaveLength(1);

		clickTab(container, 'Head');
		await waitFor(() => expect(container.querySelectorAll('[data-testid="tab-pane"]')).toHaveLength(1));
		expect(container.querySelector('#upgrades-pane-shopping-list')).toBeNull();
		expect(namesIn(activePane(container))).toEqual(['Cursed Vision of Sargeras', 'Lightbringer Faceguard']);
	});

	it('keeps a below-cutoff group open across a switch to another pane and back', async () => {
		const { container } = render(panes(VIEW));
		fireEvent.click(within(activePane(container)).getByTestId('upgrades-below-cutoff-trigger'));
		const groupRows = () => within(within(activePane(container)).getByTestId('upgrades-below-cutoff')).queryAllByTestId('upgrades-result-row');
		const opened = groupRows().length;
		expect(opened).toBeGreaterThan(0);

		clickTab(container, 'Head');
		await waitFor(() => expect(container.querySelector('#upgrades-pane-shopping-list')).toBeNull());
		clickTab(container, 'Upgrades');
		await waitFor(() => expect(container.querySelector('#upgrades-pane-head')).toBeNull());
		expect(groupRows()).toHaveLength(opened);
	});

	it('opens on the Upgrades list and shows a slot’s rows when its tab is clicked', () => {
		const { container } = render(panes(VIEW));
		expect(namesIn(activePane(container))).toHaveLength(VIEW.shortlist.length);

		clickTab(container, 'Head');
		expect(namesIn(activePane(container))).toEqual(['Cursed Vision of Sargeras', 'Lightbringer Faceguard']);
	});

	it('applies a sort chosen in one pane to every pane', () => {
		const { container } = render(panes(VIEW));
		fireEvent.click(within(activePane(container)).getByTestId('upgrades-sort-item'));
		fireEvent.click(within(activePane(container)).getByTestId('upgrades-sort-item'));

		clickTab(container, 'Main Hand');
		expect(namesIn(activePane(container))).toEqual([
			"Cataclysm's Edge",
			'Torch of the Damned',
			'Twinblade of the Phoenix',
			"Vengeful Gladiator's Greatsword",
		]);
	});

	it('exports the Upgrades list in the order the shared sort shows it, whichever pane is open', () => {
		const { container } = render(panes(VIEW));
		const exportedIds = () => {
			const payload: { items: Array<{ id: number }> } = JSON.parse(
				container.querySelector<HTMLTextAreaElement>('[data-testid="upgrades-export-area"]')?.value ?? '',
			);
			return payload.items.map(item => item.id);
		};
		const shownIds = () =>
			within(activePane(container))
				.getAllByTestId('upgrades-result-row')
				.filter(row => row.dataset.owned !== 'true')
				.map(row => Number(row.dataset.itemId));

		fireEvent.click(within(activePane(container)).getByTestId('upgrades-sort-item'));
		fireEvent.click(within(activePane(container)).getByTestId('upgrades-sort-item'));
		clickTab(container, 'Head');
		clickTab(container, 'Upgrades');
		// Lightbringer Greaves (30993) exports its tier token, 31098; every other shortlisted row exports its own id.
		expect(exportedIds()).toEqual(shownIds().map(id => (id === 30993 ? 31098 : id)));
		expect(exportedIds()).toContain(31098);
	});

	it('closes a below-cutoff group that a new result took away, as before its state moved here', () => {
		const { container, rerender } = render(panes(VIEW));
		const trigger = () => within(activePane(container)).queryByTestId('upgrades-below-cutoff-trigger');
		fireEvent.click(trigger()!);
		expect(trigger()?.getAttribute('aria-expanded')).toBe('true');

		rerender(panes({ ...VIEW, rows: VIEW.rows.filter(row => !row.belowCutoffInView) }));
		expect(trigger()).toBeNull();
		rerender(panes(VIEW));
		expect(trigger()?.getAttribute('aria-expanded')).toBe('false');
	});

	// Ticket 528 (option A): Helm of the Illidari Shatterer (2.91) misses the 3 DPS bar but is put on a BiS list here.
	it('shows a BiS-list row below the cutoff in the main table, marked in text, and leaves it out of the counts and the export', () => {
		const exportedIds = (container: HTMLElement) => {
			const payload: { items: Array<{ id: number }> } = JSON.parse(
				container.querySelector<HTMLTextAreaElement>('[data-testid="upgrades-export-area"]')?.value ?? '',
			);
			return payload.items.map(item => item.id);
		};
		const withoutTag = exportedIds(render(panes(VIEW)).container);
		const items = RANKING_FIXTURE.items.map((row): RankedItem => (row.itemId === 32373 ? { ...row, bisTags: ['BiS'] } : row));
		const { container } = render(panes(applyView({ ...RANKING_FIXTURE, items })));
		const pane = activePane(container);
		const helmRow = within(pane)
			.getAllByTestId('upgrades-result-row')
			.find(row => row.dataset.itemId === '32373');
		expect(within(helmRow!).getByTestId('upgrades-not-upgrade').textContent).toBe('(Not an upgrade)');
		expect(within(pane).getAllByTestId('upgrades-not-upgrade')).toHaveLength(1);
		expect(within(pane).queryByTestId('upgrades-below-cutoff')).toBeNull();
		expect(tabLabels(container)).toContain('Head (2)');
		expect(exportedIds(container)).toEqual(withoutTag);
		expect(withoutTag).not.toContain(32373);
	});

	// Ticket 614.
	it('under BiS only keeps every slot tab, and dims a slot with no BiS-list row at (0) over an empty pane', () => {
		const bisOnly = resultsViewFor({ status: 'done', runId: 1, result: RANKING_FIXTURE }, { withSetPotential: false, onlyBis: true })!;
		const { container } = render(panes(bisOnly));
		expect(tabLabels(container)).toEqual(['Upgrades', 'Head (1)', 'Chest (0)', 'Legs (0)', 'Trinket 1 (1)', 'Main Hand (1)']);
		// `TabNav` puts a tab's class on the list item around it.
		expect(tabStrip(container).getByRole('tab', { name: /^Chest/ }).parentElement?.className).toContain('opacity-60');

		clickTab(container, 'Chest');
		expect(namesIn(activePane(container))).toEqual([]);
	});

	it('falls back to the Upgrades list when the open slot has no rows in a new result', () => {
		const { container, rerender } = render(panes(VIEW));
		clickTab(container, 'Legs');
		expect(namesIn(activePane(container))).toEqual(['Lightbringer Greaves']);

		const withoutLegs = stoppedView({ ...STOPPED_FIXTURE, items: STOPPED_FIXTURE.items.filter(row => row.slot !== 'legs') });
		rerender(panes(withoutLegs));
		expect(tabLabels(container)).not.toContain('Legs (1)');
		expect(namesIn(activePane(container))).toHaveLength(withoutLegs.shortlist.length);
	});
});
