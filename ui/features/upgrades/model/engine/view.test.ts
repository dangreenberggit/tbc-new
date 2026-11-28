import { describe, expect, it } from 'vitest';

import { THUNDERHEART } from '../../testing/set_bonus_scenario';
import { CUTOFF } from './cutoff';
import type { Ranking } from './rank-types';
import { applyView } from './view';

describe('applyView', () => {
	it('set credit reorders the rows', () => {
		// A Ranking with a set row and a non-set row whose order the set credit
		// reverses. Only the fields the sort reads are filled.
		const ranking = {
			baseline: { dps: 3000 },
			cutoff: { absDps: 3.4, absPct: 0.1 },
			items: [
				{
					itemId: 1,
					deltaDps: 10,
					se: 1,
					seMethod: 'independent',
					bisTags: [],
					belowCutoff: false,
					setContext: {
						setId: 676,
						setName: 'S',
						piecesWornBefore: 0,
						piecesAfterSwap: 1,
						nextThreshold: 4,
						crossesThreshold: false,
						futureBonuses: [{ threshold: 4, piecesNeeded: 4, dps: 200 }],
					},
				},
				{
					itemId: 2,
					deltaDps: 65,
					se: 1,
					seMethod: 'independent',
					bisTags: [],
					belowCutoff: false,
				},
			],
		} as unknown as Ranking;
		// With set potential: row1 = 10 + 200 = 210 > row2 = 65 -> [1, 2].
		const withCredit = applyView(ranking, { withSetPotential: true });
		expect(withCredit.rows.map(r => r.itemId)).toEqual([1, 2]);
		// Without it: row1 = 10 < row2 = 65 -> [2, 1].
		const without = applyView(ranking, { withSetPotential: false });
		expect(without.rows.map(r => r.itemId)).toEqual([2, 1]);
	});
});

describe('two-sim set values use the item bar', () => {
	/** A set row worth 0 alone, and a plain row worth 3.2, under the tab's bar. */
	function rankingWith(setContext: object): Ranking {
		return {
			baseline: { dps: 3000 },
			cutoff: CUTOFF,
			items: [
				{
					itemId: 1,
					deltaDps: 0,
					se: 0.1,
					seMethod: 'independent',
					bisTags: [],
					belowCutoff: true,
					setContext,
				},
				{
					itemId: 2,
					deltaDps: 3.2,
					se: 0.1,
					seMethod: 'independent',
					bisTags: [],
					belowCutoff: false,
				},
			],
		} as unknown as Ranking;
	}

	it('a bonus-gear future worth 3.5 on the same gear, se 1, is credited under the 3 DPS bar', () => {
		// Scenario kind: Set potential on, a future whose same-gear value (one
		// sim with the bonus minus one without) sits between the 3 DPS item bar
		// and √2 × 3 ≈ 4.24. Its se of 1 puts the 2·se part at 2, so the bar
		// decides. The credited gear is 3.5 over current gear, so the row's figure
		// is 0 + 3.5 and it sorts above the 3.2 row.
		const ranking = rankingWith({
			usesBonusGear: true,
			setId: 676,
			setName: 'Thunderheart Harness',
			piecesWornBefore: 1,
			singleDeltaDps: 0,
			futureBonuses: [
				{
					threshold: 2,
					piecesNeeded: 1,
					sameGearDps: 3.5,
					sameGearSe: 1,
					bonusGearDps: 3.5,
					pieces: [{ itemId: THUNDERHEART.legs, name: 'Leggings' }],
				},
			],
		});
		const { rows } = applyView(ranking, { withSetPotential: true });
		expect(rows.map(r => [r.itemId, r.belowCutoffInView])).toEqual([
			[1, false],
			[2, false],
		]);
	});

	it('the flag-off four-sim bonus keeps the √2 floor', () => {
		// Scenario kind: a ranking made without the broken-set flag. Its
		// prospective bonus folds four sims, so 3.5 is still within √2 × 3 and
		// earns nothing.
		const ranking = rankingWith({
			setId: 676,
			setName: 'Thunderheart Harness',
			piecesWornBefore: 1,
			piecesAfterSwap: 2,
			crossesThreshold: false,
			futureBonuses: [{ threshold: 2, piecesNeeded: 1, dps: 3.5 }],
		});
		const { rows } = applyView(ranking, { withSetPotential: true });
		expect(rows.map(r => [r.itemId, r.belowCutoffInView])).toEqual([
			[2, false],
			[1, true],
		]);
	});
});
