/**
 * Every lost set threshold: the measured broken-bonus value of a worn set a package breaks, the
 * commit-break disclosure and the owned-row guard, on the model sim of
 * `testing/set_bonus_scenario.ts`. Every literal is derived by hand from that model.
 */

import { describe, expect, it, vi } from 'vitest';

import {
	B4_TH,
	brk,
	bsvDps,
	expectNear,
	FLOOR,
	fut,
	ITEM_VALUE,
	MALORNE,
	NEUTRAL,
	NEUTRAL_HANDS_LEGS,
	runOffOn,
	runScenario,
	setPool,
	TH_HANDS_LEGS,
	thRow,
	THUNDERHEART,
	withSetValues,
	wornGear,
} from '../testing/set_bonus_scenario';
import { rankableSetPotential } from './engine/set-potential';

// The engine reads items and gems through `Database.getSync()`; the real class over the test database stands in for the page's.
vi.mock('@sim/proto/database', importOriginal => import('../testing/database_mock').then(m => m.withTestDatabase(importOriginal)));

describe('every lost set threshold', () => {
	it("the legs row's substituted package breaks Malorne 2pc — measured, net shown", async () => {
		// Malorne chest, hands, legs worn (2pc active). Thunderheart wrist,
		// waist, feet at 150 let the 4pc package avoid all but one Malorne slot, so
		// only the legs row's substituted package breaks the 2pc.
		const itemValue = new Map(ITEM_VALUE);
		for (const id of [THUNDERHEART.wrist, THUNDERHEART.waist, THUNDERHEART.feet]) itemValue.set(id, 150);
		const { off, on } = await runOffOn({
			worn: wornGear({
				chest: MALORNE.chest,
				hands: MALORNE.hands,
				legs: MALORNE.legs,
			}),
			pool: [
				{ itemId: THUNDERHEART.wrist, slot: 'wrist' },
				{ itemId: THUNDERHEART.waist, slot: 'waist' },
				{ itemId: THUNDERHEART.feet, slot: 'feet' },
				{ itemId: THUNDERHEART.hands, slot: 'hands' },
				{ itemId: THUNDERHEART.legs, slot: 'legs' },
				{ itemId: NEUTRAL.chest[0], slot: 'chest' },
				{ itemId: NEUTRAL.hands[0], slot: 'hands' },
			],
			itemValue,
		});
		const r = on.ranking;
		const legs = thRow(r, THUNDERHEART.legs);
		expectNear(legs.deltaDps, 100, 0.5);
		expect(legs.setContext?.singleBreaks ?? []).toEqual([]);
		expect((legs.setContext?.futureBonuses ?? []).map(fut)).toEqual([
			{ threshold: 2, piecesNeeded: 2, dps: 50 },
			{ threshold: 3, piecesNeeded: 3, dps: undefined },
			{ threshold: 4, piecesNeeded: 4, dps: 80 },
			{ threshold: 5, piecesNeeded: 5, dps: undefined },
		]);
		// The top package with legs substituted breaks Malorne 2pc, so it is a
		// measurement target and disclosed. The legs row's own path to each future
		// (legs plus the best remaining package pieces) keeps Malorne chest and
		// hands, so it breaks nothing. The path pieces' own stats count too:
		// 50 + 150 (wrist), then + 80 + 150 + 150 = 580.
		expectNear(bsvDps(r, 640, 2)!, 40, 0.5);
		expect((legs.setContext?.commitBreaks ?? []).map(brk)).toEqual([{ setId: 640, threshold: 2, dps: 40 }]);
		for (const f of legs.setContext?.futureBonuses ?? []) {
			expect(f.breaks ?? []).toEqual([]);
		}
		expectNear(rankableSetPotential(legs, FLOOR), 580, 0.5);
		// The ladder sims one rung per worn Malorne piece (3), however many rows
		// share a break; (640,3) reads 0 and is not counted, so one B is kept.
		// The others are the checks of counts 2 to 5 (8) and the nine bonus gears
		// no package covers, the close calls' included.
		const measured = (r.brokenSetValues ?? []).filter(b => b.dps !== undefined).length;
		expect(on.runCount - off.runCount).toBe(3 + 8 + 9);
		expect(measured).toBe(1);
		// The package's own members break nothing. Each shows the package delta
		// 680: wrist, waist and feet 150 + 530, hands 100 + 580.
		for (const [id, credit] of [
			[THUNDERHEART.wrist, 530],
			[THUNDERHEART.waist, 530],
			[THUNDERHEART.feet, 530],
			[THUNDERHEART.hands, 580],
		] as const) {
			const row = thRow(r, id);
			expect(row.setContext?.commitBreaks ?? []).toEqual([]);
			expectNear(rankableSetPotential(row, FLOOR), credit, 0.5);
		}
	});

	it("an owned row's swap adds no piece, so it gets no future credit", async () => {
		// Thunderheart hands + legs worn; the pool holds the worn hands (owned).
		const { ranking: r } = await runScenario({
			worn: wornGear({ hands: THUNDERHEART.hands, legs: THUNDERHEART.legs }),
			pool: [
				{ itemId: THUNDERHEART.hands, slot: 'hands' },
				{ itemId: THUNDERHEART.head, slot: 'head' },
				{ itemId: THUNDERHEART.shoulder, slot: 'shoulder' },
				{ itemId: THUNDERHEART.chest, slot: 'chest' },
			],
			measureSetBonuses: true,
		});
		// At worn 2 the 2pc package loop skips threshold 2 before pushing anything.
		expect((r.setBonuses ?? []).filter(b => b.setId === 676 && b.threshold === 2)).toEqual([]);
		const owned = thRow(r, THUNDERHEART.hands);
		expect(owned.owned).toBe(true);
		expect(owned.setContext?.piecesWornBefore).toBe(2);
		expect(owned.setContext?.piecesAfterSwap).toBe(2);
		expect(owned.setContext?.futureBonuses).toBeUndefined();
		expect(rankableSetPotential(owned, FLOOR)).toBe(0);
		const head = thRow(r, THUNDERHEART.head);
		expect((head.setContext?.futureBonuses ?? []).map(fut)).toEqual([
			{ threshold: 4, piecesNeeded: 2, dps: 80 },
			{ threshold: 5, piecesNeeded: 3, dps: undefined },
		]);
		// 80 + the chest's own 100.
		expectNear(rankableSetPotential(head, FLOOR), 180, 0.5);
	});
});

describe('two-sim set values use the item bar', () => {
	it('a worn-set ladder rung worth 3.5, se 0.5, is counted and charged', async () => {
		// Scenario kind: the player wears a 2pc worth 3.5 DPS. The rung is one
		// sim minus another; at 7200 iterations each sim's se is 30 / √7200, so
		// the rung's se is exactly 0.5 and 2·se is 1.
		const { ranking: r } = await runScenario({
			worn: TH_HANDS_LEGS,
			pool: [...setPool(MALORNE), ...NEUTRAL_HANDS_LEGS],
			itemValue: withSetValues(Object.values(MALORNE)),
			setBonuses: { 676: { b2: 3.5, b4: B4_TH }, 640: { b2: 40, b4: 30 } },
			iterations: 7200,
			measureSetBonuses: true,
		});
		const th2 = (r.wornSetLadder ?? []).find(e => e.setId === 676 && e.count === 2);
		expect(th2?.dps).toBeCloseTo(3.5, 9);
		expect(th2?.se).toBeCloseTo(0.5, 9);
		expect(th2?.counted).toBe(true);
		expect(bsvDps(r, 676, 2)).toBeCloseTo(3.5, 9);
	});
});
