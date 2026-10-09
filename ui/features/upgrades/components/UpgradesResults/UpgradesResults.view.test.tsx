import { loadEnglishBundles } from '@features/upgrades/testing/locales';
import { ItemQuality } from '@generated/proto/common';
import { UIItem } from '@generated/proto/ui';
import { SimHostProvider } from '@sim/context/SimHostContext';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RankedItem, Ranking } from '../../model/engine/rank';
import type { RunState } from '../../model/run_reducer';
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
	it('shows both toggles over a finished run only, and BiS only only when a row is on a BiS list', () => {
		const finished = show(done(RANKING_FIXTURE));
		expect(finished.queryByTestId('upgrades-view-set-potential')).not.toBeNull();
		expect(finished.queryByTestId('upgrades-view-only-bis')).not.toBeNull();
		finished.unmount();

		const untagged = show(done({ ...RANKING_FIXTURE, items: RANKING_FIXTURE.items.map(row => ({ ...row, bisTags: [] })) }));
		expect(untagged.queryByTestId('upgrades-view-set-potential')).not.toBeNull();
		expect(untagged.queryByTestId('upgrades-view-only-bis')).toBeNull();
		untagged.unmount();

		for (const run of [
			{ status: 'stopped', runId: 1, result: STOPPED_FIXTURE },
			{ status: 'running', runId: 1, startedAt: 0, landedRows: [fixtureRow(0)], stopping: false },
		] as RunState[]) {
			const view = show(run);
			expect(view.queryByTestId('upgrades-view-toggles')).toBeNull();
			view.unmount();
		}
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
