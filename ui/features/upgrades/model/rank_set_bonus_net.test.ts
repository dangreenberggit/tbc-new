/**
 * Set-bonus net value: what a set bonus is worth after the worn sets it breaks, on the model
 * sim of `testing/set_bonus_scenario.ts`.
 *
 * Because that model is exact, the corrected `bonusDpsNet`, the measured broken-bonus value B
 * (`brokenSetValues`) and the set-potential credit are asserted against literals derived
 * from the model by hand, not recomputed the way the code does. The seam is the module
 * interface `rankUpgrades`, plus `rankableSetPotential` on its rows.
 */

import { describe, expect, it, vi } from 'vitest';

import {
	B2_MAL,
	B2_TH,
	B4_TH,
	brk,
	expectNear,
	FLOOR,
	MALORNE,
	near,
	NEUTRAL,
	runScenario,
	TH_POOL,
	thRow,
	THUNDERHEART,
	wornGear,
} from '../testing/set_bonus_scenario';
import { rankableSetPotential } from './engine/set-potential';

// The engine reads items and gems through `Database.getSync()`; the real class over the test database stands in for the page's.
vi.mock('@sim/proto/database', importOriginal => import('../testing/database_mock').then(m => m.withTestDatabase(importOriginal)));

// Every feral run reads hit, so each meta repair searches with the hit term, and several
// cases run 15-27 s alone, near the default timeout.
vi.setConfig({ testTimeout: 120_000 });

describe('set-bonus net value', () => {
	it('worn 0, no other set — bonusDpsNet = raw b2/b4, no B sims', async () => {
		const { ranking } = await runScenario({
			worn: wornGear({}),
			pool: TH_POOL,
			measureSetBonuses: true,
		});
		const bonuses = ranking.setBonuses ?? [];
		const b2 = bonuses.find(b => b.setId === 676 && b.threshold === 2);
		const b4 = bonuses.find(b => b.setId === 676 && b.threshold === 4);
		expect(b2?.bonusDps).toBeDefined();
		expectNear(b2!.bonusDps!, B2_TH);
		// No worn set breaks, so bonusDpsNet == raw and no brokenSetValues sims ran.
		expectNear(b2!.bonusDpsNet!, B2_TH);
		expectNear(b4!.bonusDpsNet!, B4_TH);
		expect(ranking.brokenSetValues ?? []).toHaveLength(0);
		// Row credit: full = b2+b4; split = b2/2 + b4/4.
		const row = thRow(ranking, THUNDERHEART.hands);
		const fut = row.setContext?.futureBonuses ?? [];
		const f2 = fut.find(f => f.threshold === 2);
		const f4 = fut.find(f => f.threshold === 4);
		expectNear(f2!.dps!, B2_TH);
		expectNear(f4!.dps!, B4_TH);
	});

	it('Malorne 2pc worn in two Thunderheart slots — one B sim, nets exact', async () => {
		// Worn: Malorne in hands + legs (2pc active). Thunderheart worn 0.
		const { ranking } = await runScenario({
			worn: wornGear({ hands: MALORNE.hands, legs: MALORNE.legs }),
			pool: [
				...TH_POOL,
				// Neutral candidates so the vacate has non-set replacements.
				{ itemId: NEUTRAL.hands[0], slot: 'hands' },
				{ itemId: NEUTRAL.legs[0], slot: 'legs' },
			],
			measureSetBonuses: true,
		});
		// Exactly one B sim: Malorne 2pc.
		const bsv = ranking.brokenSetValues ?? [];
		const mal = bsv.filter(b => b.setId === 640 && b.threshold === 2);
		expect(mal).toHaveLength(1);
		expect(mal[0]!.dps).toBeDefined();
		expectNear(mal[0]!.dps!, B2_MAL, 0.5);
		// 2pc net = b2 (k=2, c=1 -> raw - B); 4pc net = b4 (k=2, c=2 -> raw).
		const bonuses = ranking.setBonuses ?? [];
		const th2 = bonuses.find(b => b.setId === 676 && b.threshold === 2);
		const th4 = bonuses.find(b => b.setId === 676 && b.threshold === 4);
		expectNear(th2!.bonusDpsNet!, B2_TH, 0.5);
		expectNear(th4!.bonusDpsNet!, B4_TH, 0.5);
		// The loss is disclosed on every Thunderheart row: breaking rows carry it as
		// a singleBreak (inside deltaDps), non-breaking rows as a commitBreak.
		for (const row of ranking.items.filter(i => i.setContext?.setId === 676)) {
			const single = row.setContext?.singleBreaks ?? [];
			const commit = row.setContext?.commitBreaks ?? [];
			const hasMalorne = [...single, ...commit].some(b => b.setId === 640 && near(b.dps ?? -1, B2_MAL, 0.5));
			expect(hasMalorne).toBe(true);
		}
	});

	it('worn 1/2/3 futures shrink; worn 3 has none', async () => {
		// worn 1 Thunderheart (hands): future = [4pc, 3 needed]; crossesThreshold.
		const worn1 = await runScenario({
			worn: wornGear({ hands: THUNDERHEART.hands }),
			pool: TH_POOL.filter(p => p.slot !== 'hands'),
			measureSetBonuses: true,
		});
		const row1 = worn1.ranking.items.find(i => i.setContext?.setId === 676);
		expect(row1?.setContext?.piecesWornBefore).toBe(1);
		// Every count above the swap's count is a future. The model has no bonus
		// at 3 or 5, so those two are within the noise.
		const fut1 = row1?.setContext?.futureBonuses ?? [];
		expect(fut1.map(f => [f.threshold, f.belowNoise ?? false])).toEqual([
			[3, true],
			[4, false],
			[5, true],
		]);
		expect(fut1.find(f => f.threshold === 4)?.piecesNeeded).toBe(3);

		// worn 3 Thunderheart: past 2pc, only 4pc could remain; with 3 worn and one
		// more swapped that is 4 -> crosses, no future above.
		const worn3 = await runScenario({
			worn: wornGear({
				hands: THUNDERHEART.hands,
				legs: THUNDERHEART.legs,
				chest: THUNDERHEART.chest,
			}),
			pool: [{ itemId: THUNDERHEART.shoulder, slot: 'shoulder' }],
			measureSetBonuses: true,
		});
		const row3 = worn3.ranking.items.find(i => i.setContext?.setId === 676);
		expect(row3?.setContext?.piecesWornBefore).toBe(3);
		// swapping the shoulder makes 4 -> crosses the 4pc, so no future threshold.
		expect(row3?.setContext?.futureBonuses ?? []).toHaveLength(0);
		expect(row3?.setContext?.crossesThreshold).toBe(true);
	});

	it('worn Malorne 3 pieces broken to below 2pc — Σown − Δ branch', async () => {
		// Malorne 3 worn (hands, legs, chest); Thunderheart pool includes hands+legs
		// so a 4pc Thunderheart package vacates 2 Malorne (3 -> 1, breaks 2pc).
		const { ranking } = await runScenario({
			worn: wornGear({
				hands: MALORNE.hands,
				legs: MALORNE.legs,
				chest: MALORNE.chest,
			}),
			pool: [...TH_POOL, { itemId: NEUTRAL.hands[0], slot: 'hands' }, { itemId: NEUTRAL.legs[0], slot: 'legs' }],
			measureSetBonuses: true,
		});
		const bsv = (ranking.brokenSetValues ?? []).filter(b => b.setId === 640 && b.threshold === 2);
		expect(bsv).toHaveLength(1);
		// B recovered via the worn>t branch (Σown − Δ), same value.
		expectNear(bsv[0]!.dps!, B2_MAL, 0.5);
	});

	it('no neutral replacement is needed — the ladder measures B on the worn gear', async () => {
		// Malorne 2pc worn in hands+legs, Thunderheart pool in those slots, and
		// NO neutral candidate. A vacate would have nothing to vacate to and
		// leave B unmeasured; the ladder needs no replacement.
		const { ranking } = await runScenario({
			worn: wornGear({ hands: MALORNE.hands, legs: MALORNE.legs }),
			pool: TH_POOL, // only Thunderheart, no neutrals
			measureSetBonuses: true,
		});
		const bsv = (ranking.brokenSetValues ?? []).find(b => b.setId === 640 && b.threshold === 2);
		expect(bsv?.unmeasured).toBeUndefined();
		expectNear(bsv!.dps!, B2_MAL, 0.5);
		const th4 = (ranking.setBonuses ?? []).find(b => b.setId === 676 && b.threshold === 4);
		expectNear(th4!.bonusDpsNet!, B4_TH, 0.5);
		// The hands row breaks the Malorne 2pc alone; its path adds head, chest
		// and shoulder: 50 + 100, then + 80 + 200 = 430, and 60 + 430 = pkgΔ4.
		const hands = thRow(ranking, THUNDERHEART.hands);
		expect((hands.setContext?.singleBreaks ?? []).map(brk)).toEqual([{ setId: 640, threshold: 2, dps: 40 }]);
		expectNear(hands.deltaDps, 60, 0.5);
		expectNear(rankableSetPotential(hands, FLOOR), 430, 0.5);
	});

	it('flag absent — no brokenSetValues; the flag adds only the ladder, check and bonus-gear sims', async () => {
		const worn = wornGear({ hands: MALORNE.hands, legs: MALORNE.legs });
		const pool = [...TH_POOL, { itemId: NEUTRAL.hands[0], slot: 'hands' as const }, { itemId: NEUTRAL.legs[0], slot: 'legs' as const }];
		const off = await runScenario({ worn, pool });
		const on = await runScenario({ worn, pool, measureSetBonuses: true });
		expect(off.ranking.brokenSetValues ?? []).toHaveLength(0);
		// The flag adds one ladder rung per worn Malorne piece (2), two check sims
		// for each count the pool reaches (2, 3 and 4: 6) and the bonus gears no
		// package sim already covers, the close calls' included (5), and nothing
		// else.
		expect(on.runCount).toBeGreaterThan(off.runCount);
		const bCount = (on.ranking.brokenSetValues ?? []).filter(b => b.dps !== undefined).length;
		expect(bCount).toBe(1);
		// The break split adds one bonus-off sim: the Pauldrons and Chestguard rows'
		// 4pc increments share one gear before (Pauldrons + Chestguard) and lose
		// Malorne 2pc by replacing the same two pieces.
		expect(on.runCount - off.runCount).toBe(2 + 6 + 5 + 1);
	});
});
