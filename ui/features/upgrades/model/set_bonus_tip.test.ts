import { describe, expect, it, vi } from 'vitest';

import { fixtureRow, RANKING_FIXTURE } from '../testing/ranking_fixture';
import onSnapshot from '../testing/set_bonus_tip_on.snapshot.json';
import type { RankedItem, Ranking, SetContext } from './engine/rank';
import { SCREEN_ON_RULE } from './engine/set-screen';

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

/**
 * The receipt's rule: the lines above the total add up to the total, as shown
 * in tenths; a total alone is the row's figure. Lines after the total are not
 * counted (ticket 336).
 */
const addsUp = (tip: SetBonusTip | null) => {
	const all = lines(tip);
	const at = all.findIndex(line => line.label.kind === 'total');
	const total = all[at]!;
	return at === 0 || all.slice(0, at).reduce((sum, line) => sum + tenths(line.dps), 0) === Math.round(Number(total.dps!.toFixed(1)) * 10);
};

const context = { ranking: RANKING_FIXTURE };

type Future = NonNullable<SetContext['futureBonuses']>[number];
/** A step ranking's measured 2pc future: worth 26 DPS over the row alone when the row's figure is 4.5. */
const future = (over: Partial<Future> = {}): Future => ({
	threshold: 2,
	piecesNeeded: 1,
	sameGearDps: 20,
	sameGearSe: 1,
	stepGearDps: 30.5,
	pieces: [{ itemId: 30990, name: 'Lightbringer Breastplate' }],
	breaks: [],
	...over,
});
/** Fixture row 10, a Lightbringer Battlegear helm, on a step ranking, at 4.5 DPS, breaking nothing unless `over` says so. */
const stepRow = (over: Partial<SetContext>): RankedItem => ({
	...fixtureRow(10),
	deltaDps: 4.5,
	setContext: { ...fixtureRow(10).setContext!, singleBreaks: [], singleDeltaDps: 4.5, stepRanking: true, ...over },
});
const LIGHTBRINGER = 'Lightbringer Battlegear';
const reachable = (dps: number, broken: Array<{ setName: string; threshold: number }> = []) => ({
	type: 'line',
	label: { kind: 'reachable', set: LIGHTBRINGER, threshold: 2, have: 0, pieces: ['Lightbringer Breastplate'], broken },
	dps,
	outcome: true,
});
const totalLine = (dps: number) => ({ type: 'line', label: { kind: 'total' }, dps });

/**
 * A ranking whose set screen dropped Lightbringer for `reason`. Since ticket 644 the
 * dropped set has no `setBonuses` entry; `olderMarker` adds the one earlier rankings have.
 */
const screenedRanking = (reason: 'outside-band' | 'exact-zero' | 'below-zero', olderMarker = false): Ranking => ({
	...RANKING_FIXTURE,
	setBonuses: olderMarker ? [{ setId: 680, setName: LIGHTBRINGER, threshold: 2, piecesWorn: 0, packageItemIds: [], packageDeltaDps: 0, unmeasured: 'screened-out' }] : [],
	setScreen: {
		mode: 'on',
		seed: 1,
		iterations: 1000,
		rule: SCREEN_ON_RULE,
		sigma: 6,
		sets: [{ setId: 680, worn: 0, reach: 2, packageItemIds: [], pair: { dps: 7.17 }, bestStats: -73.6, measure: -66.43, kept: false, reason }],
		simmed: 0,
		fromStore: 0,
	},
});

describe('setBonusTipLines', () => {
	it('gives nothing for a row with no set and no break', () => {
		expect(setBonusTipLines(fixtureRow(0), context)).toBeNull();
	});

	it('gives nothing for a set row whose only line would repeat the figure', () => {
		// Lightbringer Breastplate as a ranking that did not measure steps: its future bonuses are below the gate and it breaks nothing.
		const { stepRanking: _, ...notStepped } = fixtureRow(4).setContext!;
		const row: RankedItem = { ...fixtureRow(4), setContext: notStepped };
		expect(setBonusTipLines(row, context)).toBeNull();
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
			setContext: { ...fixtureRow(10).setContext!, singleBreaks: [{ setId: 629, setName: 'Crystalforge Battlegear', threshold: 2 }] },
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

	it('keeps today’s Set potential section with the toggle on when a figure is unmeasured', () => {
		const row: RankedItem = {
			...fixtureRow(10),
			setContext: { ...fixtureRow(10).setContext!, futureBonuses: [{ threshold: 2, piecesNeeded: 1 }] },
		};
		const on = setBonusTipLines(row, { ...context, withSetPotential: true });
		expect(on?.subLine).toBe('not_counted');
		expect(on?.entries).toContainEqual({ type: 'heading', heading: 'set_potential' });
		expect(lines(on)).toContainEqual({ type: 'line', label: { kind: 'bonus', set: 'Lightbringer Battlegear', threshold: 2, have: 0 }, dps: undefined });
	});

	// Ticket 336: the toggle decides what the figure counts, never whether the popover exists.
	describe('the not-counted section (ticket 336)', () => {
		it('lists a reachable bonus under the total with the toggle off, as an outcome against the item alone', () => {
			const tip = setBonusTipLines(stepRow({ futureBonuses: [future()] }), context);
			expect(tip).toMatchObject({ subLine: 'hover_hint', kind: 'receipt' });
			expect(tip?.entries).toEqual([totalLine(4.5), { type: 'heading', heading: 'not_counted_off' }, reachable(26)]);
			expect(addsUp(tip)).toBe(true);
		});

		it('keeps today’s lines with the toggle on when the bonus is credited', () => {
			const tip = setBonusTipLines(stepRow({ futureBonuses: [future()] }), { ...context, withSetPotential: true });
			expect(tip?.entries).toEqual([
				{ type: 'line', label: { kind: 'item_stats', unmeasuredBreaks: [] }, dps: 4.5 },
				{ type: 'heading', heading: 'set_potential' },
				{ type: 'line', label: { kind: 'pieces', form: 'step', pieces: ['Lightbringer Breastplate'], threshold: 2, broken: [] }, dps: 26 },
				totalLine(30.5),
			]);
		});

		it('lists a bonus that would lose DPS in both states, under a heading that says why it is not counted', () => {
			const row = stepRow({ futureBonuses: [future({ stepGearDps: 2.5 })] });
			const off = setBonusTipLines(row, context);
			const on = setBonusTipLines(row, { ...context, withSetPotential: true });
			expect(off?.entries).toEqual([totalLine(4.5), { type: 'heading', heading: 'not_counted_off' }, reachable(-2)]);
			expect(on?.entries).toEqual([totalLine(4.5), { type: 'heading', heading: 'not_counted_no_gain' }, reachable(-2)]);
			expect(on?.subLine).toBe('hover_hint');
		});

		it('values a reachable bonus against the row’s single swap, not against its figure after replication', () => {
			const tip = setBonusTipLines(stepRow({ singleDeltaDps: 2, futureBonuses: [future()] }), context);
			// 30.5 step gear DPS less the 2 DPS single swap; the row's 4.5 DPS figure would give 26.
			expect(lines(tip).at(-1)).toEqual(reachable(28.5));
		});

		it('names only the bonus when the step ranking measured no partner choice for it', () => {
			const row = stepRow({ futureBonuses: [future({ pieces: undefined, breaks: undefined, stepGearDps: undefined })] });
			expect(setBonusTipLines(row, context)?.entries).toEqual([
				totalLine(4.5),
				{ type: 'heading', heading: 'not_counted_off' },
				{ type: 'line', label: { kind: 'reachable', set: LIGHTBRINGER, threshold: 2, have: 0, pieces: [], broken: [] }, dps: undefined, outcome: true },
			]);
		});

		it('lists no reachable bonus on a ranking that did not measure steps, whose figure is the bonus alone', () => {
			const row: RankedItem = {
				...fixtureRow(10),
				deltaDps: 4.5,
				setContext: { ...fixtureRow(10).setContext!, singleBreaks: [], singleDeltaDps: 4.5, futureBonuses: [future({ dps: 20 })] },
			};
			expect(row.setContext?.stepRanking).toBeUndefined();
			expect(setBonusTipLines(row, context)).toBeNull();
		});

		// A screened set is not counted whatever the toggle says, so its heading gives no reason.
		it.each([
			['outside-band', false],
			['exact-zero', false],
			['below-zero', false],
			['outside-band', true],
			['below-zero', true],
		] as const)('names a set the screen dropped (%s), toggle on: %s', (reason, withSetPotential) => {
			const tip = setBonusTipLines(stepRow({ futureBonuses: [] }), { ranking: screenedRanking(reason), withSetPotential });
			expect(tip?.subLine).toBe('hover_hint');
			// No figure, not even for below-zero, whose measure is the pieces and the bonus together.
			expect(tip?.entries).toEqual([
				totalLine(4.5),
				{ type: 'heading', heading: 'not_counted' },
				{ type: 'line', label: { kind: 'screened', set: LIGHTBRINGER, reason }, dps: undefined },
			]);
		});

		it('names a set the screen dropped in a ranking made before ticket 644, which also marks it', () => {
			const tip = setBonusTipLines(stepRow({ futureBonuses: [] }), { ranking: screenedRanking('exact-zero', true), withSetPotential: false });
			expect(tip?.entries).toContainEqual({ type: 'line', label: { kind: 'screened', set: LIGHTBRINGER, reason: 'exact-zero' }, dps: undefined });
		});

		// Ticket 655 case 2: the owner chose candidate A on 2026-11-01 ("Case 2 a sounds fine").
		it('names each bonus within the noise gate, with no figure, in both states', () => {
			const row = stepRow({
				futureBonuses: [
					future({ belowGate: true, stepGearDps: undefined }),
					future({ threshold: 4, piecesNeeded: 3, sameGearDps: 0, belowGate: true, stepGearDps: undefined }),
				],
			});
			const noise = (threshold: number) => ({ type: 'line', label: { kind: 'noise', set: LIGHTBRINGER, threshold }, dps: undefined });
			const expected = [totalLine(4.5), { type: 'heading', heading: 'not_counted' }, noise(2), noise(4)];
			for (const withSetPotential of [false, true]) {
				const tip = setBonusTipLines(row, { ...context, withSetPotential });
				expect(tip).toMatchObject({ subLine: 'hover_hint', kind: 'receipt' });
				expect(tip?.entries).toEqual(expected);
			}
		});

		it('names no bonus within the noise when another bonus of the set clears the gate', () => {
			const row = stepRow({ futureBonuses: [future(), future({ threshold: 4, piecesNeeded: 3, belowGate: true, stepGearDps: undefined })] });
			expect(setBonusTipLines(row, context)?.entries).toEqual([totalLine(4.5), { type: 'heading', heading: 'not_counted_off' }, reachable(26)]);
		});

		// Ticket 655 case 1: each line says how much the figure would change if the tab counted that step in place of what it counts now.
		describe('a bonus past the stop, with the toggle on (ticket 655)', () => {
			const PIECES_4PC = ['Lightbringer Breastplate', 'Lightbringer Greaves', 'Lightbringer Shoulderbraces'];
			const fourPiece = (stepGearDps: number, over: Partial<Future> = {}): Future =>
				future({
					threshold: 4,
					piecesNeeded: 3,
					stepGearDps,
					pieces: [
						{ itemId: 30990, name: PIECES_4PC[0]! },
						{ itemId: 30993, name: PIECES_4PC[1]! },
						{ itemId: 30997, name: PIECES_4PC[2]! },
					],
					...over,
				});
			const reachable4 = (dps: number, broken: Array<{ setName: string; threshold: number }> = []) => ({
				type: 'line',
				label: { kind: 'reachable', set: LIGHTBRINGER, threshold: 4, have: 0, pieces: PIECES_4PC, broken },
				dps,
				outcome: true,
			});
			/** The 4pc past the stop; `undefined` is a figure within the noise. */
			const pastStop4 = (dps: number | undefined, broken: Array<{ setName: string; threshold: number }> = []) => ({
				...reachable4(dps as number, broken),
				againstStop: true,
				...(dps === undefined ? { belowNoise: true } : {}),
			});

			it('lists the 4pc past a 2pc stop like the toggle-off line, valued against the stop’s gear', () => {
				// 2pc gear 30.5 and 4pc gear 20 against current gear: the stop is the 2pc, and the 4pc would move the figure by 20 - 30.5.
				const row = stepRow({ futureBonuses: [future(), fourPiece(20)] });
				expect(setBonusTipLines(row, { ...context, withSetPotential: true })?.entries).toEqual([
					{ type: 'line', label: { kind: 'item_stats', unmeasuredBreaks: [] }, dps: 4.5 },
					{ type: 'heading', heading: 'set_potential' },
					{ type: 'line', label: { kind: 'pieces', form: 'step', pieces: ['Lightbringer Breastplate'], threshold: 2, broken: [] }, dps: 26 },
					totalLine(30.5),
					{ type: 'heading', heading: 'not_counted' },
					pastStop4(-10.5),
				]);
				// Toggle off is unchanged: both bonuses, each against the item alone.
				expect(setBonusTipLines(row, context)?.entries).toEqual([totalLine(4.5), { type: 'heading', heading: 'not_counted_off' }, reachable(26), reachable4(15.5)]);
			});

			it('gives a step past the stop no figure when its difference from the stop’s gear is within the noise', () => {
				// The noise floor is √2 × 3 = 4.24. A tie under the strict best-stop rule, then a 3.5 gap.
				for (const stepGearDps of [30.5, 27]) {
					const row = stepRow({ futureBonuses: [future(), fourPiece(stepGearDps)] });
					const tip = setBonusTipLines(row, { ...context, withSetPotential: true });
					expect(tip?.entries.slice(-2)).toEqual([{ type: 'heading', heading: 'not_counted' }, pastStop4(undefined)]);
				}
			});

			it('compares the gap with twice the two step gears’ standard errors added in quadrature', () => {
				// A 10.5 gap. Either error alone at 6 hides it (2 × 6 = 12), so a gate that read only the other one would show it.
				// Both at 4 hide it only together: 2 × √32 = 11.31, but 2 × 4 = 8. At 3, the floor 4.24 and 2 × √18 = 8.49 do not.
				for (const [stopSe, stepSe, expected] of [
					[6, 0, pastStop4(undefined)],
					[0, 6, pastStop4(undefined)],
					[4, 4, pastStop4(undefined)],
					[3, 3, pastStop4(-10.5)],
				] as const) {
					const row = stepRow({ futureBonuses: [future({ stepGearSe: stopSe }), fourPiece(20, { stepGearSe: stepSe })] });
					expect(setBonusTipLines(row, { ...context, withSetPotential: true })?.entries.at(-1)).toEqual(expected);
				}
			});

			it('lists nothing under "Not counted" when the stop is the last step', () => {
				const row = stepRow({ futureBonuses: [future({ stepGearDps: 10 }), fourPiece(40)] });
				const tip = setBonusTipLines(row, { ...context, withSetPotential: true });
				expect(tip?.entries.at(-1)).toEqual(totalLine(40));
				expect(tip?.entries.filter(e => e.type === 'heading')).toEqual([{ type: 'heading', heading: 'set_potential' }]);
				expect(addsUp(tip)).toBe(true);
			});

			it('names the worn bonuses the later step breaks beyond the row’s own swap, as the toggle-off line does', () => {
				const justicar = { setId: 626, setName: 'Justicar Battlegear', threshold: 2 as const, dps: 30 };
				const row = stepRow({ futureBonuses: [future(), fourPiece(20, { breaks: [justicar] })] });
				const tip = setBonusTipLines(row, { ...context, withSetPotential: true });
				expect(tip?.entries.at(-1)).toEqual(pastStop4(-10.5, [{ setName: 'Justicar Battlegear', threshold: 2 }]));
			});
		});

		it('keeps the receipt of the row’s own break and does not name that break again in a reachable line', () => {
			const crystalforge = { setId: 629, setName: 'Crystalforge Battlegear', threshold: 2 as const };
			const justicar = { setId: 626, setName: 'Justicar Battlegear', threshold: 2 as const };
			const row = stepRow({ singleBreaks: [{ ...crystalforge, dps: 18.43 }], futureBonuses: [future({ breaks: [crystalforge, justicar] })] });
			const tip = setBonusTipLines(row, context);
			expect(tip?.entries).toEqual([
				{ type: 'line', label: { kind: 'item_stats', unmeasuredBreaks: [] }, dps: 22.9 },
				{ type: 'line', label: { kind: 'breaks', broken: [{ setName: 'Crystalforge Battlegear', threshold: 2 }] }, dps: -18.4 },
				totalLine(4.5),
				{ type: 'heading', heading: 'not_counted_off' },
				reachable(26, [{ setName: 'Justicar Battlegear', threshold: 2 }]),
			]);
			expect(addsUp(tip)).toBe(true);
		});

		it('leaves the toggle-on popover of every credited row of the feral fixtures as it was before ticket 336, adding only the steps past the stop', () => {
			// Captured from the fork at 176268e7c (before ticket 336) over data/tab-fixtures/feral-p3-p2bis.json and feral-p3-th-hands-legs.json.
			// A value cast: the JSON import's own type widens every literal, so it is not used as a type.
			const snapshot = onSnapshot as unknown as Record<string, { ranking: Ranking; rows: Array<{ row: RankedItem; tip: SetBonusTip }> }>;
			const rows = Object.values(snapshot).flatMap(fixture => fixture.rows.map(({ row, tip }) => ({ ranking: fixture.ranking, row, tip })));
			expect(rows).toHaveLength(16);
			let withPastStop = 0;
			for (const { ranking, row, tip } of rows) {
				const now = setBonusTipLines(row, { ranking, withSetPotential: true });
				expect(now && { ...now, entries: now.entries.slice(0, tip.entries.length) }).toEqual(tip);
				// Ticket 655: the Malorne rows of feral-p3-th-hands-legs stop at the 2pc, so their 4pc follows under "Not counted".
				const added = now!.entries.slice(tip.entries.length);
				if (added.length === 0) continue;
				withPastStop++;
				expect(added[0]).toEqual({ type: 'heading', heading: 'not_counted' });
				for (const entry of added.slice(1)) expect(entry).toMatchObject({ type: 'line', label: { kind: 'reachable', threshold: 4 }, outcome: true });
			}
			expect(withPastStop).toBe(5);
		});
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
