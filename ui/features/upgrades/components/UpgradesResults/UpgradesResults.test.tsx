import { loadEnglishBundles } from '@features/upgrades/testing/locales';
import { ItemQuality } from '@generated/proto/common';
import { UIItem } from '@generated/proto/ui';
import { SimHostProvider } from '@sim/context/SimHostContext';
import { render, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RankedItem } from '../../model/engine/rank';
import type { ContentPhase, SpecId } from '../../model/engine/types';
import type { RunState } from '../../model/run_state';
import { fakeTabHost } from '../../testing/fake_tab_host';
import { fixtureRow, RANKING_FIXTURE, STOPPED_FIXTURE } from '../../testing/ranking_fixture';

// The row toggles read the page's store; `RowToggles.test.tsx` covers them.
vi.mock('../RowToggles', () => ({ FavoriteToggle: () => <span data-testid="favorite-stub" />, BatchToggle: () => <span data-testid="batch-stub" /> }));
vi.mock('@ui-kit/hooks/useActionId', () => ({ useActionId: () => ({ iconUrl: '', name: '', href: '', ready: true }) }));

// Every row, so the assertions are about the table's order rather than what it windowed; `useVirtualRows.test.tsx` covers the windowing.
vi.mock('../../hooks/useVirtualRows', () => ({
	useVirtualRows: (keys: readonly string[]) => ({ indexes: keys.map((_key, index) => index), paddingTop: 0, paddingBottom: 0, measureRow: () => {} }),
}));
// The engine reads set membership from the sim database, which a unit test does not load.
vi.mock('../../model/engine/items', async importOriginal => ({
	...(await importOriginal<typeof import('../../model/engine/items')>()),
	getItem: (itemId: number) =>
		itemId === 31034 || itemId === 31044 ? { setId: 676, setName: 'Thunderheart Harness' } : itemId === 0 ? undefined : { setId: null, setName: null },
}));

// The pool and the BiS tags are built from the page's item database, which a unit test does not load: Phase 1 here has no
// candidates, every other phase one; the newest BiS set is Phase 3's.
vi.mock('../../model/data/data', async importOriginal => ({
	...(await importOriginal<typeof import('../../model/data/data')>()),
	poolFor: (_host: unknown, _presets: unknown, phase: number) =>
		phase === 1 ? [] : [{ itemId: 32332, name: 'Torch of the Damned', slot: 'weapon', phase: 2, source: { kind: 'unknown' } }],
	bisTagPhaseFor: (_host: unknown, _presets: unknown, phase: number) => (phase < 3 ? undefined : { tagsFromPhase: 3, requestedPhase: phase }),
}));

const { UpgradesResults } = await import('./UpgradesResults');
const { upgradesStoreFor } = await import('../../hooks/useUpgradesStore');

loadEnglishBundles({ character: true });

const host = fakeTabHost({
	player: { getSpec: () => undefined },
	individualConfig: { presets: { gear: [] } },
	sim: {
		db: {
			getItemById: (id: number) => (id === 32332 ? UIItem.create({ id, name: 'Torch of the Damned', quality: ItemQuality.ItemQualityEpic }) : undefined),
		},
	},
});
// Every test here shares the page's store, so each starts from its initial state (zustand's reset guide).
beforeEach(() => {
	const store = upgradesStoreFor(host);
	store.setState(store.getInitialState(), true);
});
const show = (run: RunState, specId?: SpecId) =>
	render(
		<SimHostProvider host={host}>
			<UpgradesResults run={run} selectedSets={[]} specId={specId} />
		</SimHostProvider>,
	);

const activePane = (container: HTMLElement) => {
	const panes = [...container.querySelectorAll<HTMLElement>('[data-testid="tab-pane"]')].filter(pane => !pane.hidden && !pane.hasAttribute('inert'));
	expect(panes).toHaveLength(1);
	return panes[0]!;
};
const namesIn = (root: HTMLElement) =>
	within(root)
		.queryAllByTestId('upgrades-item-name')
		.map(name => name.textContent);

describe('UpgradesResults', () => {
	it('shows a running run’s rows best first, in a table with nothing to sort', () => {
		const landed = [fixtureRow(3), fixtureRow(0), fixtureRow(2)];
		const { getByTestId, queryByTestId } = show({ status: 'running', runId: 1, startedAt: 0, landedRows: landed, stopping: false });

		const table = getByTestId('upgrades-results-table');
		expect(table.dataset.provisional).toBe('true');
		expect(namesIn(table)).toEqual(['Torch of the Damned', 'Cursed Vision of Sargeras', "Vengeful Gladiator's Greatsword"]);
		expect(queryByTestId('upgrades-sort-item')).toBeNull();
		expect(queryByTestId('upgrades-tab-tabs')).toBeNull();
	});

	it('shows a stopped run in sub-tabs with the rows Stop never reached left out', () => {
		const { container, getByTestId } = show({ status: 'stopped', runId: 1, result: STOPPED_FIXTURE });

		expect(getByTestId('upgrades-tab-tabs')).not.toBeNull();
		const names = namesIn(activePane(container));
		expect(names).toContain('Torch of the Damned');
		expect(names).not.toContain("Shadowmaster's Boots");
		expect(names).not.toContain('Swiftsteel Bracers');
		expect(within(container).queryByText("Shadowmaster's Boots")).toBeNull();
	});

	it('colours names from the sim database and marks rows from the finished ranking', () => {
		const { container } = show({ status: 'done', runId: 1, result: RANKING_FIXTURE });
		const pane = activePane(container);

		expect(within(pane).getAllByTestId('upgrades-item-name')[0]?.className).toBe('text-quality-epic');
		expect(within(pane).getAllByTestId('upgrades-set-bonus')).toHaveLength(1);
	});

	it('works out a row’s own set break from the gear the ranking was measured on (ticket 536)', () => {
		const worn = [8345, 30017, 30055, 29994, 30101, 29966, 31034, 30106, 31044, 28545, 29997, 30052, 30627, 29383, 32014, 0, 32387];
		const legs: RankedItem = { ...fixtureRow(0), itemId: 30900, name: 'Bow-stitched Leggings', slot: 'legs', deltaDps: 3.5, deltaPct: 0.2 };
		const result = {
			...RANKING_FIXTURE,
			items: [legs],
			brokenSetValues: [{ setId: 676, setName: 'Thunderheart Harness', threshold: 2, dps: 106.24, se: 2 }],
		};

		const measured = show({ status: 'done', runId: 1, result, measuredOn: { wornItemIds: worn, specId: 'feral' } });
		expect(within(activePane(measured.container)).getAllByTestId('upgrades-set-bonus')).toHaveLength(1);
		measured.unmount();

		const unmeasured = show({ status: 'done', runId: 1, result });
		expect(within(activePane(unmeasured.container)).queryAllByTestId('upgrades-set-bonus')).toHaveLength(0);
	});

	it('lists the candidates the engine dropped under a finished or a stopped run, and not while one runs', () => {
		const done = show({ status: 'done', runId: 1, result: RANKING_FIXTURE });
		expect(within(done.container).getByTestId('upgrades-substitutions')).not.toBeNull();
		done.unmount();

		const stopped = show({ status: 'stopped', runId: 1, result: STOPPED_FIXTURE });
		expect(within(stopped.container).getByTestId('upgrades-substitutions')).not.toBeNull();
		stopped.unmount();

		const running = show({ status: 'running', runId: 1, startedAt: 0, landedRows: [fixtureRow(0)], stopping: false });
		expect(within(running.container).queryByTestId('upgrades-substitutions')).toBeNull();
	});

	describe('a finished run with no rows (ticket 515)', () => {
		const emptyAt = (maxPhase: ContentPhase): RunState => ({
			status: 'done',
			runId: 1,
			result: { ...RANKING_FIXTURE, items: [], assumptions: { ...RANKING_FIXTURE.assumptions, maxPhase } },
		});

		it('says the phase has no candidate list when the spec has none at that phase', () => {
			const { getByTestId } = show(emptyAt(1), 'ret');
			const text = getByTestId('upgrades-empty-state').textContent;
			expect(text).toContain('No candidate list for Phase 1');
			expect(text).not.toContain('No upgrades found');
		});

		it('says no upgrades were found when the phase has a list', () => {
			const { getByTestId } = show(emptyAt(3), 'ret');
			expect(getByTestId('upgrades-empty-state').textContent).toContain('No upgrades found');
		});

		it('says no upgrades were found when the spec is not known', () => {
			const { getByTestId } = show(emptyAt(1));
			expect(getByTestId('upgrades-empty-state').textContent).toContain('No upgrades found');
		});
	});

	it('says the BiS tags are from an older phase when wowsims has no set for the ranked one (ticket 699)', () => {
		const at = (maxPhase: ContentPhase): RunState => ({
			status: 'done',
			runId: 1,
			result: { ...RANKING_FIXTURE, assumptions: { ...RANKING_FIXTURE.assumptions, maxPhase } },
		});
		const older = show(at(5));
		expect(older.getByTestId('upgrades-bis-phase-notice').textContent).toContain('from Phase 3');
		older.unmount();

		expect(show(at(3)).queryByTestId('upgrades-bis-phase-notice')).toBeNull();
	});

	it('says what to do before the first run, naming the Simulate button (ticket 604)', () => {
		const { getByTestId } = show({ status: 'idle' });
		const text = getByTestId('upgrades-empty-state').textContent;
		expect(text).toContain('No ranking yet');
		expect(text).toContain('Simulate');
		expect(text).not.toContain('Run');
	});
});
