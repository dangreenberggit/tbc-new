/**
 * The same-gear check: a bonus measured as the gear with one set piece swapped for a set-kept
 * copy against a set-less copy, on the model sim of `testing/set_bonus_scenario.ts`. Every literal
 * is derived by hand from that model.
 */

import { describe, expect, it, vi } from 'vitest';

import {
	bonusOf,
	COPY_OFFSET,
	HANDS_SLOT,
	LEGS_SLOT,
	type PoolSpec,
	runScenario,
	SET_KEPT_OFFSET,
	sortedIds,
	thRow,
	THUNDERHEART,
	wornGear,
} from '../testing/set_bonus_scenario';

// The engine reads items and gems through `Database.getSync()`; the real class over the test database stands in for the page's.
vi.mock('@sim/proto/database', importOriginal => import('../testing/database_mock').then(m => m.withTestDatabase(importOriginal)));

const TH_HANDS_LEGS_POOL: PoolSpec[] = [
	{ itemId: THUNDERHEART.hands, slot: 'hands' },
	{ itemId: THUNDERHEART.legs, slot: 'legs' },
];

describe('the same-gear check', () => {
	it('the 2pc same-gear bonus is the bonus alone, for two new sims', async () => {
		const off = await runScenario({
			worn: wornGear({}),
			pool: TH_HANDS_LEGS_POOL,
		});
		const on = await runScenario({
			worn: wornGear({}),
			pool: TH_HANDS_LEGS_POOL,
			measureSetBonuses: true,
		});
		// Only the 2pc package is measured (two pieces cannot reach the 4pc),
		// and nothing worn is broken, so the flag adds the check's two sims and
		// nothing else.
		expect(on.runCount - off.runCount).toBe(2);
		const copyCalls = on.calls.filter(ids => ids.some(id => id >= COPY_OFFSET));
		expect(copyCalls).toHaveLength(2);
		// The first set piece in slot order, the hands, is the copy, in both
		// requests: set kept in the "on" sim, set-less in the "off" sim.
		expect(copyCalls.map(ids => ids[HANDS_SLOT])).toEqual([SET_KEPT_OFFSET + THUNDERHEART.hands, COPY_OFFSET + THUNDERHEART.hands]);
		for (const ids of copyCalls) {
			expect(ids[LEGS_SLOT]).toBe(THUNDERHEART.legs);
		}
		// The package request is simmed once.
		const packageCalls = on.calls.filter(ids => ids[HANDS_SLOT] === THUNDERHEART.hands && ids[LEGS_SLOT] === THUNDERHEART.legs);
		expect(packageCalls).toHaveLength(1);

		// on 3000 + 200 + 50 (the set-kept copy counts toward the set), off
		// 3000 + 200: 50. se = √2 · 30 / √5000 = 0.6.
		const b2 = bonusOf(on.ranking, 676, 2);
		expect(b2?.sameGearDps).toBeCloseTo(50, 9);
		expect(b2?.sameGearSe).toBeCloseTo(0.6, 9);
		expect(bonusOf(on.ranking, 676, 4)?.sameGearDps).toBeUndefined();
		// Copied onto the futures of that entry, and only those.
		const futures = thRow(on.ranking, THUNDERHEART.hands).setContext?.futureBonuses ?? [];
		const f2 = futures.find(f => f.threshold === 2);
		expect(f2?.sameGearDps).toBeCloseTo(50, 9);
		expect(f2?.sameGearSe).toBeCloseTo(0.6, 9);
		expect(futures.find(f => f.threshold === 4)?.sameGearDps).toBeUndefined();
		// Without the flag there is no check.
		expect(bonusOf(off.ranking, 676, 2)?.sameGearDps).toBeUndefined();
	});

	it('the check leaves out stats worth more together; package minus singles keeps them', async () => {
		const { ranking } = await runScenario({
			worn: wornGear({}),
			pool: TH_HANDS_LEGS_POOL,
			measureSetBonuses: true,
			interactions: [{ ids: [THUNDERHEART.hands, THUNDERHEART.legs], dps: 9 }],
		});
		const b2 = bonusOf(ranking, 676, 2);
		// Package 3000 + 200 + 50 + 9, singles +100 each: 259 − 200 = 59.
		expect(b2?.bonusDps).toBeCloseTo(59, 9);
		// Both copies keep the term: 3259 − (3000 + 200 + 9) = 50.
		expect(b2?.sameGearDps).toBeCloseTo(50, 9);
	});

	it('a set piece with an id-keyed effect changes no same-gear bonus', async () => {
		// Scenario kind: a set package in which a piece with a Go effect keyed
		// by its item id (hunter and warrior PvP gloves, `RegisterPvPGloveMod`;
		// any `itemEffects[eq.ID]` entry) is among the pieces the check changes.
		// The example is a druid set piece given a model id effect:
		// Thunderheart Gauntlets 31034, effect 15, Thunderheart 2pc 50. The
		// set-breaks tests cover the PvP gloves on the break side.
		const scenario = (pool: PoolSpec[]) =>
			runScenario({
				worn: wornGear({}),
				pool,
				measureSetBonuses: true,
				idEffects: new Map([[THUNDERHEART.hands, 15]]),
			});
		// (i) chest and gloves: the gloves are last in slot order.
		const first = await scenario([
			{ itemId: THUNDERHEART.chest, slot: 'chest' },
			{ itemId: THUNDERHEART.hands, slot: 'hands' },
		]);
		// (ii) gloves and legs: the gloves are first in slot order, so they are
		// the piece the check copies. Copied on one side only they would add 15.
		const second = await scenario([
			{ itemId: THUNDERHEART.hands, slot: 'hands' },
			{ itemId: THUNDERHEART.legs, slot: 'legs' },
		]);
		expect(sortedIds(bonusOf(first.ranking, 676, 2)?.packageItemIds)).toEqual([THUNDERHEART.hands, THUNDERHEART.chest]);
		expect(sortedIds(bonusOf(second.ranking, 676, 2)?.packageItemIds)).toEqual([THUNDERHEART.hands, THUNDERHEART.legs]);
		for (const { ranking } of [first, second]) {
			expect(bonusOf(ranking, 676, 2)?.sameGearDps).toBeCloseTo(50, 9);
		}
	});
});
