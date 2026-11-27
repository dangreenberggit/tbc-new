import { describe, expect, it } from 'vitest';

import { FLOOR, piece } from '../../testing/set_bonus_scenario';
import type { RankedItem } from './rank-types';
import { rankableSetPotential, setBonusSubLine, setCreditUnmeasured, setPotentialCredit, type SetPotentialTerm, setPotentialTerms } from './set-potential';

type Ctx = NonNullable<RankedItem['setContext']>;

// These cases build only the set-context fields the credit reads, so they cast past the
// fields a real ranking always fills.
const asCtx = (ctx: object): Ctx => ctx as unknown as Ctx;
const asRow = (ctx: object): Pick<RankedItem, 'setContext'> => ({ setContext: asCtx(ctx) });

// An outcome term is a whole-gear gain, not a part of the credit; none of these contexts
// uses bonus gear, so one appearing makes the sums below fail.
const termDps = (t: SetPotentialTerm): number => (t.kind === 'outcome' ? Number.NaN : t.dps);

describe('rankableSetPotential', () => {
	it('credit; commit-break subtraction; missing-dps fallback', () => {
		const ctx = asRow({
			futureBonuses: [
				{ threshold: 2, piecesNeeded: 2, dps: 50 },
				{ threshold: 4, piecesNeeded: 4, dps: 80 },
			],
		});
		// 50 + 80 = 130.
		expect(rankableSetPotential(ctx, FLOOR)).toBe(130);

		// A break on the future's own path subtracts.
		const withBreak = asRow({
			futureBonuses: [
				{
					threshold: 4,
					piecesNeeded: 4,
					dps: 80,
					breaks: [{ setId: 640, threshold: 2, dps: 40 }],
				},
			],
		});
		expect(rankableSetPotential(withBreak, FLOOR)).toBe(40);
		// A measured break on the top package alone is disclosure, not charged:
		// the row's own path may not need it.
		const topPackageOnly = asRow({
			futureBonuses: [{ threshold: 4, piecesNeeded: 4, dps: 80 }],
			commitBreaks: [{ setId: 640, threshold: 2, dps: 40 }],
		});
		expect(rankableSetPotential(topPackageOnly, FLOOR)).toBe(80);

		// Fallback: any future bonus lacking dps -> whole credit 0.
		const unmeasured = asRow({
			futureBonuses: [{ threshold: 4, piecesNeeded: 4 }],
		});
		expect(rankableSetPotential(unmeasured, FLOOR)).toBe(0);

		// Below-floor component is dropped.
		const tiny = asRow({
			futureBonuses: [{ threshold: 2, piecesNeeded: 2, dps: 4 }],
		});
		expect(rankableSetPotential(tiny, FLOOR)).toBe(0);
	});

	it('a commit break without a measured B zeroes the credit', () => {
		const item = asRow({
			futureBonuses: [{ threshold: 4, piecesNeeded: 4, dps: 80 }],
			commitBreaks: [{ setId: 640, threshold: 2 }],
		});
		expect(rankableSetPotential(item, FLOOR)).toBe(0);
	});

	it('an increment whose bonus floors to 0 is never the credited bonus, but its pieces still count', () => {
		const allFloored = asRow({
			futureBonuses: [
				{
					threshold: 2,
					piecesNeeded: 2,
					dps: 4,
					pieces: [piece(1, 'A', 30)],
				},
				{
					threshold: 4,
					piecesNeeded: 4,
					dps: 3,
					pieces: [piece(1, 'A', 30), piece(2, 'B', 20), piece(3, 'C', 10)],
				},
			],
		});
		expect(rankableSetPotential(allFloored, FLOOR)).toBe(0);

		const twoFloored = asCtx({
			futureBonuses: [
				{ threshold: 2, piecesNeeded: 2, dps: 4, pieces: [piece(1, 'A', 10)] },
				{
					threshold: 4,
					piecesNeeded: 4,
					dps: 80,
					pieces: [piece(1, 'A', 10), piece(2, 'B', 20), piece(3, 'C', -5)],
				},
			],
		});
		expect(rankableSetPotential({ setContext: twoFloored }, FLOOR)).toBeCloseTo(105, 9);
		expect(setPotentialTerms(twoFloored, FLOOR).creditedThreshold).toBe(4);

		// A later eligible increment that lowers the total is not credited: the
		// credit stops at the bonus where the total is highest.
		const discriminator = asCtx({
			futureBonuses: [
				{
					threshold: 2,
					piecesNeeded: 2,
					dps: 40,
					pieces: [piece(1, 'A', 100)],
				},
				{
					threshold: 4,
					piecesNeeded: 4,
					dps: 30,
					pieces: [piece(1, 'A', 100), piece(2, 'B', 0), piece(3, 'C', 0)],
					breaks: [{ setId: 640, setName: 'M', threshold: 2, dps: 200 }],
				},
			],
		});
		expect(setPotentialCredit(discriminator, FLOOR)).toBeCloseTo(140, 9);
		expect(setPotentialTerms(discriminator, FLOOR).creditedThreshold).toBe(2);
	});
});

describe('setCreditUnmeasured', () => {
	it('covers future breaks and commit breaks', () => {
		const first = {
			futureBonuses: [{ threshold: 4, piecesNeeded: 4, dps: 80 }],
			commitBreaks: [{ setId: 640, threshold: 2 }],
		};
		expect(setCreditUnmeasured(asCtx(first))).toBe(true);
		expect(
			setCreditUnmeasured(
				asCtx({
					...first,
					commitBreaks: [{ setId: 640, threshold: 2, dps: 40 }],
				}),
			),
		).toBe(false);
		expect(
			setCreditUnmeasured(
				asCtx({
					futureBonuses: [
						{
							threshold: 4,
							piecesNeeded: 4,
							dps: 80,
							breaks: [{ setId: 640, threshold: 2 }],
						},
					],
				}),
			),
		).toBe(true);
		// No futures: nothing is credited, so nothing is "not counted".
		expect(setCreditUnmeasured(asCtx({ commitBreaks: [{ setId: 640, threshold: 2 }] }))).toBe(false);
		expect(rankableSetPotential(asRow(first), FLOOR)).toBe(0);
	});

	it('a piece without a figure zeroes the credit; a future with no pieces field is credited as before', () => {
		const noFigure = asCtx({
			futureBonuses: [{ threshold: 4, piecesNeeded: 4, dps: 80, pieces: [piece(1, 'A')] }],
		});
		expect(setCreditUnmeasured(noFigure)).toBe(true);
		expect(rankableSetPotential({ setContext: noFigure }, FLOOR)).toBe(0);

		const noPieces = asCtx({
			futureBonuses: [
				{
					threshold: 2,
					piecesNeeded: 2,
					dps: 50,
					breaks: [{ setId: 640, setName: 'M', threshold: 2, dps: 20 }],
				},
			],
		});
		expect(setCreditUnmeasured(noPieces)).toBe(false);
		expect(rankableSetPotential({ setContext: noPieces }, FLOOR)).toBeCloseTo(30, 9);
	});
});

describe('setBonusSubLine', () => {
	it("the tab's sub-line choice follows the view's zero rule", () => {
		const first = asCtx({
			futureBonuses: [{ threshold: 4, piecesNeeded: 4, dps: 80 }],
			commitBreaks: [{ setId: 640, threshold: 2 }],
		});
		expect(setBonusSubLine(first, true)).toBe('not_counted');
		expect(setBonusSubLine(first, false)).toBe('hover_hint');
		expect(setBonusSubLine({}, true)).toBeNull();
		expect(setBonusSubLine({ crossesThreshold: true }, true)).toBe('hover_hint');
	});
});

describe('setPotentialTerms', () => {
	it('the terms are itemized by increment, add up to the credit and end at the credited bonus', () => {
		const M = 'Malorne Harness';
		const ctx = (bDps: number) =>
			asCtx({
				setName: 'Thunderheart Harness',
				piecesWornBefore: 0,
				futureBonuses: [
					{
						threshold: 2,
						piecesNeeded: 2,
						dps: 50,
						pieces: [piece(1, 'A', 100)],
						breaks: [{ setId: 640, setName: M, threshold: 4, dps: 70 }],
					},
					{
						threshold: 4,
						piecesNeeded: 4,
						dps: 80,
						pieces: [piece(1, 'A', 100), piece(2, 'B', bDps), piece(3, 'C', -10)],
						breaks: [
							{ setId: 640, setName: M, threshold: 4, dps: 70 },
							{ setId: 640, setName: M, threshold: 2, dps: 40 },
						],
					},
				],
			});
		const full = setPotentialTerms(ctx(20), FLOOR);
		expect(full.credit).toBeCloseTo(130, 9);
		expect(full.creditedThreshold).toBe(4);
		expect(full.terms).toEqual([
			{
				kind: 'bonus',
				setName: 'Thunderheart Harness',
				threshold: 2,
				worn: 0,
				dps: 50,
			},
			{ kind: 'piece', itemId: 1, name: 'A', dps: 100 },
			{ kind: 'break', setName: M, threshold: 4, dps: -70 },
			{
				kind: 'bonus',
				setName: 'Thunderheart Harness',
				threshold: 4,
				worn: 0,
				dps: 80,
			},
			{ kind: 'piece', itemId: 2, name: 'B', dps: 20 },
			{ kind: 'piece', itemId: 3, name: 'C', dps: -10 },
			{ kind: 'break', setName: M, threshold: 2, dps: -40 },
		]);
		const sum = full.terms.reduce((s, t) => s + termDps(t), 0);
		expect(Math.abs(sum - full.credit)).toBeLessThan(1e-9);

		const early = setPotentialTerms(ctx(-100), FLOOR);
		expect(early.credit).toBeCloseTo(80, 9);
		expect(early.creditedThreshold).toBe(2);
		expect(early.terms.map(t => t.kind)).toEqual(['bonus', 'piece', 'break']);

		const floored = setPotentialTerms(
			asCtx({
				setName: 'S',
				piecesWornBefore: 0,
				futureBonuses: [
					{
						threshold: 2,
						piecesNeeded: 2,
						dps: 4,
						pieces: [piece(1, 'A', 10)],
					},
					{
						threshold: 4,
						piecesNeeded: 4,
						dps: 80,
						pieces: [piece(1, 'A', 10), piece(2, 'B', 20), piece(3, 'C', -5)],
					},
				],
			}),
			FLOOR,
		);
		expect(floored.terms.map(t => [t.kind, termDps(t)])).toEqual([
			['piece', 10],
			['bonus', 80],
			['piece', 20],
			['piece', -5],
		]);
	});
});
