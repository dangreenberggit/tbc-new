import { describe, expect, it } from 'vitest';

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
