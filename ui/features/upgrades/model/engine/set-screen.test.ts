/**
 * The set screen's pure parts: the paired standard error and the on mode's keep-and-drop rule,
 * on synthetic readings.
 */

import { describe, expect, it } from 'vitest';

import { applyScreenRule, pairedSe, SCREEN_ON_RULE } from './set-screen';

describe('pairedSe', () => {
	it('pairedSe is sd(a_i − b_i)/√N on values that spread', async () => {
		// The fake sim gives every iteration one value, so the ranking tests only
		// ever read a paired error of 0. These values spread.
		// Differences 1, 2, 1, 4: mean 2, squared deviations 1 + 0 + 1 + 4 = 6,
		// sample variance 6/3 = 2, so sd = √2 and sd/√4 = √2/2.
		expect(pairedSe([10, 12, 14, 20], [9, 10, 13, 16], 4)).toBeCloseTo(Math.SQRT2 / 2, 12);
		// Each side spreads by 100 but the difference is constant: a paired
		// error is 0 where an unpaired one would not be.
		expect(pairedSe([100, 200, 300], [90, 190, 290], 3)).toBe(0);
		expect(pairedSe([1, 2, 3], [1, 2], 3)).toBeUndefined();
		expect(pairedSe([1], [2], 1)).toBeUndefined();
		expect(pairedSe(undefined, [1, 2], 2)).toBeUndefined();
	});
});

describe('applyScreenRule', () => {
	it('the rule keeps and drops sets in order, ties included', async () => {
		// Scenario kind: the rule alone, on synthetic readings, with σ = 2 so
		// the band is 2·√2 and rule 2's margin is 4.
		expect(SCREEN_ON_RULE).toEqual({
			measure: 'M2',
			iterations: 300,
			keep: 2,
			bandC: 1,
			dropExactZero: true,
			sigmaBoundScale: 1,
		});
		const verdicts = (
			sets: ReadonlyArray<{
				setId: number;
				pairDps?: number;
				measure?: number;
			}>,
			sigma: number | undefined,
		) => [...applyScreenRule(sets, sigma).entries()].sort((a, b) => a[0] - b[0]).map(([setId, v]) => [setId, v.kept, v.reason]);

		// Ties on measure go to the lower id; a set tied with the K-th is in
		// the band.
		expect(
			verdicts(
				[
					{ setId: 101, pairDps: 1, measure: 40 },
					{ setId: 103, pairDps: 1, measure: 25 },
					{ setId: 102, pairDps: 1, measure: 25 },
				],
				2,
			),
		).toEqual([
			[101, true, 'top-k'],
			[102, true, 'top-k'],
			[103, true, 'band'],
		]);
		// The band is inclusive at measure_K − √2·σ.
		const edge = 10 - 2 * Math.SQRT2;
		expect(
			verdicts(
				[
					{ setId: 201, pairDps: 1, measure: 20 },
					{ setId: 202, pairDps: 1, measure: 10 },
					{ setId: 203, pairDps: 1, measure: edge },
					{ setId: 204, pairDps: 1, measure: edge - 1e-9 },
				],
				2,
			),
		).toEqual([
			[201, true, 'top-k'],
			[202, true, 'top-k'],
			[203, true, 'band'],
			[204, false, 'outside-band'],
		]);
		// Rule 1 comes before the absence check; rule 2 drops measure + 2σ < 0.
		expect(
			verdicts(
				[
					{ setId: 301, pairDps: 0 },
					{ setId: 302, pairDps: 5 },
					{ setId: 303, pairDps: -1, measure: -5 },
					{ setId: 304, pairDps: 1, measure: -3.5 },
					{ setId: 305, pairDps: 0, measure: 50 },
				],
				2,
			),
		).toEqual([
			[301, false, 'exact-zero'],
			[302, true, 'readings-absent'],
			[303, false, 'below-zero'],
			[304, true, 'top-k'],
			[305, false, 'exact-zero'],
		]);
		// With no σ, every set rule 1 does not drop is kept outside the ranking.
		const noSigma = [
			{ setId: 401, pairDps: 0, measure: 7 },
			{ setId: 402, pairDps: 3, measure: 10 },
			{ setId: 403, pairDps: -1, measure: -50 },
		];
		const noSigmaVerdicts = [
			[401, false, 'exact-zero'],
			[402, true, 'readings-absent'],
			[403, true, 'readings-absent'],
		];
		expect(verdicts(noSigma, undefined)).toEqual(noSigmaVerdicts);
		expect(verdicts(noSigma, Number.NaN)).toEqual(noSigmaVerdicts);
		// Fewer ranked sets than K: all are kept.
		expect(verdicts([{ setId: 501, pairDps: 2, measure: 1 }], 2)).toEqual([[501, true, 'top-k']]);
	});
});
