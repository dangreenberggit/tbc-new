/**
 * The close-calls partner rule: a row's partner sets whose estimates are close are each simmed,
 * and the better sim wins, on the model sim of `testing/set_bonus_scenario.ts`. Every literal is
 * derived by hand from that model.
 */

import { describe, expect, it, vi } from 'vitest';

import {
	CHEST_SLOT,
	COPY_OFFSET,
	FLOOR,
	futureOf,
	HANDS_SLOT,
	LEGS_SLOT,
	runScenario,
	type Scenario,
	setSkipLines,
	simFailedLine,
	thRow,
	THUNDERHEART,
	withValues,
	wornGear,
} from '../testing/set_bonus_scenario';
import { rankableSetPotential, setCreditUnmeasured } from './engine/set-potential';

// The engine reads items and gems through `Database.getSync()`; the real class over the test database stands in for the page's.
vi.mock('@sim/proto/database', importOriginal => import('../testing/database_mock').then(m => m.withTestDatabase(importOriginal)));

// Every feral run reads hit, so each meta repair searches with the hit term, and several
// cases run 15-27 s alone, near the default timeout.
vi.setConfig({ testTimeout: 120_000 });

// Nothing worn; Thunderheart Chestguard 110, Gauntlets 100, Leggings 100;
// +20 when the Gauntlets and Leggings are worn together. Z's estimate for the
// Gauntlets row's 2pc prefers the Chestguard (210 against 200), but the
// Leggings gear sims higher (270 against 260).
const PC_SCENARIO: Scenario = {
	worn: wornGear({}),
	pool: [
		{ itemId: THUNDERHEART.chest, slot: 'chest' },
		{ itemId: THUNDERHEART.hands, slot: 'hands' },
		{ itemId: THUNDERHEART.legs, slot: 'legs' },
	],
	itemValue: withValues([[THUNDERHEART.chest, 110]]),
	interactions: [{ ids: [THUNDERHEART.hands, THUNDERHEART.legs], dps: 20 }],
	measureSetBonuses: true,
};

describe('the close-calls partner rule', () => {
	it('two partner sets within the margin are both simmed, and the better sim wins', async () => {
		// Scenario kind: a row whose partner sets' estimates are close, while
		// their pieces' stats interact so that the estimate's order is wrong.
		// Example: PC_SCENARIO, the Thunderheart Gauntlets row's 2pc.
		const { ranking: r } = await runScenario(PC_SCENARIO);
		const hands = thRow(r, THUNDERHEART.hands);
		expect(futureOf(hands, 2)?.partnerRule).toBe('close-calls');
		expect(futureOf(hands, 2)?.pieces?.map(p => p.itemId)).toEqual([THUNDERHEART.legs]);
		// model(G + Gauntlets + Leggings) − model(G) = 200 + 50 + 20.
		expect(futureOf(hands, 2)?.bonusGearDps).toBeCloseTo(270, 9);
		expect(rankableSetPotential(hands, FLOOR)).toBeCloseTo(170, 9);
		// The Chestguard row's two sets tie on estimate and on sim (260 each):
		// Z's order, the lower id.
		expect(futureOf(thRow(r, THUNDERHEART.chest), 2)?.pieces?.map(p => p.itemId)).toEqual([THUNDERHEART.hands]);
		// Choices sim chest + hands (the 2pc package, from the store), chest +
		// legs and hands + legs once each, then the two chosen gears come from
		// the store.
		expect(r.bonusGearSims).toEqual({
			partnerRule: 'close-calls',
			gears: 2,
			simmed: 2,
			fromStore: 6,
		});
	});

	it('only a set within 31.87 of the best estimate is simmed', async () => {
		// The margin's edge: Leggings at 79 (estimate 31 below the
		// Chestguard's) or 78 (32 below), +40 with the Gauntlets, so the
		// Leggings gear sims 269 or 268 against the Chestguard's 260.
		const handsPieces = async (legs: number) => {
			const { ranking } = await runScenario({
				...PC_SCENARIO,
				itemValue: withValues([
					[THUNDERHEART.chest, 110],
					[THUNDERHEART.legs, legs],
				]),
				interactions: [{ ids: [THUNDERHEART.hands, THUNDERHEART.legs], dps: 40 }],
			});
			const f = futureOf(thRow(ranking, THUNDERHEART.hands), 2);
			return [f?.pieces?.map(p => p.itemId), f?.bonusGearDps];
		};
		expect(await handsPieces(79)).toEqual([[THUNDERHEART.legs], 269]);
		expect(await handsPieces(78)).toEqual([[THUNDERHEART.chest], 260]);
	});

	it("a candidate whose sim fails is skipped; when every one fails, Z's choice stands", async () => {
		// Real (not copied) Thunderheart pieces worn, in slot order.
		const realTh = (ids: readonly number[]) => [CHEST_SLOT, HANDS_SLOT, LEGS_SLOT].map(slot => ids[slot]!).filter(id => id !== 0 && id < COPY_OFFSET);
		const isGear = (ids: readonly number[], want: readonly number[]) => JSON.stringify(realTh(ids)) === JSON.stringify(want);
		// Only the Gauntlets + Leggings gear fails: the Chestguard wins.
		const one = await runScenario({
			...PC_SCENARIO,
			failWhen: ids => isGear(ids, [THUNDERHEART.hands, THUNDERHEART.legs]),
		});
		const oneHands = thRow(one.ranking, THUNDERHEART.hands);
		expect(futureOf(oneHands, 2)?.pieces?.map(p => p.itemId)).toEqual([THUNDERHEART.chest]);
		expect(futureOf(oneHands, 2)?.bonusGearDps).toBeCloseTo(260, 9);
		// Every row's 2pc is measured on a partner set whose sim worked, so no
		// line says the 2pc went unmeasured. The 3pc's same-gear check sims wear
		// the failing Gauntlets and Leggings with a copied Chestguard, so the 3pc
		// line is true.
		expect(setSkipLines(one.ranking)).toEqual([simFailedLine(3)]);
		// Both of the Gauntlets row's gears fail: the row keeps Z's choice, the
		// Chestguard, whose bonus-gear sim fails again, so the row is unmeasured.
		const both = await runScenario({
			...PC_SCENARIO,
			failWhen: ids => isGear(ids, [THUNDERHEART.hands, THUNDERHEART.legs]) || isGear(ids, [THUNDERHEART.chest, THUNDERHEART.hands]),
		});
		const bothHands = thRow(both.ranking, THUNDERHEART.hands);
		expect(futureOf(bothHands, 2)?.pieces?.map(p => p.itemId)).toEqual([THUNDERHEART.chest]);
		expect(futureOf(bothHands, 2)?.bonusGearDps).toBeUndefined();
		expect(setCreditUnmeasured(bothHands.setContext)).toBe(true);
		// the bonus-gear sims' error reaches the player.
		expect(setSkipLines(both.ranking)).toContainEqual(simFailedLine(2, true));
	});
});
