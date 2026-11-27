/**
 * Set breaks with no list: the break side measures every count of every worn set with the ladder
 * and charges a count only when it clears the noise check, on the model sim of
 * `testing/set_bonus_scenario.ts`. Each case stands for a kind of situation; its set is the
 * example. Every literal is derived by hand from that model.
 */

import { describe, expect, it, vi } from 'vitest';

import {
	bonusOf,
	brk,
	bsvDps,
	CRYPTSTALKER,
	FLOOR,
	futB,
	MALORNE,
	near,
	netOf,
	NEUTRAL,
	PRIMAL_INTENT,
	PURSUIT,
	runScenario,
	type ScenarioRanking,
	SET_BONUSES,
	setPool,
	thRow,
	THUNDERHEART,
	WASTEWALKER,
	withSetValues,
	wornGear,
} from '../testing/set_bonus_scenario';
import { rankableSetPotential, type SetPotentialTerm, setPotentialTerms } from './engine/set-potential';

type OutcomeTerm = Extract<SetPotentialTerm, { kind: 'outcome' }>;

// The engine reads items and gems through `Database.getSync()`; the real class over the test database stands in for the page's.
vi.mock('@sim/proto/database', importOriginal => import('../testing/database_mock').then(m => m.withTestDatabase(importOriginal)));

// Every feral run reads hit, so each meta repair searches with the hit term, and several
// cases run 15-27 s alone, near the default timeout.
vi.setConfig({ testTimeout: 120_000 });

/** One worn set's counts as [count, rounded dps, counted]. */
const wornSetCountsOf = (ranking: ScenarioRanking, setId: number) =>
	(ranking.wornSetLadder ?? []).filter(e => e.setId === setId).map(e => [e.count, e.dps === undefined ? undefined : Math.round(e.dps), e.counted]);

const pkgBreaks = (ranking: ScenarioRanking, setId: number, threshold: number) =>
	(bonusOf(ranking, setId, threshold)?.breaks ?? []).map(b => [b.setId, b.threshold]);

describe('set breaks with no list', () => {
	it('a worn bonus from a set no hand-kept table lists is measured and charged', async () => {
		// Scenario kind: the player wears a non-tier set with bonuses at 2 and 4
		// (dungeon, crafted, other classes' sets), and an upgrade package takes
		// some of its pieces. Example: Wastewalker 659 worn 4/4, model 2pc 30 and
		// 4pc 20, broken by a Malorne package.
		const { ranking: r } = await runScenario({
			worn: wornGear(WASTEWALKER),
			pool: setPool({
				shoulder: MALORNE.shoulder,
				chest: MALORNE.chest,
				hands: MALORNE.hands,
				legs: MALORNE.legs,
			}),
			itemValue: withSetValues(Object.values(MALORNE)),
			setBonuses: { ...SET_BONUSES, 659: { b2: 30, b4: 20 } },
			measureSetBonuses: true,
		});
		expect(near(r.baseline.dps, 3050, 0.5)).toBe(true);
		expect(wornSetCountsOf(r, 659)).toEqual([
			[2, 30, true],
			[3, 0, false],
			[4, 20, true],
		]);
		expect(near(bsvDps(r, 659, 4)!, 20, 0.5)).toBe(true);
		expect(near(bsvDps(r, 659, 2)!, 30, 0.5)).toBe(true);
		expect(bsvDps(r, 659, 3)).toBeUndefined();
		// The 2pc package takes Wastewalker 4 -> 2: the 4pc only. The 4pc
		// package takes it to 0: both.
		expect(pkgBreaks(r, 640, 2)).toEqual([[659, 4]]);
		expect(pkgBreaks(r, 640, 4)).toEqual([
			[659, 4],
			[659, 2],
		]);
		expect(near(netOf(r, 640, 2)!, 40, 0.5)).toBe(true);
		expect(near(netOf(r, 640, 4)!, 70, 0.5)).toBe(true);
		// The Mantle row breaks the 4pc alone (20, inside its deltaDps). Each
		// eligible future names every worn bonus its bonus gear loses against the
		// current gear, the row's own break included; count 3 has no model bonus
		// and is within the noise.
		const mantle = thRow(r, MALORNE.shoulder);
		expect(near(mantle.deltaDps, 80, 0.5)).toBe(true);
		expect((mantle.setContext?.singleBreaks ?? []).map(brk)).toEqual([{ setId: 659, threshold: 4, dps: 20 }]);
		expect((mantle.setContext?.futureBonuses ?? []).map(futB)).toEqual([
			{
				threshold: 2,
				piecesNeeded: 2,
				dps: 40,
				breaks: [{ setId: 659, threshold: 4, dps: 20 }],
			},
			{ threshold: 3, piecesNeeded: 3, dps: undefined, breaks: [] },
			{
				threshold: 4,
				piecesNeeded: 4,
				dps: 70,
				breaks: [
					{ setId: 659, threshold: 4, dps: 20 },
					{ setId: 659, threshold: 2, dps: 30 },
				],
			},
		]);
		const credit = rankableSetPotential(mantle, FLOOR);
		expect(credit).toBeCloseTo(380, 9);
		expect(mantle.deltaDps + credit).toBeCloseTo(bonusOf(r, 640, 4)!.packageDeltaDps!, 9);
		// Bonus-gear rule: the credited bonus is the 4pc, and its term names the
		// Wastewalker bonuses its gear loses. ON = model(credited gear) − model(G):
		// four Malorne pieces 400 + 40 + 70 and no Wastewalker, 3510 − 3050.
		const outcomes = setPotentialTerms(mantle.setContext, FLOOR).terms.filter((t): t is OutcomeTerm => t.kind === 'outcome');
		expect(outcomes.map(t => [t.threshold, t.isCredited])).toEqual([
			[2, false],
			[4, true],
		]);
		expect(outcomes[1]!.broken.map(b => [b.setId, b.threshold])).toEqual([
			[659, 4],
			[659, 2],
		]);
		expect(mantle.deltaDps + credit).toBeCloseTo(460, 9);
	});

	it('a set whose only bonus needs 3 pieces is measured and charged', async () => {
		// Scenario kind: a three-piece crafted set (cloth, leather, mail), which
		// a `2 | 4` count type could not hold. Example: Primal Intent 619 worn
		// 3/3, model 3pc 25, with a Thunderheart chest and the neutral chest 8283
		// as candidates.
		const { ranking: r } = await runScenario({
			worn: wornGear(PRIMAL_INTENT),
			pool: [
				{ itemId: THUNDERHEART.chest, slot: 'chest' },
				{ itemId: NEUTRAL.chest[0], slot: 'chest' },
			],
			setBonuses: { ...SET_BONUSES, 619: { b2: 0, b3: 25, b4: 0 } },
			measureSetBonuses: true,
		});
		expect(near(r.baseline.dps, 3025, 0.5)).toBe(true);
		expect(wornSetCountsOf(r, 619)).toEqual([
			[2, 0, false],
			[3, 25, true],
		]);
		expect(near(bsvDps(r, 619, 3)!, 25, 0.5)).toBe(true);
		const chest = thRow(r, THUNDERHEART.chest);
		expect(near(chest.deltaDps, 75, 0.5)).toBe(true);
		expect((chest.setContext?.singleBreaks ?? []).map(brk)).toEqual([{ setId: 619, threshold: 3, dps: 25 }]);
		// The neutral chest pays the same loss inside its own sim: 120 − 25.
		expect(near(thRow(r, NEUTRAL.chest[0]).deltaDps, 95, 0.5)).toBe(true);
	});

	it('a set piece with its own id-keyed effect adds nothing to the charged break', async () => {
		// Scenario kind: a worn set piece that the sim also gives an effect by
		// its item id (hunter and warrior PvP gloves, `RegisterPvPGloveMod`; any
		// `itemEffects[eq.ID]` entry). Example: Gladiator's Pursuit 586 worn as
		// chest 28334 and gloves 28335, model 2pc 40 and a model id effect of 15
		// on the gloves; a Thunderheart chest breaks the 2pc.
		const { ranking: r } = await runScenario({
			worn: wornGear(PURSUIT),
			pool: [
				{ itemId: THUNDERHEART.chest, slot: 'chest' },
				{ itemId: NEUTRAL.chest[0], slot: 'chest' },
			],
			setBonuses: { ...SET_BONUSES, 586: { b2: 40, b4: 0 } },
			idEffects: new Map([[PURSUIT.hands, 15]]),
			measureSetBonuses: true,
		});
		expect(near(r.baseline.dps, 3055, 0.5)).toBe(true);
		// The gloves are the second piece in slot order, so the ladder changes
		// their set membership; they are a copy in both rungs, so the 15 is in
		// neither. A rung with the real gloves would read 55.
		expect(wornSetCountsOf(r, 586)).toEqual([[2, 40, true]]);
		expect(near(bsvDps(r, 586, 2)!, 40, 0.5)).toBe(true);
		const chest = thRow(r, THUNDERHEART.chest);
		expect(near(chest.deltaDps, 60, 0.5)).toBe(true);
		expect((chest.setContext?.singleBreaks ?? []).map(brk)).toEqual([{ setId: 586, threshold: 2, dps: 40 }]);
	});

	it('a set with bonuses above 4 pieces is measured at every worn count', async () => {
		// Scenario kind: a set with bonuses at 6 or 8 pieces, which a count type
		// or a ladder that stops at 4 would drop. Example: Cryptstalker 530 worn
		// 8/8, model 2pc 10, 4pc 20, 6pc 30, 8pc 40, with Thunderheart shoulder,
		// chest, hands and legs as candidates. (Not the head: its meta socket
		// cannot be activated over this gemless gear, so the engine drops it.)
		const candidates = [THUNDERHEART.shoulder, THUNDERHEART.chest, THUNDERHEART.hands, THUNDERHEART.legs];
		const { ranking: r } = await runScenario({
			worn: wornGear(CRYPTSTALKER),
			pool: [
				{ itemId: THUNDERHEART.shoulder, slot: 'shoulder' },
				{ itemId: THUNDERHEART.chest, slot: 'chest' },
				{ itemId: THUNDERHEART.hands, slot: 'hands' },
				{ itemId: THUNDERHEART.legs, slot: 'legs' },
			],
			setBonuses: {
				...SET_BONUSES,
				530: { b2: 10, b4: 20, b6: 30, b8: 40 },
			},
			measureSetBonuses: true,
		});
		expect(near(r.baseline.dps, 3100, 0.5)).toBe(true);
		expect(wornSetCountsOf(r, 530)).toEqual([
			[2, 10, true],
			[3, 0, false],
			[4, 20, true],
			[5, 0, false],
			[6, 30, true],
			[7, 0, false],
			[8, 40, true],
		]);
		// Each single takes the set 8 -> 7 and is charged the 8pc only.
		for (const id of candidates) {
			const row = thRow(r, id);
			expect(near(row.deltaDps, 60, 0.5)).toBe(true);
			expect((row.setContext?.singleBreaks ?? []).map(brk)).toEqual([{ setId: 530, threshold: 8, dps: 40 }]);
		}
		// The 2pc package takes it 8 -> 6 (the 8pc); the 4pc package 8 -> 4 (the
		// 8pc and the 6pc, nothing for 7 and 5).
		expect(pkgBreaks(r, 676, 2)).toEqual([[530, 8]]);
		expect(pkgBreaks(r, 676, 4)).toEqual([
			[530, 8],
			[530, 6],
		]);
		expect(near(netOf(r, 676, 2)!, 50, 0.5)).toBe(true);
		expect(near(netOf(r, 676, 4)!, 80, 0.5)).toBe(true);
	});
});
