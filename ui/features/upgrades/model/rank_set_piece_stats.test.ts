/**
 * The set-potential credit counts the other path pieces' own stats, on the model sim of
 * `testing/set_bonus_scenario.ts`. Every literal is derived by hand from that model.
 */

import { describe, expect, it, vi } from 'vitest';

import { B2_TH, B4_TH, bonusOf, bsvDps, completeRanking, FLOOR, MALORNE, runMalorneOverThunderheart2pc, sortedIds, thRow } from '../testing/set_bonus_scenario';
import { rankableSetPotential, setPotentialTerms } from './engine/set-potential';
import { applyView } from './engine/view';

// The engine reads items and gems through `Database.getSync()`; the real class over the test database stands in for the page's.
vi.mock('@sim/proto/database', importOriginal => import('../testing/database_mock').then(m => m.withTestDatabase(importOriginal)));

// Every feral run reads hit, so each meta repair searches with the hit term, and several
// cases run 15-27 s alone, near the default timeout.
vi.setConfig({ testTimeout: 120_000 });

describe("other set pieces' own stats", () => {
	it("a package member's ON figure equals the measured package delta", async () => {
		const { on } = await runMalorneOverThunderheart2pc({
			676: { b2: B2_TH, b4: B4_TH },
			640: { b2: 40, b4: 30 },
		});
		const r = on.ranking;
		const p4 = bonusOf(r, 640, 4);
		expect(sortedIds(p4?.packageItemIds)).toEqual([29096, 29097, 29098, 29100]);
		expect(p4!.packageDeltaDps!).toBeCloseTo(320, 9);
		for (const id of p4!.packageItemIds!) {
			const row = thRow(r, id);
			expect(row.deltaDps + rankableSetPotential(row, FLOOR)).toBeCloseTo(p4!.packageDeltaDps!, 9);
		}
	});

	it('with Set potential off, set rows sort on deltaDps alone', async () => {
		const { on } = await runMalorneOverThunderheart2pc({
			676: { b2: B2_TH, b4: B4_TH },
			640: { b2: 40, b4: 30 },
		});
		const off = applyView(completeRanking(on.ranking), { withSetPotential: false });
		expect(off.rows.map(row => row.itemId)).toEqual([29096, 29098, 29100, 8289, 10140, 29097, 29099]);
	});

	it("a worn bonus within the noise is not a break; the pieces' own stats still hold it", async () => {
		// On the flag path a worn bonus that measures at or within the noise is
		// not a break at all, so no line charges it and no piece adds it back.
		// The chest row still ends at pkgΔ4, because the hands piece's own stats
		// (its single, −2) hold the loss. The bonus is worth 2, below the 3 DPS bar.
		const { on } = await runMalorneOverThunderheart2pc({
			676: { b2: 2, b4: B4_TH },
			640: { b2: 40, b4: 30 },
		});
		const r = on.ranking;
		const th2 = (r.wornSetLadder ?? []).find(e => e.setId === 676 && e.count === 2);
		expect(th2?.dps).toBeCloseTo(2, 9);
		expect(th2?.counted).toBe(false);
		expect(bsvDps(r, 676, 2)).toBeUndefined();
		const p4 = bonusOf(r, 640, 4);
		expect(p4!.packageDeltaDps!).toBeCloseTo(368, 9);
		expect(p4!.breaks ?? []).toEqual([]);
		const chest = thRow(r, MALORNE.chest);
		const f4 = (chest.setContext?.futureBonuses ?? []).find(f => f.threshold === 4);
		// The pieces are the 4pc's partner choice, and the credited gear's sim,
		// not the pieces' own stats, holds the hands' −2 (3570 − 3202 = 368).
		expect((f4?.pieces ?? []).map(p => p.itemId)).toEqual([MALORNE.head, MALORNE.shoulder, MALORNE.hands]);
		expect(f4?.bonusGearDps).toBeCloseTo(368, 9);
		const res = setPotentialTerms(chest.setContext, FLOOR);
		expect(res.creditedThreshold).toBe(4);
		expect(res.terms.filter(t => t.kind === 'break')).toEqual([]);
		expect(rankableSetPotential(chest, FLOOR)).toBeCloseTo(268, 9);
		expect(chest.deltaDps + rankableSetPotential(chest, FLOOR)).toBeCloseTo(p4!.packageDeltaDps!, 9);
	});
});
