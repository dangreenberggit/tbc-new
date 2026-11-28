/**
 * Set rows valued by simmed gear: the gain side tries every count the pool reaches, the check
 * runs before the package sim, and a row is credited from the sim of its credited gear (the
 * current gear plus the row plus the partner pieces `choosePartners` picks), on the model sim of
 * `testing/set_bonus_scenario.ts`. Each case stands for a kind of situation; its set is the
 * example. Every literal is derived by hand from that model.
 */

import { describe, expect, it, vi } from 'vitest';

import {
	bonusOf,
	brk,
	CHEST_SLOT,
	COPY_OFFSET,
	CRYPTSTALKER,
	CRYSTALFORGE,
	FLOOR,
	futureOf,
	HANDS_SLOT,
	idsOf,
	JUSTICAR,
	LEGS_SLOT,
	MALORNE,
	MALORNE_SHOULDER_CHEST_SCENARIO,
	PRIMAL_INTENT,
	runScenario,
	type Scenario,
	type ScenarioRow,
	SET_BONUSES,
	SET_KEPT_OFFSET,
	setPool,
	setSkipLines,
	SHOULDER_SLOT,
	simFailedLine,
	sortedIds,
	TH_FOUR,
	TH_FOUR_INTERACTION_SCENARIO,
	TH_FOUR_POOL,
	thRow,
	THUNDERHEART,
	WASTEWALKER,
	withValues,
	wornGear,
} from '../testing/set_bonus_scenario';
import { MemoryStore } from './engine/seams/store';
import {
	canBeCredited,
	crossingLabelCount,
	rankableSetPotential,
	setBonusSubLine,
	setCreditUnmeasured,
	setPotentialIncrements,
	type SetPotentialTerm,
	setPotentialTerms,
} from './engine/set-potential';
import { SIM_ORDER } from './engine/slots';

// The engine reads items and gems through `Database.getSync()`; the real class over the test database stands in for the page's.
vi.mock('@sim/proto/database', importOriginal => import('../testing/database_mock').then(m => m.withTestDatabase(importOriginal)));

/** The `"outcome"` terms of a bonus-gear ranking's row, in count order. */
function outcomeTerms(row: Pick<ScenarioRow, 'setContext'>) {
	return setPotentialTerms(row.setContext, FLOOR).terms.filter((t): t is OutcomeTerm => t.kind === 'outcome');
}

/** A row's increments as [count, added piece ids, dps, isCredited, newly broken]. */
function incrementsOf(row: Pick<ScenarioRow, 'setContext'>) {
	return setPotentialIncrements(row.setContext, FLOOR)?.map(s => [
		s.threshold,
		s.pieces.map(p => p.itemId),
		Number(s.dps.toFixed(9)),
		s.isCredited,
		s.broken.map(b => [b.setId, b.threshold]),
	]);
}

type OutcomeTerm = Extract<SetPotentialTerm, { kind: 'outcome' }>;

const WRIST_SLOT = SIM_ORDER.indexOf('wrist');

describe('set rows valued by simmed gear', () => {
	it('a bonus that measures 0 on identical gear although its pieces combine earns nothing', async () => {
		// Scenario kind: a set whose bonuses do nothing for this spec's rotation
		// (a ret set's Judgement and healing bonuses), while its pieces' stats
		// are worth more worn together. Example: Justicar 626, own value −30
		// each, model bonuses 0, +17 when all four are worn.
		const scenario: Scenario = {
			worn: wornGear({}),
			pool: setPool(JUSTICAR),
			itemValue: withValues(Object.values(JUSTICAR).map(id => [id, -30] as const)),
			setBonuses: { ...SET_BONUSES, 626: { b2: 0, b4: 0 } },
			interactions: [{ ids: Object.values(JUSTICAR), dps: 17 }],
		};
		const off = await runScenario(scenario);
		const on = await runScenario({
			...scenario,
			measureSetBonuses: true,
		});
		// Without the flag, the table's 4pc package minus its singles reads the
		// +17 as a bonus: −103 − (−120).
		expect(bonusOf(off.ranking, 626, 4)?.bonusDps).toBeCloseTo(17, 9);
		for (const t of [2, 3, 4]) {
			const b = bonusOf(on.ranking, 626, t);
			expect(b?.sameGearDps).toBe(0);
			expect(b?.belowNoise).toBe(true);
			expect(b?.bonusDps).toBeUndefined();
		}
		// No package, pair or bonus-gear sim: no request wears two real Justicar
		// pieces without a copy among them. Base, four singles, three checks.
		const justicarIds = new Set<number>(Object.values(JUSTICAR));
		expect(on.calls.filter(ids => !ids.some(id => id >= COPY_OFFSET) && ids.filter(id => justicarIds.has(id)).length >= 2)).toEqual([]);
		expect(on.runCount).toBe(1 + 4 + 6);
		expect(on.ranking.bonusGearSims).toEqual({
			partnerRule: 'close-calls',
			gears: 0,
			simmed: 0,
			fromStore: 0,
		});
		// ON = OFF.
		for (const id of Object.values(JUSTICAR)) {
			expect(rankableSetPotential(thRow(on.ranking, id), FLOOR)).toBe(0);
		}
	});

	it("a row inside the 4-piece group is credited from its credited gear's sim, interaction included", async () => {
		// Scenario kind: a tier set whose pieces' stats interact (here they lose
		// 40 worn together), with a count that has no bonus between the two
		// that do. Example: Thunderheart 676, model 2pc 50 and 4pc 80.
		const { ranking: r } = await runScenario(TH_FOUR_INTERACTION_SCENARIO);
		expect(bonusOf(r, 676, 2)?.sameGearDps).toBeCloseTo(50, 9);
		expect(bonusOf(r, 676, 4)?.sameGearDps).toBeCloseTo(80, 9);
		expect(bonusOf(r, 676, 3)?.belowNoise).toBe(true);
		const hands = thRow(r, THUNDERHEART.hands);
		expect(hands.setContext?.usesBonusGear).toBe(true);
		expect(hands.setContext?.singleDeltaDps).toBeCloseTo(100, 9);
		// The credited gear wears all four: 400 + 50 + 80 − 40 = 490 over 3000.
		expect(futureOf(hands, 4)?.bonusGearDps).toBeCloseTo(490, 9);
		// A within-noise count among the futures does not zero the row.
		expect(futureOf(hands, 3)?.belowNoise).toBe(true);
		expect(setCreditUnmeasured(hands.setContext)).toBe(false);
		const credit = rankableSetPotential(hands, FLOOR);
		expect(credit).toBeCloseTo(390, 9);
		// ON = the credited gear's sim = the 4-piece package delta.
		expect(hands.deltaDps + credit).toBeCloseTo(490, 9);
		expect(bonusOf(r, 676, 4)?.packageDeltaDps).toBeCloseTo(490, 9);
		expect(outcomeTerms(hands).map(t => [t.threshold, t.isCredited])).toEqual([
			[2, false],
			[4, true],
		]);
		// The "increments that add up" breakdown: the 2pc partner (Chestguard) is inside the
		// 4pc partner set, so the row's increments are differences of its totals:
		// 250 − 100 = 150 for the Chestguard, then 490 − 250 = 240 for the
		// Pauldrons and Leggings. They add up to the credit, 390.
		expect(incrementsOf(hands)).toEqual([
			[2, [THUNDERHEART.chest], 150, false, []],
			[4, [THUNDERHEART.shoulder, THUNDERHEART.legs], 240, true, []],
		]);
		// Every row's three 2pc partner sets tie on estimate, so all are close
		// calls: the choices sim the six pairs (12 calls; the 2pc package,
		// hands + chest, from the store), then the four distinct bonus gears
		// come from the store.
		expect(r.bonusGearSims).toEqual({
			partnerRule: 'close-calls',
			gears: 4,
			simmed: 5,
			fromStore: 11,
		});
		// The same holds on every row.
		for (const id of TH_FOUR) {
			const row = thRow(r, id);
			const c = rankableSetPotential(row, FLOOR);
			const credited = outcomeTerms(row).find(t => t.isCredited)!;
			expect(row.deltaDps + c).toBeCloseTo(credited.bonusGearDps, 6);
		}
	});

	it('a row whose 4pc does not pay is credited at the 2pc', async () => {
		// Scenario kind: a 4pc worth less than what its extra pieces cost. As
		// TH_FOUR_INTERACTION_SCENARIO with model 4pc 10, and own value −40 for the two pieces only the
		// 4-piece set adds (Pauldrons and Leggings).
		const { ranking: r } = await runScenario({
			...TH_FOUR_INTERACTION_SCENARIO,
			setBonuses: { ...SET_BONUSES, 676: { b2: 50, b4: 10 } },
			itemValue: withValues([
				[THUNDERHEART.shoulder, -40],
				[THUNDERHEART.legs, -40],
			]),
		});
		const hands = thRow(r, THUNDERHEART.hands);
		expect(outcomeTerms(hands).map(t => [t.threshold, t.isCredited])).toEqual([
			[2, true],
			[4, false],
		]);
		// ON = model(G + Gauntlets + Chestguard) − model(G) = 200 + 50.
		const credit = rankableSetPotential(hands, FLOOR);
		expect(hands.deltaDps + credit).toBeCloseTo(250, 9);
		expect(futureOf(hands, 2)?.pieces?.map(p => p.itemId)).toEqual([THUNDERHEART.chest]);
		// Only the increments up to the credited bonus: 250 − 100 = 150.
		expect(incrementsOf(hands)).toEqual([[2, [THUNDERHEART.chest], 150, true, []]]);
	});

	it('a row in the 4-piece group only keeps its own break and is credited from its credited gear', async () => {
		// Scenario kind: a set piece outside the best 2-piece package, whose own
		// swap breaks a worn bonus. Example: worn Malorne hands and legs (2pc
		// 40); the Thunderheart Gauntlets replace the Malorne hands.
		const { ranking: r } = await runScenario({
			worn: wornGear({ hands: MALORNE.hands, legs: MALORNE.legs }),
			pool: TH_FOUR_POOL,
			measureSetBonuses: true,
		});
		expect(sortedIds(bonusOf(r, 676, 2)?.packageItemIds)).toEqual([THUNDERHEART.chest, THUNDERHEART.shoulder]);
		const hands = thRow(r, THUNDERHEART.hands);
		expect((hands.setContext?.singleBreaks ?? []).map(brk)).toEqual([{ setId: 640, threshold: 2, dps: 40 }]);
		// Credited gear: four Thunderheart, Malorne at 0: 3530 − 3040 = 490.
		const credit = rankableSetPotential(hands, FLOOR);
		expect(credit).toBeCloseTo(430, 9);
		expect(hands.deltaDps + credit).toBeCloseTo(490, 9);
		expect(outcomeTerms(hands).find(t => t.isCredited)?.threshold).toBe(4);
	});

	it('a row outside the groups moves one for one with its own value', async () => {
		// Scenario kind: a set piece weaker than every package piece. As TH_FOUR_INTERACTION_SCENARIO
		// plus the Thunderheart Wristguards at own value v, run at v = 10 and 35.
		const on = async (v: number) => {
			const { ranking } = await runScenario({
				...TH_FOUR_INTERACTION_SCENARIO,
				pool: [...TH_FOUR_POOL, { itemId: THUNDERHEART.wrist, slot: 'wrist' }],
				itemValue: withValues([[THUNDERHEART.wrist, v]]),
			});
			const row = thRow(ranking, THUNDERHEART.wrist);
			return row.deltaDps + rankableSetPotential(row, FLOOR);
		};
		const at10 = await on(10);
		// The credited gear is wrist + Gauntlets + Chestguard + Leggings:
		// 10 + 300 + 50 + 80 (the four-piece interaction needs the Pauldrons).
		expect(at10).toBeCloseTo(440, 9);
		expect((await on(35)) - at10).toBeCloseTo(25, 9);
	});

	it("a failed check sim makes the set's rows unmeasured; a failed bonus-gear sim, only its row", async () => {
		// Scenario kind: a sim that fails mid-run. Example: TH_FOUR_INTERACTION_SCENARIO's pool, model
		// with no interaction.
		const base: Scenario = {
			worn: wornGear({}),
			pool: TH_FOUR_POOL,
			measureSetBonuses: true,
		};
		// The (676, 4) check's "off" sim is the only request with a set-less
		// Pauldrons: the 4-piece package copies its first piece in slot order.
		const failedCheck = await runScenario({
			...base,
			failWhen: ids => ids.includes(COPY_OFFSET + THUNDERHEART.shoulder),
		});
		expect(bonusOf(failedCheck.ranking, 676, 4)?.unmeasured).toBe('sim-failed');
		expect(bonusOf(failedCheck.ranking, 676, 4)?.sameGearDps).toBeUndefined();
		// the line carries the check sim's own error.
		expect(setSkipLines(failedCheck.ranking)).toEqual([simFailedLine(4)]);
		for (const id of TH_FOUR) {
			const row = thRow(failedCheck.ranking, id);
			expect(setCreditUnmeasured(row.setContext)).toBe(true);
			expect(rankableSetPotential(row, FLOOR)).toBe(0);
			expect(setBonusSubLine(row.setContext, true)).toBe('not_counted');
		}
		// Every 2pc gear of the Pauldrons row (the Pauldrons and one
		// other real Thunderheart piece) fails. Its three partner sets are close
		// calls, so one failure alone would only skip that set; with all
		// three failed the row keeps the sum-of-singles estimate's choice, whose
		// bonus-gear sim fails too.
		const thSlots = [SHOULDER_SLOT, CHEST_SLOT, HANDS_SLOT, LEGS_SLOT];
		const bonusGearFail = await runScenario({
			...base,
			failWhen: ids => ids[SHOULDER_SLOT] === THUNDERHEART.shoulder && thSlots.filter(slot => ids[slot] !== 0).length === 2,
		});
		const pauldrons = thRow(bonusGearFail.ranking, THUNDERHEART.shoulder);
		expect(futureOf(pauldrons, 2)?.bonusGearDps).toBeUndefined();
		// the failed bonus-gear sims' error reaches the player once.
		const bonusGearLines = setSkipLines(bonusGearFail.ranking);
		expect(bonusGearLines).toContainEqual(simFailedLine(2, true));
		expect(new Set(bonusGearLines.map(l => `${l.field}|${l.detail}`)).size).toBe(bonusGearLines.length);
		expect(rankableSetPotential(pauldrons, FLOOR)).toBe(0);
		expect(setCreditUnmeasured(pauldrons.setContext)).toBe(true);
		// The others are credited at the 4pc: 400 + 130 − 100.
		for (const id of [THUNDERHEART.chest, THUNDERHEART.hands, THUNDERHEART.legs]) {
			expect(rankableSetPotential(thRow(bonusGearFail.ranking, id), FLOOR)).toBeCloseTo(430, 9);
		}
	});

	it('a count with no bonus runs its two check sims and nothing else, and is never a package', async () => {
		// Scenario kind: a count between two bonuses (every tier set at 3).
		// Example: worn Malorne hands and legs, Thunderheart pool of five; the
		// model has b2 and b4 only.
		const { ranking: r, calls } = await runScenario({
			worn: wornGear({ hands: MALORNE.hands, legs: MALORNE.legs }),
			pool: [...TH_FOUR_POOL, { itemId: THUNDERHEART.wrist, slot: 'wrist' }],
			measureSetBonuses: true,
		});
		const three = bonusOf(r, 676, 3);
		expect(three?.sameGearDps).toBe(0);
		expect(three?.belowNoise).toBe(true);
		expect(sortedIds(three?.packageItemIds)).toEqual([THUNDERHEART.chest, THUNDERHEART.shoulder, THUNDERHEART.wrist]);
		// The 3-piece package keeps both worn Malorne pieces; its check
		// copies the Pauldrons (first in slot order) and nothing else wears it.
		const onThreeGear = (ids: readonly number[]) =>
			ids[CHEST_SLOT] === THUNDERHEART.chest &&
			ids[WRIST_SLOT] === THUNDERHEART.wrist &&
			ids[HANDS_SLOT] === MALORNE.hands &&
			ids[LEGS_SLOT] === MALORNE.legs;
		const threeGear = calls.filter(onThreeGear);
		expect(
			threeGear
				.map(ids => ids[SHOULDER_SLOT]!)
				.filter(id => id >= COPY_OFFSET)
				.sort((a, b) => a - b),
		).toEqual([COPY_OFFSET + THUNDERHEART.shoulder, SET_KEPT_OFFSET + THUNDERHEART.shoulder]);
		expect(threeGear.filter(ids => ids[SHOULDER_SLOT] === THUNDERHEART.shoulder)).toEqual([]);
		// No row takes its top package or packages from a within-noise
		// entry. The top measured package is the 4pc (3530 − 3040 = 490), not
		// the within-noise 5pc.
		for (const id of [THUNDERHEART.shoulder, THUNDERHEART.chest, THUNDERHEART.wrist, THUNDERHEART.hands]) {
			const row = thRow(r, id);
			expect(row.setContext?.commitPackageDeltaDps).toBeCloseTo(490, 9);
			expect((row.setContext?.packages ?? []).map(p => p.threshold)).toEqual([2, 4]);
			// Never the credited bonus.
			expect(outcomeTerms(row).map(t => t.threshold)).toEqual([2, 4]);
		}
	});

	it('a set whose only bonus needs 3 pieces can be credited', async () => {
		// Scenario kind: a three-piece crafted set (cloth, leather, mail).
		// Example: Primal Intent 619, own value 100 each, model 3pc 25 only.
		const { ranking: r } = await runScenario({
			worn: wornGear({}),
			pool: setPool(PRIMAL_INTENT),
			itemValue: withValues(Object.values(PRIMAL_INTENT).map(id => [id, 100] as const)),
			setBonuses: { ...SET_BONUSES, 619: { b2: 0, b3: 25, b4: 0 } },
			measureSetBonuses: true,
		});
		const chest = thRow(r, PRIMAL_INTENT.chest);
		expect(futureOf(chest, 2)?.belowNoise).toBe(true);
		expect(canBeCredited(futureOf(chest, 3)!, FLOOR)).toBe(true);
		// Credited gear: all three, 300 + 25.
		expect(futureOf(chest, 3)?.bonusGearDps).toBeCloseTo(325, 9);
		expect(outcomeTerms(chest).find(t => t.isCredited)?.threshold).toBe(3);
		expect(rankableSetPotential(chest, FLOOR)).toBeCloseTo(225, 9);
	});

	it("a failed crossing check sim leaves the check not cleared and shows the sim's error", async () => {
		// Scenario kind: the crossing case's Crystalforge 629 worn at 1, model 2pc 30. The
		// crossing check copies the chest, the lower slot, so its "off" sim is
		// the one request with a set-less chest, the hands and no legs. At worn
		// 1 the 2pc package adds one piece, so it runs no check of its own.
		const { ranking } = await runScenario({
			worn: wornGear({ chest: CRYSTALFORGE.chest }),
			pool: [
				{ itemId: CRYSTALFORGE.hands, slot: 'hands' },
				{ itemId: CRYSTALFORGE.legs, slot: 'legs' },
			],
			itemValue: withValues(Object.values(CRYSTALFORGE).map(id => [id, 100] as const)),
			setBonuses: { ...SET_BONUSES, 629: { b2: 30, b4: 0 } },
			measureSetBonuses: true,
			failWhen: ids => ids.includes(COPY_OFFSET + CRYSTALFORGE.chest) && ids.includes(CRYSTALFORGE.hands) && !ids.includes(CRYSTALFORGE.legs),
		});
		expect(ranking.crossingChecks).toEqual([{ setId: 629, count: 2, itemId: CRYSTALFORGE.hands, cleared: false }]);
		expect(setSkipLines(ranking)).toEqual([simFailedLine(2)]);
	});

	it("one added piece crosses a bonus only when that count's crossing check clears", async () => {
		// Scenario kind: a set worn one short of a bonus, with a candidate in a
		// free slot. Examples: Crystalforge 629 worn at 1 (chest) with model 2pc
		// 30, then 0; Primal Intent 619 worn at 2 with model 3pc 25.
		const crystalforge = (b2: number) =>
			runScenario({
				worn: wornGear({ chest: CRYSTALFORGE.chest }),
				pool: [
					{ itemId: CRYSTALFORGE.hands, slot: 'hands' },
					{ itemId: CRYSTALFORGE.legs, slot: 'legs' },
				],
				itemValue: withValues(Object.values(CRYSTALFORGE).map(id => [id, 100] as const)),
				setBonuses: { ...SET_BONUSES, 629: { b2, b4: 0 } },
				measureSetBonuses: true,
			});
		const yes = (await crystalforge(30)).ranking;
		expect(yes.crossingChecks).toEqual([
			{
				setId: 629,
				count: 2,
				itemId: CRYSTALFORGE.hands,
				dps: 30,
				se: expect.any(Number),
				cleared: true,
			},
		]);
		const hands = thRow(yes, CRYSTALFORGE.hands);
		expect(hands.setContext?.crossesThreshold).toBe(true);
		expect(crossingLabelCount(hands.setContext)).toBe(2);
		const no = (await crystalforge(0)).ranking;
		expect(no.crossingChecks?.map(g => [g.count, g.dps, g.cleared])).toEqual([[2, 0, false]]);
		const handsNo = thRow(no, CRYSTALFORGE.hands);
		expect(handsNo.setContext?.crossesThreshold).toBe(false);
		expect(crossingLabelCount(handsNo.setContext)).toBeNull();

		const { ranking: pi } = await runScenario({
			worn: wornGear({
				chest: PRIMAL_INTENT.chest,
				wrist: PRIMAL_INTENT.wrist,
			}),
			pool: [{ itemId: PRIMAL_INTENT.waist, slot: 'waist' }],
			itemValue: withValues(Object.values(PRIMAL_INTENT).map(id => [id, 100] as const)),
			setBonuses: { ...SET_BONUSES, 619: { b2: 0, b3: 25, b4: 0 } },
			measureSetBonuses: true,
		});
		const waist = thRow(pi, PRIMAL_INTENT.waist);
		expect(waist.setContext?.crossesThreshold).toBe(true);
		expect(crossingLabelCount(waist.setContext)).toBe(3);
	});

	it('a set with bonuses above 4 pieces gets every count, and a row can be credited at 8', async () => {
		// Scenario kind: a set with bonuses at 6 or 8 pieces. Example:
		// Cryptstalker 530, own value 100 each, model 2pc 10, 4pc 20, 6pc 30,
		// 8pc 40, nothing worn, all eight pieces in the pool.
		const { ranking: r } = await runScenario({
			worn: wornGear({}),
			pool: setPool(CRYPTSTALKER),
			itemValue: withValues(Object.values(CRYPTSTALKER).map(id => [id, 100] as const)),
			setBonuses: { ...SET_BONUSES, 530: { b2: 10, b4: 20, b6: 30, b8: 40 } },
			measureSetBonuses: true,
		});
		expect((r.setBonuses ?? []).filter(b => b.setId === 530).map(b => [b.threshold, b.belowNoise ?? false, b.sameGearDps])).toEqual([
			[2, false, 10],
			[3, true, 0],
			[4, false, 20],
			[5, true, 0],
			[6, false, 30],
			[7, true, 0],
			[8, false, 40],
		]);
		// The credited gear wears all eight, 800 + 100, less the row's 100.
		const hands = thRow(r, CRYPTSTALKER.hands);
		expect(outcomeTerms(hands).find(t => t.isCredited)?.threshold).toBe(8);
		expect(rankableSetPotential(hands, FLOOR)).toBeCloseTo(800, 9);
	});

	it('two partners that share a worn-bonus loss pair best with each other', async () => {
		// Scenario kind: two set pieces that each break the same worn bonus
		// alone, so together they lose it once. Example: feral P2 BiS, worn
		// Malorne 2pc in the shoulder and chest slots (MALORNE_SHOULDER_CHEST_SCENARIO).
		const { ranking } = await runScenario(MALORNE_SHOULDER_CHEST_SCENARIO);
		const pauldrons = thRow(ranking, THUNDERHEART.shoulder);
		expect(pauldrons.deltaDps).toBeCloseTo(-82, 9);
		expect(futureOf(pauldrons, 2)?.pieces?.map(p => p.itemId)).toEqual([THUNDERHEART.chest]);
		// model(G + Pauldrons + Chestguard) − model(G) = 3070 − 3090.
		expect(futureOf(pauldrons, 2)?.bonusGearDps).toBeCloseTo(-20, 9);
		// The Gauntlets row. 2pc with the
		// Leggings: 6 − 12 + 50 = 44, an increment of 38. 4pc with the Pauldrons and
		// Chestguard: 6 + 8 + 12 − 12 + 50 + 80 − 90 = 54, an increment of 10 that
		// breaks Malorne 2pc. The Gauntlets alone break nothing.
		expect(incrementsOf(thRow(ranking, THUNDERHEART.hands))).toEqual([
			[2, [THUNDERHEART.legs], 38, false, []],
			[4, [THUNDERHEART.shoulder, THUNDERHEART.chest], 10, true, [[640, 2]]],
		]);
	});

	it('a partner set that loses a worn bonus no single swap loses is charged for it', async () => {
		// Scenario kind: a worn set with one piece more than its bonus needs;
		// any one swap keeps the bonus, two together lose it. Example:
		// Wastewalker 659 worn 3 (shoulder, chest, hands), model 2pc 30; the
		// Thunderheart Leggings row's 4pc partners from the Pauldrons and
		// Chestguard (110 each, both replace Wastewalker) and the Wristguards
		// and Waistguard (100 each, replace nothing).
		const scenario: Scenario = {
			worn: wornGear({
				shoulder: WASTEWALKER.shoulder,
				chest: WASTEWALKER.chest,
				hands: WASTEWALKER.hands,
			}),
			pool: [
				{ itemId: THUNDERHEART.shoulder, slot: 'shoulder' },
				{ itemId: THUNDERHEART.chest, slot: 'chest' },
				{ itemId: THUNDERHEART.wrist, slot: 'wrist' },
				{ itemId: THUNDERHEART.waist, slot: 'waist' },
				{ itemId: THUNDERHEART.legs, slot: 'legs' },
			],
			setBonuses: { ...SET_BONUSES, 659: { b2: 30, b4: 0 } },
			itemValue: withValues([
				[THUNDERHEART.shoulder, 110],
				[THUNDERHEART.chest, 110],
			]),
			measureSetBonuses: true,
		};
		const legs = thRow((await runScenario(scenario)).ranking, THUNDERHEART.legs);
		// The sum-of-singles estimate, charged for the loss, keeps the Wastewalker 2pc (one
		// replacer): 100 + 310 + 130 = 540.
		expect(futureOf(legs, 4)?.pieces?.map(p => p.itemId)).toEqual([THUNDERHEART.chest, THUNDERHEART.wrist, THUNDERHEART.waist]);
		expect(futureOf(legs, 4)?.breaks ?? []).toEqual([]);
		expect(futureOf(legs, 4)?.bonusGearDps).toBeCloseTo(540, 9);
	});

	it('the partner rule is close-calls, has no cache key, and sims each close partner set once', async () => {
		// Scenario kind: the tab's run on one character, run twice on one
		// shared store. Example: MALORNE_SHOULDER_CHEST_SCENARIO.
		const store = new MemoryStore();
		const first = await runScenario({ ...MALORNE_SHOULDER_CHEST_SCENARIO, store });
		expect(first.ranking.bonusGearSims?.partnerRule).toBe('close-calls');
		// The hashed object has no partnerRule key, as before.
		expect(first.ranking.contentHash).not.toContain('"partnerRule"');
		const again = await runScenario({ ...MALORNE_SHOULDER_CHEST_SCENARIO, store });
		expect(again.runCount).toBe(0);
		expect(again.ranking.contentHash).toBe(first.ranking.contentHash);
		// The Pauldrons row's three 2pc partner sets are estimated at −70
		// (Chestguard), −76 (Gauntlets) and −94 (Leggings): −82 + d_p, plus 90
		// back for the shared Malorne loss. All are within the close-call
		// margin of −70, so each partner set of that row is simmed once.
		for (const partner of [
			{ chest: THUNDERHEART.chest },
			{ chest: MALORNE.chest, hands: THUNDERHEART.hands },
			{ chest: MALORNE.chest, legs: THUNDERHEART.legs },
		]) {
			const gear = JSON.stringify(idsOf({ shoulder: THUNDERHEART.shoulder, ...partner }));
			expect(first.calls.filter(ids => JSON.stringify(ids) === gear)).toHaveLength(1);
		}
	});

	it('partner sets that do not nest are each valued by their own total', async () => {
		// Scenario kind: the best 2pc partner is not in the best 4pc partner
		// set. Example: worn Primal Intent 619 at 3 (model 2pc 50, 3pc 30); the
		// Thunderheart Leggings row (100); the Gauntlets (110) replace nothing,
		// the Chestguard, Wristguards and Waistguard (120 each) each replace a
		// Primal Intent piece.
		const { ranking: r } = await runScenario({
			worn: wornGear(PRIMAL_INTENT),
			pool: [
				{ itemId: THUNDERHEART.chest, slot: 'chest' },
				{ itemId: THUNDERHEART.wrist, slot: 'wrist' },
				{ itemId: THUNDERHEART.hands, slot: 'hands' },
				{ itemId: THUNDERHEART.waist, slot: 'waist' },
				{ itemId: THUNDERHEART.legs, slot: 'legs' },
			],
			setBonuses: { ...SET_BONUSES, 619: { b2: 50, b3: 30, b4: 0 } },
			itemValue: withValues([
				[THUNDERHEART.chest, 120],
				[THUNDERHEART.wrist, 120],
				[THUNDERHEART.waist, 120],
				[THUNDERHEART.hands, 110],
			]),
			measureSetBonuses: true,
		});
		const legs = thRow(r, THUNDERHEART.legs);
		const outcomes = outcomeTerms(legs);
		expect(outcomes.map(t => [t.threshold, t.pieces.map(p => p.itemId)])).toEqual([
			[2, [THUNDERHEART.hands]],
			[4, [THUNDERHEART.chest, THUNDERHEART.wrist, THUNDERHEART.waist]],
		]);
		// Totals over 3080: 2pc 100 + 110 + 50 (Primal Intent kept) = 260; 4pc
		// 100 + 360 + 130, Primal Intent at 0, = 510.
		expect(outcomes.map(t => t.bonusGearDps)).toEqual([260, 510]);
		expect(outcomes.map(t => t.isCredited)).toEqual([false, true]);
		expect(rankableSetPotential(legs, FLOOR)).toBeCloseTo(510 - 100, 9);
		// The 2pc partner (Gauntlets) is not in the 4pc partner set, so
		// there are no increments; the tab shows the totals as separate outcomes.
		expect(setPotentialIncrements(legs.setContext, FLOOR)).toBeNull();
	});

	it('two set rings key to one slot, so their 2pc is out of reach', async () => {
		// Scenario kind: a set with two pieces of a two-slot item type (rings,
		// trinkets, one-hand weapons). `selectAddedPieces` keys each candidate to
		// its first sim slot, so both rings fight over finger1 and the
		// set never reaches 2. Example: Zanzil's Concentration 462 (19893 and
		// 19905), model 2pc 40. This pins today's limit.
		const { ranking: r } = await runScenario({
			worn: wornGear({}),
			pool: [
				{ itemId: 19893, slot: 'finger' },
				{ itemId: 19905, slot: 'finger' },
			],
			itemValue: withValues([
				[19893, 100],
				[19905, 100],
			]),
			setBonuses: { ...SET_BONUSES, 462: { b2: 40, b4: 0 } },
			measureSetBonuses: true,
		});
		// No bonus is in reach, so the set has no entry.
		expect((r.setBonuses ?? []).map(b => [b.setId, b.threshold, b.unmeasured])).toEqual([]);
		expect(r.bonusGearSims?.gears).toBe(0);
	});
});
