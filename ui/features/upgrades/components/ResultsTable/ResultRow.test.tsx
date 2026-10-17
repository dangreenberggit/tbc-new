import { loadEnglishBundles } from '@features/upgrades/testing/locales';
import { ItemQuality } from '@generated/proto/common';
import { DungeonDifficulty, UIItem } from '@generated/proto/ui';
import { ActionId } from '@sim/proto/action_id';
import { fakeHost } from '@sim/testing';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { RankedItem } from '../../model/engine/rank';
import { fixtureRow, RANKING_FIXTURE } from '../../testing/ranking_fixture';

// The row toggles read the page's store; `RowToggles.test.tsx` covers them.
vi.mock('../RowToggles', () => ({ FavoriteToggle: () => <span data-testid="favorite-stub" />, BatchToggle: () => <span data-testid="batch-stub" /> }));
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

loadEnglishBundles({ character: true });

// Items with no source, so the Source cell shows the engine's label.
const ITEMS: Record<number, UIItem> = {
	32332: UIItem.create({ id: 32332, name: 'Torch of the Damned', quality: ItemQuality.ItemQualityEpic }),
	30882: UIItem.create({ id: 30882, name: 'Blade of Infamy', quality: ItemQuality.ItemQualityEpic }),
};
const CONTEXT: RowContext = { itemOf: itemId => ITEMS[itemId], sim: fakeHost().sim, tip: { ranking: RANKING_FIXTURE, specId: 'ret' }, tagsOf: () => [] };

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
	it('shows its place, the item, DPS change, slot and source, then two cells for the row toggles', () => {
		const tr = renderRow(fixtureRow(0));
		const cells = within(tr).getAllByRole('cell');
		expect(cells.map(cell => cell.textContent)).toEqual([
			'3',
			'Torch of the DamnedBiS',
			'+45.7',
			'Main Hand',
			'Black Temple · Reliquary of the Lost',
			'',
			'',
		]);
		// The gates find the DPS cell by this id, not by its position (ticket 606).
		expect(within(tr).getByTestId('upgrades-delta-cell')).toBe(cells[2]);
		expect(cells[5]?.querySelector('[data-testid="favorite-stub"]')).not.toBeNull();
		expect(cells[6]?.querySelector('[data-testid="batch-stub"]')).not.toBeNull();
		expect(tr.dataset.itemId).toBe('32332');
		expect(tr.dataset.testid).toBe('upgrades-result-row');
	});

	it('links a raid drop’s zone and boss as the gear picker does, from the site’s database', () => {
		const BLACK_TEMPLE = 3959;
		const ILLIDAN = 22917;
		const torch = UIItem.create({
			id: 32332,
			sources: [
				{
					source: {
						oneofKind: 'drop',
						drop: { zoneId: BLACK_TEMPLE, npcId: ILLIDAN, difficulty: DungeonDifficulty.DifficultyNormal, otherName: '', category: '' },
					},
				},
			],
		});
		const { sim } = fakeHost({
			sim: {
				db: {
					getZone: (id: number) => (id === BLACK_TEMPLE ? { id, name: 'Black Temple' } : null),
					getNpc: (id: number) => (id === ILLIDAN ? { id, name: 'Illidan Stormrage' } : null),
				},
			},
		});
		const context = { ...CONTEXT, itemOf: (id: number) => (id === torch.id ? torch : undefined), sim };
		const link = within(renderRow(fixtureRow(0), context)).getByRole('link', { name: /Illidan Stormrage/ });
		expect(link.textContent).toBe('Black Temple (N)Illidan Stormrage');
		expect(link.getAttribute('href')).toBe(ActionId.makeNpcUrl(ILLIDAN));
	});

	// Choker of Serrated Blades drops in Hyjal Summit and Black Temple. Upstream's linked block names only the item's first
	// drop, which can be the hidden one, so while any of the row's sources is hidden the cell names a shown one instead.
	it('names only a shown source of a row from two raids while Filter by source hides the other', () => {
		const HYJAL = 3606;
		const BLACK_TEMPLE = 3959;
		const drop = (zoneId: number) => ({
			source: { oneofKind: 'drop' as const, drop: { zoneId, npcId: 0, difficulty: DungeonDifficulty.DifficultyNormal, otherName: '', category: '' } },
		});
		const choker = UIItem.create({ id: 32591, sources: [drop(HYJAL), drop(BLACK_TEMPLE)] });
		const hyjal = { kind: 'raid', zone: 'Hyjal Summit', origin: 'db' } as const;
		const row: RankedItem = { ...fixtureRow(0), itemId: 32591, source: hyjal, sources: [hyjal, { kind: 'raid', zone: 'Black Temple', origin: 'db' }] };
		const { sim } = fakeHost({
			sim: {
				db: {
					getZone: (id: number) => ({ [HYJAL]: { id, name: 'Hyjal Summit' }, [BLACK_TEMPLE]: { id, name: 'Black Temple' } })[id] ?? null,
					getNpc: () => null,
				},
			},
		});
		const sourceCell = (hiddenSources?: readonly string[]) => {
			const tr = renderRow(row, { ...CONTEXT, itemOf: () => choker, sim, hiddenSources });
			return within(tr).getAllByRole('cell')[4]!;
		};

		expect(within(sourceCell()).getByRole('link').textContent).toBe('Hyjal Summit');
		for (const [hidden, shown] of [
			[['Hyjal Summit'], 'Black Temple'],
			[['Black Temple'], 'Hyjal Summit'],
		] as const) {
			const cell = sourceCell(hidden);
			expect(cell.textContent).toBe(shown);
			expect(cell.querySelector('small')?.textContent).toBe(shown);
			expect(within(cell).queryByRole('link')).toBeNull();
		}
		expect(within(sourceCell(['Karazhan'])).getByRole('link').textContent).toBe('Hyjal Summit');
	});

	// Libram of Hope: upstream's npc 16097 is named 'Isalien"].." - "..format(AL["Tier %s Sets' because its generator
	// overran the AtlasLoot key (ticket 680). The cell names the boss the key holds, as the universe does.
	it('names the boss of an npc whose name overran its AtlasLoot key, and keeps a real name with quotes', () => {
		const DIRE_MAUL = 2557;
		const ISALIEN = 16097;
		const ERIC = 6907;
		const names: Record<number, string> = { [ISALIEN]: 'Isalien"].." - "..format(AL["Tier %s Sets', [ERIC]: 'Eric "The Swift"' };
		const { sim } = fakeHost({
			sim: {
				db: {
					getZone: (id: number) => (id === DIRE_MAUL ? { id, name: 'Dire Maul' } : null),
					getNpc: (id: number) => (names[id] ? { id, name: names[id] } : null),
				},
			},
		});
		const sourceCell = (npcId: number) => {
			const libram = UIItem.create({
				id: 22401,
				sources: [
					{
						source: {
							oneofKind: 'drop',
							drop: { zoneId: DIRE_MAUL, npcId, difficulty: DungeonDifficulty.DifficultyNormal, otherName: '', category: '' },
						},
					},
				],
			});
			return within(renderRow(fixtureRow(0), { ...CONTEXT, itemOf: () => libram, sim })).getAllByRole('cell')[4]!;
		};

		const overrun = sourceCell(ISALIEN);
		const overrunLink = within(overrun).getByRole('link');
		expect(overrunLink.textContent).toBe('Dire MaulIsalien');
		expect(overrunLink.getAttribute('href')).toBe(ActionId.makeZoneUrl(DIRE_MAUL));
		expect(overrun.textContent).not.toMatch(/["[\]]/);

		const real = within(sourceCell(ERIC)).getByRole('link');
		expect(real.textContent).toBe('Dire Maul (N)Eric "The Swift"');
		expect(real.getAttribute('href')).toBe(ActionId.makeNpcUrl(ERIC));
	});

	it('shows the engine’s label as plain text when the site has no source to link', () => {
		const tr = renderRow(fixtureRow(0));
		expect(within(tr).queryByRole('link', { name: /Black Temple/ })).toBeNull();
		expect(within(tr).getByText('Black Temple · Reliquary of the Lost').tagName).toBe('SMALL');
	});

	// Lightbringer Greaves' tier token; upstream's db.json has no source for it, so the plain text is all the cell can show.
	const token = {
		kind: 'token',
		zone: 'Black Temple',
		boss: 'The Illidari Council',
		token: 'Leggings of the Forgotten Protector',
		origin: 'db',
	} as const;

	it('names a tier token’s boss, a reputation’s standing and a PvP item’s currency in the plain text (ticket 619)', () => {
		const sourceText = (source: RankedItem['source']) => {
			const { sources: _, ...row } = { ...fixtureRow(0), source };
			const tr = renderRow(row, { ...CONTEXT, itemOf: () => undefined });
			return within(tr).getAllByRole('cell')[4]!.querySelector('small')?.textContent;
		};
		expect(sourceText(token)).toBe('Black Temple (N) · The Illidari Council');
		expect(sourceText({ kind: 'rep', faction: 'The Scale of the Sands', standing: 'Revered', origin: 'db' })).toBe('The Scale of the Sands · Revered');
		expect(sourceText({ kind: 'pvp', via: 'arena', season: 3, origin: 'wowhead' })).toBe('PvP vendor · Arena, season 3');
	});

	// The row has a second zone, so "Filter by source" keeps it while Black Temple is hidden; a token row with no other
	// zone would be cut from the table, and its cell never seen.
	it('names only the shown zone of a two-zone token row while Filter by source hides the other', () => {
		const hyjal = { kind: 'raid', zone: 'Hyjal Summit', boss: 'Archimonde', origin: 'db' } as const;
		const row: RankedItem = { ...fixtureRow(0), source: token, sources: [token, hyjal] };
		const cell = within(renderRow(row, { ...CONTEXT, itemOf: () => undefined, hiddenSources: ['Black Temple'] })).getAllByRole('cell')[4]!;
		expect(cell.textContent).toBe('Hyjal Summit · Archimonde');
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
