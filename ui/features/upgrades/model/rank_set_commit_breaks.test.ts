/**
 * Commit breaks per future: breaks charged along each future's own path, one credited bonus
 * chosen on full values, and the worn-1 4pc recovered with one pair sim, on the model sim of
 * `testing/set_bonus_scenario.ts`. Every literal is derived by hand from that model.
 */

import { describe, expect, it, vi } from 'vitest';

import {
	B2_TH,
	B4_TH,
	bonusOf,
	brk,
	bsvDps,
	completeRanking,
	expectNear,
	FLOOR,
	fut,
	futB,
	MALORNE,
	NEUTRAL_HANDS_LEGS,
	NORDRASSIL,
	runMalorneOverThunderheart2pc,
	runScenario,
	SET_BONUSES,
	setPool,
	setSkipLines,
	simFailedLine,
	sortedIds,
	TH_HANDS_LEGS,
	TH_POOL,
	thRow,
	THUNDERHEART,
	withSetValues,
	wornGear,
} from '../testing/set_bonus_scenario';
import { rankableSetPotential, setPotentialCredit } from './engine/set-potential';
import { applyView } from './engine/view';

// The engine reads items and gems through `Database.getSync()`; the real class over the test database stands in for the page's.
vi.mock('@sim/proto/database', importOriginal => import('../testing/database_mock').then(m => m.withTestDatabase(importOriginal)));

/** The worn Thunderheart 2pc, as a row that replaces one of its pieces breaks it. */
const TH2_BREAK = { setId: 676, threshold: 2, dps: 50 };

describe('commit breaks per future', () => {
	it('a Malorne head/shoulder/chest row is not charged the Thunderheart 2pc its 2pc does not need', async () => {
		const { off, on } = await runMalorneOverThunderheart2pc({
			676: { b2: B2_TH, b4: B4_TH },
			640: { b2: 40, b4: 0 },
		});
		const r = on.ranking;
		expectNear(r.baseline.dps, 3250, 0.5);
		expectNear(bsvDps(r, 676, 2)!, 50, 0.5);
		// Two ladder rungs (Thunderheart worn 2), two check sims for each of the
		// Malorne counts 2 to 5 (8), eight bonus gears no package covers (the
		// close calls' included), and one package sim fewer: the 4pc, worth
		// 0 here, is within the noise.
		expect(on.runCount - off.runCount).toBe(2 + 8 + 8 - 1);
		expect(sortedIds(bonusOf(r, 640, 2)?.packageItemIds)).toEqual([29096, 29098]);
		expect(sortedIds(bonusOf(r, 640, 4)?.packageItemIds)).toEqual([29096, 29097, 29098, 29100]);
		for (const id of [MALORNE.chest, MALORNE.head, MALORNE.shoulder]) {
			const row = thRow(r, id);
			expectNear(row.deltaDps, 100, 0.5);
			expect(row.setContext?.singleBreaks ?? []).toEqual([]);
			// The Malorne 4pc is worth 0 here, so it is within the noise, has no
			// package and no path, and the top measured package is the 2pc, which
			// breaks nothing.
			expect((row.setContext?.futureBonuses ?? []).map(futB)).toEqual([
				{ threshold: 2, piecesNeeded: 2, dps: 40, breaks: [] },
				{ threshold: 3, piecesNeeded: 3, dps: undefined, breaks: [] },
				{ threshold: 4, piecesNeeded: 4, dps: undefined, breaks: [] },
				{ threshold: 5, piecesNeeded: 5, dps: undefined, breaks: [] },
			]);
			expect(row.setContext?.commitBreaks ?? []).toEqual([]);
			// 40 + the 2pc partner's own 100; the 4pc floors to 0.
			expectNear(rankableSetPotential(row, FLOOR), 140, 0.5);
		}
		for (const id of [MALORNE.hands, MALORNE.legs]) {
			const row = thRow(r, id);
			expectNear(row.deltaDps, -50, 0.5);
			expect((row.setContext?.singleBreaks ?? []).map(brk)).toEqual([TH2_BREAK]);
			// A bonus-gear future names every worn bonus its bonus gear loses, so the
			// 2pc names the row's own Thunderheart 2pc break; the rest are below
			// the check.
			expect((row.setContext?.futureBonuses ?? []).map(f => [f.threshold, (f.breaks ?? []).map(brk)])).toEqual([
				[2, [TH2_BREAK]],
				[3, []],
				[4, []],
				[5, []],
			]);
			// 40 + the chest's own 100.
			expectNear(rankableSetPotential(row, FLOOR), 140, 0.5);
		}
		const top3 = applyView(completeRanking(r), { withSetPotential: true })
			.rows.slice(0, 3)
			.map(row => row.itemId);
		expect(sortedIds(top3)).toEqual([29096, 29098, 29100]);
	});

	it('a real 4pc worth less than the break it needs', async () => {
		const { on } = await runMalorneOverThunderheart2pc({
			676: { b2: B2_TH, b4: B4_TH },
			640: { b2: 40, b4: 30 },
		});
		const chest = thRow(on.ranking, MALORNE.chest);
		expect((chest.setContext?.futureBonuses ?? []).map(futB)).toEqual([
			{ threshold: 2, piecesNeeded: 2, dps: 40, breaks: [] },
			{ threshold: 3, piecesNeeded: 3, dps: undefined, breaks: [] },
			{ threshold: 4, piecesNeeded: 4, dps: 30, breaks: [TH2_BREAK] },
			{ threshold: 5, piecesNeeded: 5, dps: undefined, breaks: [] },
		]);
		// The path pieces' own stats count: R_2 = 40 + 100,
		// R_4 = 140 + 30 + 100 + 0 − 50 = 220, so the 4pc is credited.
		const ctx = chest.setContext;
		expectNear(setPotentialCredit(ctx, FLOOR), 220, 0.5);
		expectNear(rankableSetPotential(chest, FLOOR), 220, 0.5);
	});

	it('a Nordrassil row whose only bonus needs the Thunderheart 2pc break gets ON = OFF', async () => {
		const { ranking: r } = await runScenario({
			worn: TH_HANDS_LEGS,
			pool: [...setPool(NORDRASSIL), ...NEUTRAL_HANDS_LEGS],
			itemValue: withSetValues(Object.values(NORDRASSIL)),
			measureSetBonuses: true,
		});
		for (const id of [NORDRASSIL.chest, NORDRASSIL.head, NORDRASSIL.shoulder]) {
			const row = thRow(r, id);
			expectNear(row.deltaDps, 100, 0.5);
			// The model gives Nordrassil no bonus, so every count it can reach
			// is within the noise: no package, no path, no top package.
			expect((row.setContext?.futureBonuses ?? []).map(futB)).toEqual([
				{ threshold: 2, piecesNeeded: 2, dps: undefined, breaks: [] },
				{ threshold: 3, piecesNeeded: 3, dps: undefined, breaks: [] },
				{ threshold: 4, piecesNeeded: 4, dps: undefined, breaks: [] },
				{ threshold: 5, piecesNeeded: 5, dps: undefined, breaks: [] },
			]);
			expect(row.setContext!.commitPackageDeltaDps).toBeUndefined();
			expect(rankableSetPotential(row, FLOOR)).toBe(0);
		}
	});

	it("a failed worn-1 pair sim leaves the 4pc net unset and shows the sim's error", async () => {
		// The next case's gear. The pair sim is the one request with exactly
		// three real Thunderheart pieces: the worn hands and the pair.
		const thIds: readonly number[] = Object.values(THUNDERHEART);
		const { ranking: r } = await runScenario({
			worn: wornGear({ hands: THUNDERHEART.hands }),
			pool: TH_POOL.filter(p => p.slot !== 'hands'),
			failWhen: ids => ids.filter(id => thIds.includes(id)).length === 3,
		});
		const th4 = bonusOf(r, 676, 4);
		expect(th4!.selfConfound).toEqual({ threshold: 2 });
		expect(th4!.bonusDpsNet).toBeUndefined();
		expect(setSkipLines(r)).toEqual([simFailedLine(2)]);
	});

	it('at worn 1 the 4pc value is recovered with one pair sim', async () => {
		// The run count without the pair sim, recorded from a run before it was added.
		const RUNS_WITHOUT_PAIR_SIM = 6;
		const { ranking: r, runCount } = await runScenario({
			worn: wornGear({ hands: THUNDERHEART.hands }),
			pool: TH_POOL.filter(p => p.slot !== 'hands'),
		});
		expectNear(r.baseline.dps, 3100, 0.5);
		const th4 = bonusOf(r, 676, 4);
		// raw4 = B4 − (n−1)·B2 = 80 − 2·50 = −20; the pair sim recovers B2 = 50.
		expectNear(th4!.bonusDps!, 80, 0.5);
		expectNear(th4!.bonusDpsNet!, 80, 0.5);
		expect(th4!.selfConfound?.threshold).toBe(2);
		expectNear(th4!.selfConfound?.dps ?? NaN, 50, 0.5);
		const head = thRow(r, THUNDERHEART.head);
		expectNear(head.deltaDps, 150, 0.5);
		expect(head.setContext?.crossesThreshold).toBe(true);
		expect((head.setContext?.futureBonuses ?? []).map(fut)).toEqual([{ threshold: 4, piecesNeeded: 3, dps: 80 }]);
		// 80 + chest and legs, each 150 − 50 = 100 of own stats.
		expectNear(rankableSetPotential(head, FLOOR), 280, 0.5);
		expect(runCount).toBe(RUNS_WITHOUT_PAIR_SIM + 1);
	});

	it('at worn 1 the pair sim recovers the 4pc value whichever piece is worn and whatever the 2pc is worth', async () => {
		const { ranking: r } = await runScenario({
			worn: wornGear({ legs: THUNDERHEART.legs }),
			pool: TH_POOL.filter(p => p.slot !== 'legs'),
			setBonuses: { ...SET_BONUSES, 676: { b2: 30, b4: 90 } },
		});
		const th4 = bonusOf(r, 676, 4);
		// raw4 = B4 − (n−1)·B2 = 90 − 2·30 = 30; adding the pair's 2pc back for each of the
		// two pieces after the first gives 90.
		expectNear(th4!.bonusDps!, 90, 0.5);
		expectNear(th4!.selfConfound?.dps ?? NaN, 30, 0.5);
	});
});
