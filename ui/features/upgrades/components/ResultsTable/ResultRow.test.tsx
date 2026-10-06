import { ItemQuality } from '@generated/proto/common';
import i18n from '@i18n/config';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import englishCharacter from '../../../../../assets/locales/en/character.json';
import englishTranslations from '../../../../../assets/locales/en/translation.json';
import type { RankedItem } from '../../model/engine/rank';
import { fixtureRow, RANKING_FIXTURE } from '../../testing/ranking_fixture';

// The icon lookup fetches from wowhead; the row's own cells are under test.
vi.mock('@ui-kit/hooks/useActionId', () => ({ useActionId: () => ({ iconUrl: '', name: '', href: '', ready: true }) }));
// The engine reads set membership from the sim database, which a unit test does not load.
vi.mock('../../model/engine/items', async importOriginal => ({
	...(await importOriginal<typeof import('../../model/engine/items')>()),
	getItem: (itemId: number) =>
		itemId === 31034 || itemId === 31044 ? { setId: 676, setName: 'Thunderheart Harness' } : itemId === 0 ? undefined : { setId: null, setName: null },
}));

const { ResultRow } = await import('./ResultRow');
type RowContext = import('./ResultRow').RowContext;

beforeAll(() => {
	i18n.addResourceBundle('en', 'translation', englishTranslations, true, true);
	i18n.addResourceBundle('en', 'character', englishCharacter, true, true);
});
afterAll(() => {
	i18n.removeResourceBundle('en', 'translation');
	i18n.removeResourceBundle('en', 'character');
});

const ITEMS: Record<number, { name: string; quality: ItemQuality }> = {
	32332: { name: 'Torch of the Damned', quality: ItemQuality.ItemQualityEpic },
	30882: { name: 'Blade of Infamy', quality: ItemQuality.ItemQualityEpic },
};
const CONTEXT: RowContext = { itemOf: itemId => ITEMS[itemId], tip: { ranking: RANKING_FIXTURE, specId: 'ret' } };

const renderRow = (row: RankedItem, context: RowContext = CONTEXT) => {
	const { container } = render(
		<table>
			<tbody>
				<ResultRow row={row} position={3} context={context} />
			</tbody>
		</table>,
	);
	const tr = container.querySelector('tr');
	if (!tr) throw new Error('no row rendered');
	return tr;
};

const testIdText = (tr: HTMLElement, testId: string) =>
	within(tr)
		.queryAllByTestId(testId)
		.map(el => el.textContent);

describe('ResultRow', () => {
	it('shows its place, the item, slot, DPS change and source, then two cells for the row toggles', () => {
		const tr = renderRow(fixtureRow(0));
		const cells = within(tr).getAllByRole('cell');
		expect(cells.map(cell => cell.textContent)).toEqual(['3', 'Torch of the DamnedBiS', 'Main Hand', '+45.7', 'Black Temple', '', '']);
		expect(tr.dataset.itemId).toBe('32332');
		expect(tr.dataset.testid).toBe('upgrades-result-row');
	});

	it('colours the item name by its quality', () => {
		const name = within(renderRow(fixtureRow(0))).getByTestId('upgrades-item-name');
		expect(name.className).toBe('text-quality-epic');
	});

	it('tags a BiS row and an Alt row', () => {
		expect(testIdText(renderRow(fixtureRow(0)), 'upgrades-bis-badge')).toEqual(['BiS']);
		expect(testIdText(renderRow(fixtureRow(7)), 'upgrades-bis-badge')).toEqual(['Alt']);
		expect(testIdText(renderRow(fixtureRow(1)), 'upgrades-bis-badge')).toEqual([]);
	});

	it('greys an owned row and says it is owned', () => {
		const owned = renderRow(fixtureRow(7));
		expect(owned.dataset.owned).toBe('true');
		expect(owned.classList.contains('text-muted')).toBe(true);
		expect(owned.textContent).toContain('(Owned)');

		const notOwned = renderRow(fixtureRow(0));
		expect(notOwned.dataset.owned).toBeUndefined();
		expect(notOwned.classList.contains('text-muted')).toBe(false);
	});

	it('names the worn item a two-item swap removes', () => {
		expect(testIdText(renderRow(fixtureRow(8)), 'upgrades-removed-items')).toEqual(['removes worn Blade of Infamy (Off Hand)']);
		expect(testIdText(renderRow(fixtureRow(0)), 'upgrades-removed-items')).toEqual([]);
	});

	it('marks a row only the percentage rule admits, and no row the absolute rule admits', () => {
		const pct = within(renderRow(fixtureRow(6))).getByTestId('upgrades-cutoff-arm');
		expect(pct.textContent).toBe('by % rule');
		expect(pct.title).toBe('Above the cutoff via the percentage arm (0.15%): its absolute DPS is below the 3.4 DPS threshold.');

		expect(testIdText(renderRow({ ...fixtureRow(0), deltaPct: 0.1 }), 'upgrades-cutoff-arm')).toEqual([]);
		expect(testIdText(renderRow(fixtureRow(0)), 'upgrades-cutoff-arm')).toEqual([]);
	});

	it('has no cutoff note before a run settles', () => {
		expect(testIdText(renderRow(fixtureRow(6), { ...CONTEXT, tip: {} }), 'upgrades-cutoff-arm')).toEqual([]);
	});

	it('hints at set detail on a row whose swap breaks a measured bonus, and on no other', () => {
		expect(testIdText(renderRow(fixtureRow(10)), 'upgrades-set-bonus')).toEqual(['set detail']);
		expect(testIdText(renderRow(fixtureRow(0)), 'upgrades-set-bonus')).toEqual([]);
	});

	it('hints at set detail on a non-set row whose own swap breaks a worn bonus, from the gear the ranking was measured on', () => {
		// Feral wearing Thunderheart Gauntlets and Leggings (2pc); a non-set pair of legs breaks the 2pc (ticket 536).
		const worn = [8345, 30017, 30055, 29994, 30101, 29966, 31034, 30106, 31044, 28545, 29997, 30052, 30627, 29383, 32014, 0, 32387];
		const legs: RankedItem = { ...fixtureRow(0), itemId: 30900, name: 'Bow-stitched Leggings', slot: 'legs', deltaDps: -94.1, deltaPct: -3.8 };
		const ranking = { ...RANKING_FIXTURE, brokenSetValues: [{ setId: 676, setName: 'Thunderheart Harness', threshold: 2, dps: 106.24, se: 2 }] };

		expect(testIdText(renderRow(legs, { ...CONTEXT, tip: { ranking, wornItemIds: worn, specId: 'feral' } }), 'upgrades-set-bonus')).toEqual(['set detail']);
		expect(testIdText(renderRow(legs, { ...CONTEXT, tip: { ranking, specId: 'feral' } }), 'upgrades-set-bonus')).toEqual([]);
	});

	it('opens that row’s set-bonus popover from its DPS figure, itemising the worn bonus the swap breaks', () => {
		const worn = [8345, 30017, 30055, 29994, 30101, 29966, 31034, 30106, 31044, 28545, 29997, 30052, 30627, 29383, 32014, 0, 32387];
		const legs: RankedItem = { ...fixtureRow(0), itemId: 30900, name: 'Bow-stitched Leggings', slot: 'legs', deltaDps: -94.1, deltaPct: -3.8 };
		const ranking = { ...RANKING_FIXTURE, brokenSetValues: [{ setId: 676, setName: 'Thunderheart Harness', threshold: 2, dps: 106.24, se: 2 }] };
		const tr = renderRow(legs, { ...CONTEXT, tip: { ranking, wornItemIds: worn, specId: 'feral' } });

		vi.useFakeTimers();
		try {
			const figure = within(tr).getByRole('button', { name: '-94.1' });
			fireEvent.mouseEnter(figure);
			fireEvent.mouseMove(figure);
			act(() => vi.advanceTimersByTime(1000));
		} finally {
			vi.useRealTimers();
		}
		const tip = screen.getByTestId('upgrades-set-bonus-tip');
		expect(
			within(tip)
				.getAllByRole('term')
				.map(term => term.textContent),
		).toEqual(['Item stats', 'Breaks Thunderheart Harness 2pc', 'Total']);
	});

	it('shows a figure with nothing to itemise as plain text, not a button', () => {
		expect(within(renderRow(fixtureRow(0))).queryByRole('button', { name: '+45.7' })).toBeNull();
	});
});
