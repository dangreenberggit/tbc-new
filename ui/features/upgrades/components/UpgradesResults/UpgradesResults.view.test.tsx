import { loadEnglishBundles } from '@features/upgrades/testing/locales';
import { ItemQuality } from '@generated/proto/common';
import { UIItem } from '@generated/proto/ui';
import { SimHostProvider } from '@sim/context/SimHostContext';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RankedItem, Ranking } from '../../model/engine/rank';
import type { RunState } from '../../model/run_state';
import type { SetOption } from '../../model/settings_pool';
import { fakeTabHost } from '../../testing/fake_tab_host';
import { fixtureRow, RANKING_FIXTURE, STOPPED_FIXTURE } from '../../testing/ranking_fixture';

// The row toggles read the page's store; `RowToggles.test.tsx` covers them.
vi.mock('../RowToggles', () => ({ FavoriteToggle: () => <span />, BatchToggle: () => <span /> }));
vi.mock('@ui-kit/hooks/useActionId', () => ({ useActionId: () => ({ iconUrl: '', name: '', href: '', ready: true }) }));

// Every row, so the assertions are about the table's order rather than what it windowed; `useVirtualRows.test.tsx` covers the windowing.
vi.mock('../../hooks/useVirtualRows', () => ({
	useVirtualRows: (keys: readonly string[]) => ({ indexes: keys.map((_key, index) => index), paddingTop: 0, paddingBottom: 0, measureRow: () => {} }),
}));

const { UpgradesResults } = await import('./UpgradesResults');
const { upgradesStoreFor } = await import('../../hooks/useUpgradesStore');

loadEnglishBundles({ character: true });

const host = fakeTabHost({
	player: { getSpec: () => undefined },
	sim: { db: { getItemById: (id: number) => UIItem.create({ id, name: 'Item', quality: ItemQuality.ItemQualityEpic }) } },
});
// Every test here shares the page's store, so each starts from its initial state (zustand's reset guide).
beforeEach(() => {
	const store = upgradesStoreFor(host);
	store.setState(store.getInitialState(), true);
});
const show = (run: RunState, selectedSets: readonly SetOption[] = []) =>
	render(
		<SimHostProvider host={host}>
			<UpgradesResults run={run} selectedSets={selectedSets} />
		</SimHostProvider>,
	);
const done = (result: Ranking): RunState => ({ status: 'done', runId: 1, result });

const activePane = (container: HTMLElement) =>
	[...container.querySelectorAll<HTMLElement>('[data-testid="tab-pane"]')].find(pane => !pane.hidden && !pane.hasAttribute('inert'))!;
const rowIds = (container: HTMLElement) =>
	within(activePane(container))
		.getAllByTestId('upgrades-result-row')
		.map(row => Number(row.dataset.itemId));
const rowOf = (container: HTMLElement, itemId: number) =>
	within(activePane(container))
		.getAllByTestId('upgrades-result-row')
		.find(row => Number(row.dataset.itemId) === itemId)!;
const tick = (container: HTMLElement, testId: string) => fireEvent.click(within(within(container).getByTestId(testId)).getByRole('checkbox'));

// Lightbringer Faceguard (4.42) with a measured 2-piece bonus, which Set potential credits past Dragonspine Trophy (5.2).
const faceguard: RankedItem = {
	...fixtureRow(10),
	setContext: { ...fixtureRow(10).setContext!, futureBonuses: [{ threshold: 2, piecesNeeded: 1, dps: 20.04, pieces: [], breaks: [] }] },
};
const WITH_POTENTIAL = { ...RANKING_FIXTURE, items: RANKING_FIXTURE.items.map(row => (row.itemId === faceguard.itemId ? faceguard : row)) };
const ahead = (ids: number[], first: number, second: number) => ids.indexOf(first) < ids.indexOf(second);

describe('UpgradesResults view toggles', () => {
	it('keeps a ticked toggle in the tab store, so the results shown again keep it ticked', () => {
		const first = show(done(RANKING_FIXTURE));
		tick(first.container, 'upgrades-view-only-bis');
		first.unmount();

		expect(upgradesStoreFor(host).getState().view).toEqual({ withSetPotential: false, onlyBis: true });
		const again = show(done(RANKING_FIXTURE));
		const checked = (testId: string) => within(again.getByTestId(testId)).getByRole('checkbox').getAttribute('aria-checked');
		expect(checked('upgrades-view-only-bis')).toBe('true');
		expect(checked('upgrades-view-set-potential')).toBe('false');
	});

	it('shows both toggles over a finished run only, and BiS only only when a row is on a BiS list', () => {
		const finished = show(done(RANKING_FIXTURE));
		expect(finished.queryByTestId('upgrades-view-set-potential')).not.toBeNull();
		expect(finished.queryByTestId('upgrades-view-only-bis')).not.toBeNull();
		finished.unmount();

		const untagged = show(done({ ...RANKING_FIXTURE, items: RANKING_FIXTURE.items.map(row => ({ ...row, bisTags: [] })) }));
		expect(untagged.queryByTestId('upgrades-view-set-potential')).not.toBeNull();
		expect(untagged.queryByTestId('upgrades-view-only-bis')).toBeNull();
		untagged.unmount();

		// A stopped run's table is settled too, so it offers Filter by source, but not the toggles.
		const stopped = show({ status: 'stopped', runId: 1, result: STOPPED_FIXTURE });
		expect(stopped.queryByTestId('upgrades-view-sources-button')).not.toBeNull();
		expect(stopped.queryByTestId('upgrades-view-set-potential')).toBeNull();
		expect(stopped.queryByTestId('upgrades-view-only-bis')).toBeNull();
		stopped.unmount();

		const running = show({ status: 'running', runId: 1, startedAt: 0, landedRows: [fixtureRow(0)], stopping: false });
		expect(running.queryByTestId('upgrades-view-toggles')).toBeNull();
	});

	it('with BiS only, leaves the rows on a BiS list', () => {
		const { container } = show(done(RANKING_FIXTURE));
		tick(container, 'upgrades-view-only-bis');
		expect(rowIds(container)).toEqual([32332, 32235, 28830]);
	});

	it('with Set potential, moves a row with set credit above a plain row of higher ΔDPS, in the view and in the ΔDPS sort', () => {
		const { container } = show(done(WITH_POTENTIAL));
		expect(ahead(rowIds(container), 28830, 30989)).toBe(true);

		tick(container, 'upgrades-view-set-potential');
		expect(ahead(rowIds(container), 30989, 28830)).toBe(true);

		fireEvent.click(within(activePane(container)).getByTestId('upgrades-sort-delta_dps'));
		expect(ahead(rowIds(container), 30989, 28830)).toBe(true);
	});

	it('with Set potential, shows the popover total in the set row’s ΔDPS cell, and the bare ΔDPS without it', () => {
		const { container } = show(done(WITH_POTENTIAL));
		const figure = () => within(rowOf(container, faceguard.itemId)).getByRole('button');
		expect(figure().textContent).toBe('+4.4');

		tick(container, 'upgrades-view-set-potential');
		vi.useFakeTimers();
		try {
			fireEvent.mouseEnter(figure());
			fireEvent.mouseMove(figure());
			act(() => vi.advanceTimersByTime(1000));
		} finally {
			vi.useRealTimers();
		}
		const total = within(screen.getByTestId('upgrades-set-bonus-tip-total')).getByRole('definition').textContent;
		expect(total).toBe('+24.5');
		expect(figure().textContent).toBe(total);
	});

	it('badges a row with the name of each selected set that holds it', () => {
		const p3: SetOption = { key: 'preset:3:P3', name: 'P3', label: 'P3', phase: 3, kind: 'preset', itemIds: [32332], inPool: 1 };
		const { container } = show(done(RANKING_FIXTURE), [p3]);
		const torch = within(activePane(container)).getAllByTestId('upgrades-result-row')[0]!;
		expect(
			within(torch)
				.getAllByTestId('upgrades-bis-badge')
				.map(badge => badge.textContent),
		).toEqual(['P3']);
	});
});

const tabLabels = (container: HTMLElement) =>
	within(within(container).getByTestId('upgrades-tab-tabs'))
		.getAllByRole('tab')
		.map(tab => tab.textContent);
const tabNames = (container: HTMLElement) => tabLabels(container).map(label => label?.replace(/ \(\d+\)$/, ''));
const clickTab = (container: HTMLElement, label: string) =>
	fireEvent.click(within(within(container).getByTestId('upgrades-tab-tabs')).getByRole('tab', { name: new RegExp(`^${label}`) }));
const openSourcesDialog = (container: HTMLElement) => fireEvent.click(within(container).getByTestId('upgrades-view-sources-button'));
const closeSourcesDialog = () => fireEvent.click(within(screen.getByTestId('upgrades-view-sources-dialog')).getByTestId('sim-dialog-close'));
const untickSource = (key: string) =>
	fireEvent.click(within(screen.getAllByTestId('upgrades-view-source-row').find(row => row.dataset.source === key)!).getByRole('checkbox'));

describe('UpgradesResults Filter by source', () => {
	it('drops a hidden source’s rows from every pane, keeps every slot tab, and re-ranks nothing', () => {
		const { container } = show(done(RANKING_FIXTURE));
		const tabsBefore = tabNames(container);
		const { run, settings } = upgradesStoreFor(host).getState();
		const exportCount = () => within(container).getByTestId('upgrades-export-count').textContent;
		expect(exportCount()).not.toBe('5 items');

		openSourcesDialog(container);
		untickSource('Black Temple');
		closeSourcesDialog();

		expect(rowIds(container)).toEqual([30902, 33688, 28830, 30989, 29993, 30905]);
		expect(within(container).getByTestId('upgrades-view-sources-summary').textContent).toBe('1 of 5 sources hidden');
		expect(tabNames(container)).toEqual(tabsBefore);
		expect(tabLabels(container)).toContain('Legs (0)');
		// The filter is view state: the run and the settings a staleness check compares are the same objects.
		expect(upgradesStoreFor(host).getState().run).toBe(run);
		expect(upgradesStoreFor(host).getState().settings).toBe(settings);
		// The export reads the cut shortlist: its six rows less Dragonspine Trophy, which is owned.
		expect(exportCount()).toBe('5 items');

		// Legs' only row, Leggings of the Forgotten Conqueror, is a Black Temple token.
		clickTab(container, 'Legs');
		expect(within(activePane(container)).getByTestId('upgrades-empty-state').textContent).toBe('No rows from the shown sources.');
	});

	it('keeps the panes and their tabs when every source is hidden, and says so in the Upgrades pane', () => {
		const { container } = show(done(RANKING_FIXTURE));
		const tabsBefore = tabNames(container);

		openSourcesDialog(container);
		fireEvent.click(screen.getByTestId('upgrades-view-sources-hide-all'));
		closeSourcesDialog();

		expect(tabNames(container)).toEqual(tabsBefore);
		expect(within(activePane(container)).getByTestId('upgrades-empty-state').textContent).toBe('No rows from the shown sources.');
		expect(within(container).queryByText('No upgrades found')).toBeNull();
		expect(within(container).getByTestId('upgrades-view-sources-summary').textContent).toBe('5 of 5 sources hidden');

		openSourcesDialog(container);
		fireEvent.click(screen.getByTestId('upgrades-view-sources-show-all'));
		closeSourcesDialog();
		expect(rowIds(container)).toHaveLength(RANKING_FIXTURE.items.filter(row => !row.belowCutoff).length);
	});

	it('keeps a hidden source hidden when the results show again', () => {
		const first = show(done(RANKING_FIXTURE));
		openSourcesDialog(first.container);
		untickSource('Hyjal Summit');
		closeSourcesDialog();
		first.unmount();

		expect(upgradesStoreFor(host).getState().hiddenSources).toEqual(['Hyjal Summit']);
		const again = show(done(RANKING_FIXTURE));
		expect(rowIds(again.container)).not.toContain(30902);
		openSourcesDialog(again.container);
		const hyjal = screen.getAllByTestId('upgrades-view-source-row').find(row => row.dataset.source === 'Hyjal Summit')!;
		expect(within(hyjal).getByRole('checkbox').getAttribute('aria-checked')).toBe('false');
	});

	it('with BiS only on, keeps the rows both keep', () => {
		const { container } = show(done(RANKING_FIXTURE));
		tick(container, 'upgrades-view-only-bis');
		openSourcesDialog(container);
		untickSource('Black Temple');
		closeSourcesDialog();
		expect(rowIds(container)).toEqual([28830]);
	});

	// Review AD3: the Source cell reads only the hidden sources this view offers (`useResultsView` `actingHidden`).
	it('leaves every Source cell alone for a stored hidden source the view does not offer', () => {
		// Vengeful Gladiator's Greatsword sold for badges and dropped in Black Temple. The dialog lists it under Black
		// Temple, and no row here comes from badges alone, so the view does not offer "Badge vendor".
		const badgeOrRaidSword: RankedItem = {
			...fixtureRow(3),
			source: { kind: 'badge', cost: 150 },
			sources: [
				{ kind: 'badge', cost: 150 },
				{ kind: 'raid', zone: 'Black Temple', boss: 'Illidan Stormrage', origin: 'db' },
			],
		};
		const ranking = { ...RANKING_FIXTURE, items: RANKING_FIXTURE.items.map(row => (row.itemId === badgeOrRaidSword.itemId ? badgeOrRaidSword : row)) };
		// The Source cell is the row's fifth (`ResultRow`).
		const sourceCells = (container: HTMLElement) =>
			within(activePane(container))
				.getAllByTestId('upgrades-result-row')
				.map(row => row.querySelectorAll('td')[4]?.textContent);
		const unfiltered = show(done(ranking));
		const before = sourceCells(unfiltered.container);
		expect(sourceCells(unfiltered.container)[rowIds(unfiltered.container).indexOf(badgeOrRaidSword.itemId)]).toBe('Badge vendor');
		unfiltered.unmount();

		upgradesStoreFor(host).getState().setViewSources(['Badge vendor']);
		const { container } = show(done(ranking));
		expect(sourceCells(container)).toEqual(before);
	});
});
