import { ItemQuality } from '@generated/proto/common';
import i18n from '@i18n/config';
import { SimHostProvider } from '@sim/context/SimHostContext';
import { fakeHost } from '@sim/testing';
import { render, within } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import englishCharacter from '../../../../../assets/locales/en/character.json';
import englishTranslations from '../../../../../assets/locales/en/translation.json';
import type { RankedItem } from '../../model/engine/rank';
import type { RunState } from '../../model/run_reducer';
import { fixtureRow, RANKING_FIXTURE, STOPPED_FIXTURE } from '../../testing/ranking_fixture';

vi.mock('@ui-kit/hooks/useActionId', () => ({ useActionId: () => ({ iconUrl: '', name: '', href: '', ready: true }) }));
// The engine reads set membership from the sim database, which a unit test does not load.
vi.mock('../../model/engine/items', async importOriginal => ({
	...(await importOriginal<typeof import('../../model/engine/items')>()),
	getItem: (itemId: number) =>
		itemId === 31034 || itemId === 31044 ? { setId: 676, setName: 'Thunderheart Harness' } : itemId === 0 ? undefined : { setId: null, setName: null },
}));

const { UpgradesResults } = await import('./UpgradesResults');

beforeAll(() => {
	i18n.addResourceBundle('en', 'translation', englishTranslations, true, true);
	i18n.addResourceBundle('en', 'character', englishCharacter, true, true);
});
afterAll(() => {
	i18n.removeResourceBundle('en', 'translation');
	i18n.removeResourceBundle('en', 'character');
});

const host = fakeHost({
	sim: { db: { getItemById: (id: number) => (id === 32332 ? { name: 'Torch of the Damned', quality: ItemQuality.ItemQualityEpic } : undefined) } },
});
const show = (run: RunState) =>
	render(
		<SimHostProvider host={host}>
			<UpgradesResults run={run} />
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
		expect(within(pane).getAllByTestId('upgrades-cutoff-arm')).toHaveLength(1);
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

	it('says what to do before the first run', () => {
		const { getByTestId } = show({ status: 'idle' });
		expect(getByTestId('upgrades-empty-state').textContent).toContain('No ranking yet');
	});
});
