import { describe, expect, it, vi } from 'vitest';

import { fixtureRow, RANKING_FIXTURE } from '../testing/ranking_fixture';
import type { RankedItem } from './engine/rank';

// The engine reads set membership from the sim database, which a unit test does not load.
const THUNDERHEART = { setId: 676, setName: 'Thunderheart Harness' };
vi.mock('./engine/items', async importOriginal => ({
	...(await importOriginal<typeof import('./engine/items')>()),
	getItem: (itemId: number) => (itemId === 31034 || itemId === 31044 ? THUNDERHEART : itemId === 0 ? undefined : { setId: null, setName: null }),
}));

const { setBonusTipLines, spreadTenths } = await import('./set_bonus_tip');
type SetBonusTip = import('./set_bonus_tip').SetBonusTip;
type TipEntry = import('./set_bonus_tip').TipEntry;

const lines = (tip: SetBonusTip | null) => (tip?.entries ?? []).filter((entry): entry is Extract<TipEntry, { type: 'line' }> => entry.type === 'line');
const tenths = (dps: number | undefined) => Math.round((dps ?? 0) * 10);

/** The receipt's rule: every line above the total adds up to the total, as shown in tenths. */
const addsUp = (tip: SetBonusTip | null) => {
	const all = lines(tip);
	const total = all.at(-1)!;
	return all.slice(0, -1).reduce((sum, line) => sum + tenths(line.dps), 0) === Math.round(Number(total.dps!.toFixed(1)) * 10);
};

const context = { ranking: RANKING_FIXTURE };

describe('setBonusTipLines', () => {
	it('gives nothing for a row with no set and no break', () => {
		expect(setBonusTipLines(fixtureRow(0), context)).toBeNull();
	});

	it('gives nothing for a set row whose only line would repeat the figure', () => {
		// Lightbringer Breastplate: its future bonuses are below the gate and it breaks nothing.
		expect(setBonusTipLines(fixtureRow(4), context)).toBeNull();
	});

	it('itemises a measured break of the row’s own swap above its total', () => {
		const tip = setBonusTipLines(fixtureRow(10), context);
		expect(tip).toMatchObject({ subLine: 'hover_hint', kind: 'receipt' });
		expect(lines(tip)).toEqual([
			{ type: 'line', label: { kind: 'item_stats', unmeasuredBreaks: [] }, dps: 22.8 },
			{ type: 'line', label: { kind: 'breaks', broken: [{ setName: 'Crystalforge Battlegear', threshold: 2 }] }, dps: -18.4 },
			{ type: 'line', label: { kind: 'total' }, dps: 4.42 },
		]);
		expect(addsUp(tip)).toBe(true);
	});

	it('folds an unmeasured break into the first line’s label and keeps that line', () => {
		const row: RankedItem = {
			...fixtureRow(10),
			setContext: { ...fixtureRow(10).setContext!, singleBreaks: [{ setId: 627, setName: 'Crystalforge Battlegear', threshold: 2 }] },
		};
		expect(lines(setBonusTipLines(row, context))).toEqual([
			{ type: 'line', label: { kind: 'item_stats', unmeasuredBreaks: [{ setName: 'Crystalforge Battlegear', threshold: 2 }] }, dps: 4.4 },
			{ type: 'line', label: { kind: 'total' }, dps: 4.42 },
		]);
	});

	it('names the bonus a row crosses on its first line', () => {
		const row: RankedItem = {
			...fixtureRow(10),
			setContext: { ...fixtureRow(10).setContext!, singleBreaks: [], crossesThreshold: true, piecesWornBefore: 1, piecesAfterSwap: 2, stepRanking: true },
		};
		expect(lines(setBonusTipLines(row, context))[0]).toEqual({
			type: 'line',
			label: { kind: 'item_stats', bonus: { setName: 'Lightbringer Battlegear', threshold: 2 }, unmeasuredBreaks: [] },
			dps: 4.4,
		});
	});

	it('values the worn bonus a row with no set context breaks, from the ranking’s measured values', () => {
		// Feral wearing Thunderheart Gauntlets and Leggings (2pc); a non-set pair of legs breaks the 2pc.
		const worn = [8345, 30017, 30055, 29994, 30101, 29966, 31034, 30106, 31044, 28545, 29997, 30052, 30627, 29383, 32014, 0, 32387];
		const legs: RankedItem = { ...fixtureRow(0), itemId: 30900, name: 'Bow-stitched Leggings', slot: 'legs', deltaDps: -94.1, deltaPct: -3.8 };
		const ranking = { ...RANKING_FIXTURE, brokenSetValues: [{ setId: 676, setName: 'Thunderheart Harness', threshold: 2, dps: 106.24, se: 2 }] };
		const tip = setBonusTipLines(legs, { ranking, wornItemIds: worn, specId: 'feral' });
		expect(lines(tip).map(line => line.label)).toEqual([
			{ kind: 'item_stats', unmeasuredBreaks: [] },
			{ kind: 'breaks', broken: [{ setName: 'Thunderheart Harness', threshold: 2 }] },
			{ kind: 'total' },
		]);
		expect(addsUp(tip)).toBe(true);
		expect(setBonusTipLines(legs, { ranking, wornItemIds: worn })).toBeNull();
	});

	it('leaves the set-potential section out unless asked for it', () => {
		const row: RankedItem = {
			...fixtureRow(10),
			setContext: { ...fixtureRow(10).setContext!, futureBonuses: [{ threshold: 2, piecesNeeded: 1 }] },
		};
		expect(setBonusTipLines(row, context)?.entries.some(entry => entry.type === 'heading')).toBe(false);

		const on = setBonusTipLines(row, { ...context, withSetPotential: true });
		expect(on?.subLine).toBe('not_counted');
		expect(on?.entries).toContainEqual({ type: 'heading', heading: 'set_potential' });
		expect(lines(on)).toContainEqual({ type: 'line', label: { kind: 'bonus', set: 'Lightbringer Battlegear', threshold: 2, have: 0 }, dps: undefined });
	});

	it('adds the measured set-potential lines so they add up to the new total', () => {
		const row: RankedItem = {
			...fixtureRow(10),
			setContext: { ...fixtureRow(10).setContext!, futureBonuses: [{ threshold: 2, piecesNeeded: 1, dps: 20.04, pieces: [], breaks: [] }] },
		};
		const tip = setBonusTipLines(row, { ...context, withSetPotential: true });
		expect(tip?.entries).toContainEqual({ type: 'heading', heading: 'set_potential' });
		expect(lines(tip).at(-1)!.dps).toBeGreaterThan(4.42);
		expect(addsUp(tip)).toBe(true);
	});
});

describe('spreadTenths', () => {
	it('rounds each value to tenths so the parts add up to the target, moving the fewest', () => {
		expect(spreadTenths([1.04, 1.04, 1.04], 31)).toEqual([11, 10, 10]);
		expect(spreadTenths([1.06, 1.06, 1.06], 32)).toEqual([10, 11, 11]);
		expect(spreadTenths([2.5], 25)).toEqual([25]);
	});
});
