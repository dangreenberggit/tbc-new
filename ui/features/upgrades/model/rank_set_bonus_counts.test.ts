/**
 * Counts a set has no bonus at: the gain side tries only the counts the sim lists for a set.
 * Thunderheart Harness 676 has bonuses at 2 and 4 only (sim/druid/item_sets.go), as the model
 * sim of `testing/set_bonus_scenario.ts` has it.
 */

import { describe, expect, it, vi } from 'vitest';

import { bonusOf, MALORNE, runScenario, type Scenario, type ScenarioRanking, setSkipLines, thRow, THUNDERHEART, wornGear } from '../testing/set_bonus_scenario';

// The engine reads items and gems through `Database.getSync()`; the real class over the test database stands in for the page's.
vi.mock('@sim/proto/database', importOriginal => import('../testing/database_mock').then(m => m.withTestDatabase(importOriginal)));

// Every feral run reads hit, so each meta repair searches with the hit term, and several
// cases run 15-27 s alone, near the default timeout.
vi.setConfig({ testTimeout: 120_000 });

const countsOf = (ranking: ScenarioRanking, setId: number) => (ranking.setBonuses ?? []).filter(b => b.setId === setId).map(b => b.threshold);
const crossingCountsOf = (ranking: ScenarioRanking, setId: number) => (ranking.crossingChecks ?? []).filter(g => g.setId === setId).map(g => g.count);
const futureCountsOf = (ranking: ScenarioRanking, setId: number) =>
	ranking.items.filter(r => r.setContext?.setId === setId).flatMap(r => (r.setContext?.futureBonuses ?? []).map(f => f.threshold));

describe('counts a set has no bonus at', () => {
	it('the gain side tries only the counts the sim lists for the set', async () => {
		// Scenario kind: a worn set whose pool reaches past its last bonus.
		// Example: Thunderheart worn at 2 (head, shoulder) with four more
		// pieces in the pool, so the pool reaches 6.
		const scenario: Scenario = {
			worn: wornGear({
				head: THUNDERHEART.head,
				shoulder: THUNDERHEART.shoulder,
			}),
			pool: [
				{ itemId: THUNDERHEART.chest, slot: 'chest' },
				{ itemId: THUNDERHEART.hands, slot: 'hands' },
				{ itemId: THUNDERHEART.legs, slot: 'legs' },
				{ itemId: THUNDERHEART.wrist, slot: 'wrist' },
			],
			measureSetBonuses: true,
		};
		const unread = await runScenario(scenario);
		const read = await runScenario({ ...scenario, reportsSetBonuses: true });
		// Without the sim's list, every count up to the reach is tried.
		expect(countsOf(unread.ranking, 676)).toEqual([3, 4, 5, 6]);
		expect(crossingCountsOf(unread.ranking, 676)).toEqual([3]);
		// With it, only the 4pc.
		expect(countsOf(read.ranking, 676)).toEqual([4]);
		expect(crossingCountsOf(read.ranking, 676)).toEqual([]);
		expect(new Set(futureCountsOf(read.ranking, 676))).toEqual(new Set([4]));
		// The 4pc itself is measured as before.
		expect(bonusOf(read.ranking, 676, 4)).toEqual(bonusOf(unread.ranking, 676, 4));
	});

	it('a set with every bonus worn gets no entry, and its rows keep their set detail', async () => {
		// Scenario kind: Thunderheart worn at 4 with more pieces in the pool, the
		// shape of a feral P5 player wearing the 4pc. Before the fix the ranking
		// listed a Thunderheart entry at 5.
		const scenario: Scenario = {
			worn: wornGear({
				head: THUNDERHEART.head,
				shoulder: THUNDERHEART.shoulder,
				chest: THUNDERHEART.chest,
				hands: THUNDERHEART.hands,
			}),
			pool: [
				{ itemId: THUNDERHEART.legs, slot: 'legs' },
				{ itemId: THUNDERHEART.wrist, slot: 'wrist' },
				{ itemId: THUNDERHEART.waist, slot: 'waist' },
			],
			measureSetBonuses: true,
			reportsSetBonuses: true,
		};
		const { ranking } = await runScenario(scenario);
		expect(countsOf(ranking, 676)).toEqual([]);
		expect(crossingCountsOf(ranking, 676)).toEqual([]);
		for (const id of [THUNDERHEART.legs, THUNDERHEART.wrist, THUNDERHEART.waist]) {
			const row = thRow(ranking, id);
			expect(row.setContext?.setId).toBe(676);
			expect(row.setContext?.piecesWornBefore).toBe(4);
			expect(row.setContext?.futureBonuses ?? []).toEqual([]);
		}
	});

	it('no ranking entry names a count the set lacks, with the set screen on', async () => {
		// Scenario kind: the tab's own settings (screen on), on the gear of the
		// two cases above.
		// Exact lists, so a change that dropped every entry fails here too. Worn
		// at 2, only the 4pc is in reach; worn at 4, no bonus is.
		for (const [worn, counts] of [
			[{ head: THUNDERHEART.head, shoulder: THUNDERHEART.shoulder }, [4]],
			[
				{
					head: THUNDERHEART.head,
					shoulder: THUNDERHEART.shoulder,
					chest: THUNDERHEART.chest,
					hands: THUNDERHEART.hands,
				},
				[],
			],
		] as const) {
			const { ranking } = await runScenario({
				worn: wornGear(worn),
				pool: [
					{ itemId: THUNDERHEART.legs, slot: 'legs' },
					{ itemId: THUNDERHEART.wrist, slot: 'wrist' },
					{ itemId: THUNDERHEART.waist, slot: 'waist' },
					{ itemId: THUNDERHEART.feet, slot: 'feet' },
				],
				measureSetBonuses: true,
				setScreenMode: 'on',
				reportsSetBonuses: true,
			});
			expect(countsOf(ranking, 676)).toEqual(counts);
			expect(crossingCountsOf(ranking, 676)).toEqual([]);
			expect(new Set(futureCountsOf(ranking, 676))).toEqual(new Set(counts));
		}
	});

	it("a set whose bonus read fails gets no entry and no count tried, and a line gives the read's error", async () => {
		// Scenario kind: the first case's gear (the pool reaches 6), with the read of the
		// largest package's gear failing, or the read of the worn gear.
		const scenario: Scenario = {
			worn: wornGear({
				head: THUNDERHEART.head,
				shoulder: THUNDERHEART.shoulder,
			}),
			pool: [
				{ itemId: THUNDERHEART.chest, slot: 'chest' },
				{ itemId: THUNDERHEART.hands, slot: 'hands' },
				{ itemId: THUNDERHEART.legs, slot: 'legs' },
				{ itemId: THUNDERHEART.wrist, slot: 'wrist' },
			],
			measureSetBonuses: true,
			reportsSetBonuses: true,
		};
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			for (const failSetBonusReadWhen of [(ids: readonly number[]) => ids.includes(THUNDERHEART.wrist), () => true]) {
				warn.mockClear();
				const { ranking } = await runScenario({
					...scenario,
					failSetBonusReadWhen,
				});
				expect(countsOf(ranking, 676)).toEqual([]);
				expect(crossingCountsOf(ranking, 676)).toEqual([]);
				expect(futureCountsOf(ranking, 676)).toEqual([]);
				for (const id of [THUNDERHEART.chest, THUNDERHEART.legs]) {
					expect(thRow(ranking, id).setContext?.setId).toBe(676);
				}
				expect(warn.mock.calls.some(([line]) => String(line).includes('set 676'))).toBe(true);
				// The read's own error reaches the ranking's lines.
				expect(setSkipLines(ranking)).toContainEqual({
					field: 'Thunderheart Harness set',
					detail: "The Thunderheart Harness set bonuses were not all measured, because the sim could not list the set's bonuses.",
					error: 'the set-bonus read failed on purpose',
				});
			}
		} finally {
			warn.mockRestore();
		}
	});

	it("a set whose largest package fails gem repair gets no entry and no count tried, and a line gives the repair's error", async () => {
		// Scenario kind: each piece's single can switch the meta gem on, the
		// package's gear cannot. Example: Malorne Harness 640 over gemless gear.
		// The worn Gloves of Dexterous Manipulation have two sockets, so the
		// Stag-Helm's single has three to recolor for its meta; the package puts
		// the socketless Gauntlets of Malorne in their place and leaves only the
		// helm's own, which is too few.
		const GLOVES_TWO_SOCKETS = 28506;
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const { ranking } = await runScenario({
				worn: wornGear({ hands: GLOVES_TWO_SOCKETS }),
				pool: [
					{ itemId: MALORNE.head, slot: 'head' },
					{ itemId: MALORNE.hands, slot: 'hands' },
				],
				measureSetBonuses: true,
				reportsSetBonuses: true,
			});
			for (const id of [MALORNE.head, MALORNE.hands]) {
				expect(thRow(ranking, id).setContext?.setId).toBe(640);
			}
			expect(countsOf(ranking, 640)).toEqual([]);
			expect(futureCountsOf(ranking, 640)).toEqual([]);
			expect(
				warn.mock.calls.some(([line]) => String(line).includes("set 640: its bonus counts were not read, the added pieces' gem repair failed")),
			).toBe(true);
			// The repair's own error reaches the ranking's lines, after the sentence and
			// not in `error`, which holds only a failed call's error.
			expect(setSkipLines(ranking)).toContainEqual({
				field: 'Malorne Harness set',
				detail: expect.stringMatching(/^The Malorne Harness set bonuses were not all measured, because no gem swap could turn your meta gem on\.\n\S/),
			});
		} finally {
			warn.mockRestore();
		}
	});
});
