/**
 * Set values the run could not measure: the worn-1 4pc with no usable pair, and failed ladder
 * rungs with no bonus list to fall back on, on the model sim of `testing/set_bonus_scenario.ts`.
 * Every literal is derived by hand from that model.
 */

import { describe, expect, it, vi } from 'vitest';

import {
	bonusOf,
	bsvDps,
	COPY_OFFSET,
	FLOOR,
	MALORNE,
	MALORNE_4,
	near,
	NEUTRAL,
	runScenario,
	type Scenario,
	type ScenarioRanking,
	SET_KEPT_OFFSET,
	setSkipLines,
	thRow,
	THUNDERHEART,
	wornGear,
	wornSetFailedLine,
} from '../testing/set_bonus_scenario';
import { rankableSetPotential, setBonusSubLine } from './engine/set-potential';

// The engine reads items and gems through `Database.getSync()`; the real class over the test database stands in for the page's.
vi.mock('@sim/proto/database', importOriginal => import('../testing/database_mock').then(m => m.withTestDatabase(importOriginal)));

// Every feral run reads hit, so each meta repair searches with the hit term, and several
// cases run 15-27 s alone, near the default timeout.
vi.setConfig({ testTimeout: 120_000 });

/** Worn Malorne 4 over a Thunderheart pool, with the ladder rung R(3) failing: counts 3 and 4 go unmeasured. */
const rungThreeFails: Scenario = {
	worn: wornGear(MALORNE_4),
	pool: [
		{ itemId: THUNDERHEART.head, slot: 'head' },
		{ itemId: THUNDERHEART.shoulder, slot: 'shoulder' },
		{ itemId: THUNDERHEART.chest, slot: 'chest' },
		{ itemId: THUNDERHEART.hands, slot: 'hands' },
		{ itemId: NEUTRAL.chest[0], slot: 'chest' },
		{ itemId: NEUTRAL.hands[0], slot: 'hands' },
	],
	measureSetBonuses: true,
	reportsSetBonuses: true,
	failWhen: ids => ids.includes(SET_KEPT_OFFSET + MALORNE.chest) && ids.includes(COPY_OFFSET + MALORNE.hands),
};

/** Every Malorne count a row or the run lists as broken. */
const malorneBreakCounts = (r: ScenarioRanking): number[] => {
	const counts = new Set<number>();
	for (const b of r.brokenSetValues ?? []) {
		if (b.setId === 640) counts.add(b.threshold);
	}
	for (const row of r.items) {
		const ctx = row.setContext;
		for (const b of [...(ctx?.singleBreaks ?? []), ...(ctx?.commitBreaks ?? []), ...(ctx?.futureBonuses ?? []).flatMap(f => f.breaks ?? [])]) {
			if (b.setId === 640) counts.add(b.threshold);
		}
	}
	return [...counts].sort((a, b) => a - b);
};

describe('unmeasured set values', () => {
	it('with no break-free pair the worn-1 4pc net stays unset; the bonus-gear rule credits the rows from their bonus gear', async () => {
		const { ranking: r } = await runScenario({
			worn: wornGear({
				hands: THUNDERHEART.hands,
				head: MALORNE.head,
				chest: MALORNE.chest,
			}),
			pool: [
				{ itemId: THUNDERHEART.head, slot: 'head' },
				{ itemId: THUNDERHEART.chest, slot: 'chest' },
				{ itemId: THUNDERHEART.legs, slot: 'legs' },
				{ itemId: NEUTRAL.head[0], slot: 'head' },
				{ itemId: NEUTRAL.chest[0], slot: 'chest' },
			],
			measureSetBonuses: true,
		});
		expect(near(r.baseline.dps, 3140, 0.5)).toBe(true);
		const th4 = bonusOf(r, 676, 4);
		// Head and chest each break Malorne 2pc alone, so only legs is
		// break-free and no pair sim runs. The raw value keeps its confound.
		expect(th4!.selfConfound).toEqual({ threshold: 2 });
		expect(near(th4!.bonusDps!, 20, 0.5)).toBe(true);
		expect(near(bsvDps(r, 640, 2)!, 40, 0.5)).toBe(true);
		// The confounded net would be 20 − (2 − 0 − 1 + 0)·40 = −20; true is 80.
		expect(th4!.bonusDpsNet).toBeUndefined();
		// A bonus-gear ranking reads no `bonusDpsNet`. The 4pc's check cleared, so
		// each row is credited from the sim of its credited gear, the worn TH
		// hands plus head, chest and legs: 3530 − 3140 = 390. The head and chest
		// rows break the Malorne 2pc alone: d = 100 + 50 − 40 = 110.
		for (const [id, d, credit] of [
			[THUNDERHEART.head, 110, 280],
			[THUNDERHEART.chest, 110, 280],
			[THUNDERHEART.legs, 150, 240],
		] as const) {
			const row = thRow(r, id);
			const future = row.setContext?.futureBonuses ?? [];
			expect(future.map(f => [f.threshold, f.belowNoise ?? false])).toEqual([
				[3, true],
				[4, false],
			]);
			expect(future[1]!.dps).toBeUndefined();
			expect(future[1]!.bonusGearDps).toBeCloseTo(390, 9);
			expect(row.deltaDps).toBeCloseTo(d, 9);
			expect(rankableSetPotential(row, FLOOR)).toBeCloseTo(credit, 9);
			expect(setBonusSubLine(row.setContext, true)).toBe('hover_hint');
		}
	});

	it('when the bonus list cannot be read either, no failed count is a break, and lines give both errors', async () => {
		// With no list, a failed count may hold no bonus, so the row claims no
		// break it did not measure; the ladder's line and the read's line say
		// what was not measured.
		const { ranking: r } = await runScenario({
			...rungThreeFails,
			failSetBonusReadWhen: () => true,
		});
		expect((r.wornSetLadder ?? []).filter(e => e.setId === 640).map(e => [e.count, e.counted])).toEqual([
			[2, true],
			[3, false],
			[4, false],
		]);
		expect(malorneBreakCounts(r)).toEqual([2]);
		expect(setSkipLines(r)).toContainEqual(wornSetFailedLine);
		expect(setSkipLines(r)).toContainEqual({
			field: 'Malorne Harness set',
			detail: "The Malorne Harness set bonuses were not all measured, because the sim could not list the set's bonuses.",
			error: 'the set-bonus read failed on purpose',
		});
	});
});
