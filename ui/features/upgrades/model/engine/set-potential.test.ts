import { describe, expect, it, vi } from 'vitest';

import { FLOOR, idsOf, MALORNE, NORDRASSIL, piece, THUNDERHEART } from '../../testing/set_bonus_scenario';
import type { RankedItem } from './rank-types';
import {
	ownSwapBreaks,
	rankableSetPotential,
	setBonusSubLine,
	setCreditUnmeasured,
	setPotentialCredit,
	setPotentialIncrements,
	type SetPotentialTerm,
	setPotentialTerms,
} from './set-potential';

// ownSwapBreaks reads items through `Database.getSync()`; the real class over the test database stands in for the page's.
vi.mock('@sim/proto/database', importOriginal => import('../../testing/database_mock').then(m => m.withTestDatabase(importOriginal)));

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

describe("the popover's split break lines", () => {
	it('the view splits an increment only when the bonus-off sim names exactly its lost bonuses', () => {
		// Scenario kind: the view's rule on a hand-built bonus-gear ranking row.
		// Example: the Gauntlets row's figures from the split-lines ranking case.
		type BonusOffFields = { bonusOffDps?: number; bonusOff?: Array<{ setId: number; threshold: number }> };
		const ctxWith = (two: BonusOffFields = {}, four: BonusOffFields = {}) =>
			asCtx({
				usesBonusGear: true,
				setId: 676,
				setName: 'Thunderheart Harness',
				singleDeltaDps: 6,
				futureBonuses: [
					{
						threshold: 2,
						piecesNeeded: 1,
						sameGearDps: 50,
						sameGearSe: 1,
						bonusGearDps: 44,
						pieces: [{ itemId: THUNDERHEART.legs, name: 'Leggings' }],
						...two,
					},
					{
						threshold: 4,
						piecesNeeded: 3,
						sameGearDps: 80,
						sameGearSe: 1,
						bonusGearDps: 54,
						pieces: [
							{ itemId: THUNDERHEART.shoulder, name: 'Pauldrons' },
							{ itemId: THUNDERHEART.chest, name: 'Chestguard' },
							{ itemId: THUNDERHEART.legs, name: 'Leggings' },
						],
						breaks: [
							{
								setId: 640,
								setName: 'Malorne Harness',
								threshold: 2,
								dps: 90,
							},
						],
						...four,
					},
				],
			});
		const fourOf = (ctx: Ctx) => setPotentialIncrements(ctx, FLOOR)![1]!;
		// (a) The bonus-off sim names the lost Malorne 2pc: split.
		const a = fourOf(ctxWith({}, { bonusOffDps: -46, bonusOff: [{ setId: 640, threshold: 2 }] }));
		expect(a.breaksLineDps).toBeCloseTo(-90, 9);
		expect(a.piecesLineDps).toBeCloseTo(100, 9);
		expect(a.dps).toBeCloseTo(10, 9);
		// (b) It names another bonus: not split.
		const b = fourOf(ctxWith({}, { bonusOffDps: -46, bonusOff: [{ setId: 640, threshold: 4 }] }));
		expect('breaksLineDps' in b).toBe(false);
		expect('piecesLineDps' in b).toBe(false);
		expect(b.dps).toBeCloseTo(10, 9);
		// (c) A ranking saved before the split lines existed: today's increments, no line fields.
		const c = setPotentialIncrements(ctxWith(), FLOOR)!;
		expect(c).toEqual([
			{
				kind: 'increment',
				threshold: 2,
				setName: 'Thunderheart Harness',
				pieces: [{ itemId: THUNDERHEART.legs, name: 'Leggings' }],
				broken: [],
				dps: 38,
				isCredited: false,
			},
			{
				kind: 'increment',
				threshold: 4,
				setName: 'Thunderheart Harness',
				pieces: [
					{ itemId: THUNDERHEART.shoulder, name: 'Pauldrons' },
					{ itemId: THUNDERHEART.chest, name: 'Chestguard' },
				],
				broken: [
					{
						setId: 640,
						setName: 'Malorne Harness',
						threshold: 2,
						dps: 90,
					},
				],
				dps: 10,
				isCredited: true,
			},
		]);
		for (const s of c) {
			expect('breaksLineDps' in s).toBe(false);
			expect('piecesLineDps' in s).toBe(false);
		}
		// (d) A bonus-off value on an increment that loses nothing: not split.
		const d = setPotentialIncrements(ctxWith({ bonusOffDps: -12, bonusOff: [] }), FLOOR)![0]!;
		expect('breaksLineDps' in d).toBe(false);
		expect('piecesLineDps' in d).toBe(false);
		expect(d.dps).toBeCloseTo(38, 9);
	});
});

describe('own-swap breaks on rows without a setContext', () => {
	type SwapRow = Parameters<typeof ownSwapBreaks>[0];
	type BrokenValues = Parameters<typeof ownSwapBreaks>[1];
	// These rows fill only the fields ownSwapBreaks reads.
	const swapRow = (row: object): SwapRow => row as unknown as SwapRow;
	const MALORNE_4 = idsOf({
		shoulder: MALORNE.shoulder,
		chest: MALORNE.chest,
		hands: MALORNE.hands,
		legs: MALORNE.legs,
	});
	const MALORNE_4_VALUES: BrokenValues = [
		{ setId: 640, setName: 'Malorne Harness', threshold: 4, dps: 23 },
		{ setId: 640, setName: 'Malorne Harness', threshold: 2, dps: 84 },
	];
	const LEGGINGS_29995 = swapRow({ itemId: 29995, slot: 'legs' });

	it('a non-set legs swap over four Malorne pieces breaks the 4pc', () => {
		expect(ownSwapBreaks(LEGGINGS_29995, MALORNE_4_VALUES, MALORNE_4, 'feral')).toEqual([
			{ setId: 640, setName: 'Malorne Harness', threshold: 4, dps: 23 },
		]);
	});

	it("a row with a setContext keeps the engine's own singleBreaks", () => {
		expect(ownSwapBreaks(swapRow({ ...LEGGINGS_29995, setContext: {} }), MALORNE_4_VALUES, MALORNE_4, 'feral')).toEqual([]);
	});

	it('a two-hander that clears the off hand counts the removed piece', () => {
		expect(
			ownSwapBreaks(
				swapRow({
					itemId: 1263,
					slot: 'weapon',
					removedItems: [{ itemId: 18202, slot: 'offhand' }],
				}),
				[
					{
						setId: 261,
						setName: 'Spirit of Eskhandar',
						threshold: 2,
						dps: 50,
					},
				],
				idsOf({ mainhand: 18203, offhand: 18202, back: 18204 }),
				'feral',
			),
		).toEqual([{ setId: 261, setName: 'Spirit of Eskhandar', threshold: 2, dps: 50 }]);
	});

	it('a ring goes where the engine put it (slotChoice)', () => {
		expect(
			ownSwapBreaks(
				swapRow({ itemId: 11980, slot: 'finger', slotChoice: 'finger2' }),
				[
					{
						setId: 495,
						setName: 'Battlegear of Unyielding Strength',
						threshold: 2,
						dps: 40,
					},
				],
				idsOf({ finger1: 11979, finger2: 21393, back: 21394 }),
				'feral',
			),
		).toEqual([
			{
				setId: 495,
				setName: 'Battlegear of Unyielding Strength',
				threshold: 2,
				dps: 40,
			},
		]);
	});

	it("with no slotChoice, the slot follows the spec and the item's hand", () => {
		expect(
			ownSwapBreaks(
				swapRow({ itemId: 18392, slot: 'weapon' }),
				[
					{
						setId: 261,
						setName: 'Spirit of Eskhandar',
						threshold: 3,
						dps: 30,
					},
				],
				idsOf({ offhand: 18202, back: 18204, neck: 18205 }),
				'rogue',
			),
		).toEqual([{ setId: 261, setName: 'Spirit of Eskhandar', threshold: 3, dps: 30 }]);
	});

	const SHOULDERPADS_30055 = swapRow({ itemId: 30055, slot: 'shoulder' });

	it('a lost count with no brokenSetValues entry was never active, so it is no break', () => {
		expect(
			ownSwapBreaks(
				SHOULDERPADS_30055,
				[{ setId: 640, setName: 'Malorne Harness', threshold: 2, dps: 84 }],
				idsOf({
					shoulder: MALORNE.shoulder,
					chest: MALORNE.chest,
					hands: MALORNE.hands,
				}),
				'feral',
			),
		).toEqual([]);
	});

	it('one worn piece going to none breaks nothing', () => {
		expect(
			ownSwapBreaks(
				SHOULDERPADS_30055,
				[
					{
						setId: 676,
						setName: 'Thunderheart Harness',
						threshold: 2,
						dps: 100,
					},
				],
				idsOf({ shoulder: MALORNE.shoulder }),
				'feral',
			),
		).toEqual([]);
	});

	it('an unmeasured break is listed with no dps', () => {
		const breaks = ownSwapBreaks(
			SHOULDERPADS_30055,
			[
				{
					setId: 640,
					setName: 'Malorne Harness',
					threshold: 2,
					unmeasured: 'sim-failed',
				},
			],
			idsOf({ shoulder: MALORNE.shoulder, chest: MALORNE.chest }),
			'feral',
		);
		expect(breaks).toEqual([{ setId: 640, setName: 'Malorne Harness', threshold: 2 }]);
		expect(breaks[0]).not.toHaveProperty('dps');
	});

	it('a piece of another set breaks the worn set and not its own', () => {
		expect(
			ownSwapBreaks(
				swapRow({ itemId: NORDRASSIL.shoulder, slot: 'shoulder' }),
				[{ setId: 640, setName: 'Malorne Harness', threshold: 2, dps: 84 }],
				idsOf({ shoulder: MALORNE.shoulder, chest: MALORNE.chest }),
				'feral',
			),
		).toEqual([{ setId: 640, setName: 'Malorne Harness', threshold: 2, dps: 84 }]);
	});

	it('an owned row, an unsimmed row, or missing inputs give no breaks', () => {
		const cases: Record<string, Parameters<typeof ownSwapBreaks>> = {
			owned: [swapRow({ ...LEGGINGS_29995, owned: true }), MALORNE_4_VALUES, MALORNE_4, 'feral'],
			unsimmed: [swapRow({ ...LEGGINGS_29995, simmed: false }), MALORNE_4_VALUES, MALORNE_4, 'feral'],
			'no brokenSetValues': [LEGGINGS_29995, undefined, MALORNE_4, 'feral'],
			'no worn ids': [LEGGINGS_29995, MALORNE_4_VALUES, undefined, 'feral'],
			'16 worn ids': [LEGGINGS_29995, MALORNE_4_VALUES, MALORNE_4.slice(0, 16), 'feral'],
		};
		const got = Object.fromEntries(Object.entries(cases).map(([k, args]) => [k, ownSwapBreaks(...args)]));
		expect(got).toEqual({
			owned: [],
			unsimmed: [],
			'no brokenSetValues': [],
			'no worn ids': [],
			'16 worn ids': [],
		});
	});

	it('a two-hander that breaks two sets lists both, by set id', () => {
		expect(
			ownSwapBreaks(
				swapRow({
					itemId: 1263,
					slot: 'weapon',
					removedItems: [{ itemId: 18202, slot: 'offhand' }],
				}),
				[
					{
						setId: 261,
						setName: 'Spirit of Eskhandar',
						threshold: 2,
						dps: 50,
					},
					{
						setId: 495,
						setName: 'Battlegear of Unyielding Strength',
						threshold: 2,
						dps: 40,
					},
				],
				idsOf({
					mainhand: 21392,
					finger1: 21393,
					offhand: 18202,
					back: 18204,
				}),
				'feral',
			),
		).toEqual([
			{ setId: 261, setName: 'Spirit of Eskhandar', threshold: 2, dps: 50 },
			{
				setId: 495,
				setName: 'Battlegear of Unyielding Strength',
				threshold: 2,
				dps: 40,
			},
		]);
	});
});

describe("a bonus-gear ranking's credit", () => {
	it("a bonus-gear ranking's credit and disclosure do not read the top package's breaks", () => {
		// The top package breaks a worn bonus that the row's own credited gear keeps, and that
		// bonus's value is unmeasured. Before the bonus-gear rule it zeroed the row; a bonus-gear
		// ranking never reads `commitBreaks`.
		const ctx = {
			usesBonusGear: true,
			setName: 'Thunderheart Harness',
			piecesWornBefore: 0,
			singleDeltaDps: 30,
			futureBonuses: [
				{
					threshold: 2,
					piecesNeeded: 2,
					sameGearDps: 50,
					sameGearSe: 0.6,
					bonusGearDps: 170,
					pieces: [piece(2, 'B')],
				},
			],
		};
		const commitBreaks = [{ setId: 640, setName: 'Malorne Harness', threshold: 2 }];
		const withCommit = { ...ctx, commitBreaks };
		expect(setCreditUnmeasured(asCtx(withCommit))).toBe(false);
		expect(rankableSetPotential(asRow(withCommit), FLOOR)).toBe(rankableSetPotential(asRow(ctx), FLOOR));
		expect(rankableSetPotential(asRow(withCommit), FLOOR)).toBe(140);
		expect(setBonusSubLine(asCtx(withCommit), true)).toBe('hover_hint');
		expect(setBonusSubLine(asCtx({ usesBonusGear: true, commitBreaks }), true)).toBeNull();
		const terms = setPotentialTerms(asCtx(withCommit), FLOOR).terms;
		expect(terms.map(t => t.kind)).toEqual(['outcome']);
		const outcome = terms[0];
		expect(outcome?.kind === 'outcome' ? outcome.broken : undefined).toEqual([]);
	});
});
