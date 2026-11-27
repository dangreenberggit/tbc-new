/**
 * The set screen: its sims, its on mode's keep-and-drop rule on real rankings, and what it must
 * leave alone, on the model sim of `testing/set_bonus_scenario.ts`. Every literal is derived by
 * hand from that model.
 */

import { describe, expect, it, vi } from 'vitest';

import {
	B2_TH,
	B4_TH,
	bonusOf,
	CHEST_SLOT,
	COPY_OFFSET,
	CRYPTSTALKER,
	CRYSTALFORGE,
	FLOOR,
	JUSTICAR,
	LEGS_SLOT,
	MALORNE,
	PURSUIT,
	runScenario,
	type Scenario,
	type ScenarioRanking,
	screenFailedLine,
	SET_BONUSES,
	SET_KEPT_OFFSET,
	setPool,
	setSkipLines,
	SHOULDER_SLOT,
	SIM_VERSION,
	SR_SCENARIO,
	thRow,
	THUNDERHEART,
	V_TH,
	withValues,
	wornGear,
} from '../testing/set_bonus_scenario';
import { simCacheKey } from './engine/seams/sim-runner';
import { MemoryStore } from './engine/seams/store';
import { rankableSetPotential, setCreditUnmeasured } from './engine/set-potential';
import { type SetScreen } from './engine/set-screen';

// The engine reads items and gems through `Database.getSync()`; the real class over the test database stands in for the page's.
vi.mock('@sim/proto/database', importOriginal => import('../testing/database_mock').then(m => m.withTestDatabase(importOriginal)));

// Every feral run reads hit, so each meta repair searches with the hit term, and several
// cases run 15-27 s alone, near the default timeout.
vi.setConfig({ testTimeout: 120_000 });

/** Everything the screen must leave alone, from one run. */
async function screenFreeParts(ranking: ScenarioRanking) {
	return {
		setBonuses: ranking.setBonuses,
		brokenSetValues: ranking.brokenSetValues,
		wornSetLadder: ranking.wornSetLadder,
		crossingChecks: ranking.crossingChecks,
		bonusGearSims: ranking.bonusGearSims,
		rows: ranking.items.map(row => ({
			itemId: row.itemId,
			deltaDps: row.deltaDps,
			setContext: row.setContext,
			on: row.deltaDps + rankableSetPotential(row, FLOOR),
		})),
	};
}

/** Each screened set as [setId, kept, reason], in set id order. */
const verdictsOf = (screen: SetScreen | undefined) => (screen?.sets ?? []).map(s => [s.setId, s.kept, s.reason]);

/** True when a request wears any of `pieces` as a set-less or set-kept copy. */
const wearsCopyOf = (ids: readonly number[], pieces: readonly number[]) =>
	ids.some(id => pieces.includes(id - COPY_OFFSET) || pieces.includes(id - SET_KEPT_OFFSET));

/** What a row of a set the screen dropped must keep from the off run. */
function droppedRowParts(ranking: ScenarioRanking, itemIds: readonly number[]) {
	return itemIds.map(itemId => {
		const row = thRow(ranking, itemId);
		return {
			itemId,
			deltaDps: row.deltaDps,
			singleBreaks: row.setContext?.singleBreaks,
			crossesThreshold: row.setContext?.crossesThreshold,
			piecesAfterSwap: row.setContext?.piecesAfterSwap,
		};
	});
}

/** The set-screen fields of the on-mode readings that every case shares. */
function expectOnModeSims(run: Awaited<ReturnType<typeof runScenario>>, screened: number) {
	const screen = run.ranking.setScreen!;
	expect(screen.mode).toBe('on');
	expect(screen.iterations).toBe(300);
	expect(screen.seed).toBe(11);
	// Two sims per screened set, all at N = 300, seed 11, with
	// per-iteration values; no ladder rung and no other screen N.
	expect(screen.simmed + screen.fromStore).toBe(2 * screened);
	const screenOpts = run.callOpts.filter(o => o.saveAllValues === true);
	expect(screenOpts).toHaveLength(screen.simmed);
	for (const o of screenOpts) {
		expect(o).toEqual({ seed: 11, iterations: 300, saveAllValues: true });
	}
	expect(run.callOpts.some(o => o.iterations === 100 || o.iterations === 1000)).toBe(false);
}

const SIGMA_FAKE = (Math.SQRT2 * 30) / Math.sqrt(300);

// The no-bonus case: SR_SCENARIO's gear and pool plus Justicar 626 (own value −30 each,
// model bonuses 0, nothing worn, R = 4).
const SN_SCENARIO: Scenario = {
	...SR_SCENARIO,
	pool: [...SR_SCENARIO.pool, ...setPool(JUSTICAR)],
	itemValue: withValues(Object.values(JUSTICAR).map(id => [id, -30] as const)),
	setBonuses: { ...SET_BONUSES, 626: { b2: 0, b4: 0 } },
};

// The band case: nothing worn; four sets of two pool pieces each, M2 = d_a + d_b +
// b2: Thunderheart 150, Malorne 100, Justicar 97, Crystalforge 96.
const SB_SCENARIO: Scenario = {
	worn: wornGear({}),
	pool: [
		{ itemId: THUNDERHEART.shoulder, slot: 'shoulder' },
		{ itemId: THUNDERHEART.chest, slot: 'chest' },
		{ itemId: MALORNE.shoulder, slot: 'shoulder' },
		{ itemId: MALORNE.legs, slot: 'legs' },
		{ itemId: JUSTICAR.shoulder, slot: 'shoulder' },
		{ itemId: JUSTICAR.hands, slot: 'hands' },
		{ itemId: CRYSTALFORGE.chest, slot: 'chest' },
		{ itemId: CRYSTALFORGE.hands, slot: 'hands' },
	],
	itemValue: withValues([
		[THUNDERHEART.shoulder, 50],
		[THUNDERHEART.chest, 50],
		[MALORNE.shoulder, 40],
		[MALORNE.legs, 40],
		[JUSTICAR.shoulder, 40],
		[JUSTICAR.hands, 37],
		[CRYSTALFORGE.chest, 40],
		[CRYSTALFORGE.hands, 36],
	]),
	setBonuses: {
		676: { b2: 50, b4: 0 },
		640: { b2: 20, b4: 0 },
		626: { b2: 20, b4: 0 },
		629: { b2: 20, b4: 0 },
	},
	measureSetBonuses: true,
	reportsSetBonuses: true,
};

// The below-zero case: worn Gauntlets of Malorne (Malorne at 1). Malorne's three pool
// pieces are worth −155 each; each single is −115 because it reaches the 2pc
// alone, and the screen takes that 2pc out, so its best case is
// −155 + 110 = −45; its crossing check still clears (2pc 40). Thunderheart wrist, waist and feet
// (−15, −15, −100) measure −30 + 50 = 20; Gladiator's Pursuit chest and
// hands (−12.375 each, 2pc 20) measure −4.75.
const SD_SCENARIO: Scenario = {
	worn: wornGear({ hands: MALORNE.hands }),
	pool: [
		{ itemId: MALORNE.shoulder, slot: 'shoulder' },
		{ itemId: MALORNE.chest, slot: 'chest' },
		{ itemId: MALORNE.legs, slot: 'legs' },
		{ itemId: THUNDERHEART.wrist, slot: 'wrist' },
		{ itemId: THUNDERHEART.waist, slot: 'waist' },
		{ itemId: THUNDERHEART.feet, slot: 'feet' },
		{ itemId: PURSUIT.chest, slot: 'chest' },
		{ itemId: PURSUIT.hands, slot: 'hands' },
	],
	itemValue: withValues([
		[MALORNE.shoulder, -155],
		[MALORNE.chest, -155],
		[MALORNE.legs, -155],
		[THUNDERHEART.wrist, -15],
		[THUNDERHEART.waist, -15],
		[THUNDERHEART.feet, -100],
		[PURSUIT.chest, -12.375],
		[PURSUIT.hands, -12.375],
	]),
	setBonuses: { ...SET_BONUSES, 586: { b2: 20, b4: 0 } },
	measureSetBonuses: true,
	reportsSetBonuses: true,
};

describe("the set screen's sims", () => {
	it("only the screen's sims ask for per-iteration values, under their own store key", async () => {
		// Scenario kind: the tab's run with the screen on and off, on gear that
		// has a worn-set ladder, a crossing check and a set to collect.
		const off = await runScenario(SR_SCENARIO);
		const on = await runScenario({ ...SR_SCENARIO, setScreenMode: 'on' });
		expect(off.callOpts.some(o => 'saveAllValues' in o)).toBe(false);
		expect(on.callOpts.some(o => o.saveAllValues === true)).toBe(true);
		// Store keys: only a run that asks for per-iteration values gets
		// a new key; every other key is as before.
		const req = { raid: {} };
		const plainKey = `${JSON.stringify(req)}:${SIM_VERSION}:11:300`;
		expect(simCacheKey(req, SIM_VERSION, { seed: 11, iterations: 300 })).toBe(plainKey);
		expect(
			simCacheKey(req, SIM_VERSION, {
				seed: 11,
				iterations: 300,
				saveAllValues: false,
			}),
		).toBe(plainKey);
		expect(
			simCacheKey(req, SIM_VERSION, {
				seed: 11,
				iterations: 300,
				saveAllValues: true,
			}),
		).toBe(`${plainKey}:all`);
	});
});

describe("the set screen's on mode", () => {
	it('a set with no bonus in reach is dropped and costs only its two screen sims', async () => {
		// Scenario kind: a set whose bonuses do nothing for this spec, beside a
		// set worth collecting. Example: Justicar 626 next to SR_SCENARIO's
		// Thunderheart (w = 1, R = 4, 2pc 50, 4pc 80).
		const off = await runScenario(SN_SCENARIO);
		const on = await runScenario({ ...SN_SCENARIO, setScreenMode: 'on' });
		const screen = on.ranking.setScreen!;
		expectOnModeSims(on, 2);
		expect(screen.sigma).toBeCloseTo(SIGMA_FAKE, 9);
		expect(screen.sets.map(s => [s.setId, s.worn, s.reach, s.pair.dps, s.pair.pairedSe, s.bestStats, s.measure])).toEqual([
			[626, 0, 4, 0, 0, -100, -100],
			// The singles' 2pc is taken out: 410 − 3 · 50.
			[676, 1, 4, 130, 0, 260, 390],
		]);
		expect(verdictsOf(screen)).toEqual([
			[626, false, 'exact-zero'],
			[676, true, 'top-k'],
		]);
		// After the singles, only the two screen sims wear a Justicar
		// copy; the off run sends its check sims too.
		const justicar = Object.values(JUSTICAR);
		const onCopies = on.calls.map((ids, i) => [ids, on.callOpts[i]!] as const).filter(([ids]) => wearsCopyOf(ids, justicar));
		expect(onCopies.map(([, o]) => o)).toEqual([
			{ seed: 11, iterations: 300, saveAllValues: true },
			{ seed: 11, iterations: 300, saveAllValues: true },
		]);
		expect(off.calls.filter(ids => wearsCopyOf(ids, justicar)).length).toBeGreaterThan(2);
		// The dropped set has no entry; the screen records it.
		expect((on.ranking.setBonuses ?? []).filter(b => b.setId === 626)).toEqual([]);
		// Its rows keep their single-swap figure, breaks and crossing, and get
		// no Set potential.
		expect(droppedRowParts(on.ranking, justicar)).toEqual(droppedRowParts(off.ranking, justicar));
		for (const id of justicar) {
			const row = thRow(on.ranking, id);
			expect(row.setContext).toBeDefined();
			expect(row.setContext?.futureBonuses ?? []).toEqual([]);
			expect(row.setContext?.nextThreshold).toBeNull();
			expect(rankableSetPotential(row, FLOOR)).toBe(0);
			expect(setCreditUnmeasured(row.setContext)).toBe(false);
		}
		// The Justicar shoulder and chest rows break the worn Malorne 2pc.
		expect(thRow(on.ranking, JUSTICAR.chest).setContext?.singleBreaks?.map(b => [b.setId, b.threshold])).toEqual([[640, 2]]);
		// Thunderheart is kept, and its entries, rows and ON figures are the
		// off run's.
		const thParts = async (ranking: ScenarioRanking) =>
			(await screenFreeParts(ranking)).rows.filter(r => [THUNDERHEART.shoulder, THUNDERHEART.chest, THUNDERHEART.legs].includes(r.itemId as never));
		expect(await thParts(on.ranking)).toEqual(await thParts(off.ranking));
		expect((on.ranking.setBonuses ?? []).filter(b => b.setId === 676)).toEqual((off.ranking.setBonuses ?? []).filter(b => b.setId === 676));
		expect(on.ranking.items.map(r => [r.itemId, r.deltaDps])).toEqual(off.ranking.items.map(r => [r.itemId, r.deltaDps]));
	});

	it('a close third set survives in the band; the fourth does not', async () => {
		// Scenario kind: three sets with real bonuses whose best cases are
		// close (like C5's 617). Example: SB_SCENARIO; band 3.464102.
		const on = await runScenario({ ...SB_SCENARIO, setScreenMode: 'on' });
		const screen = on.ranking.setScreen!;
		expectOnModeSims(on, 4);
		expect(screen.sigma).toBeCloseTo(2.44949, 6);
		expect(screen.sets.map(s => [s.setId, s.pair.dps, s.measure])).toEqual([
			[626, 20, 97],
			[629, 20, 96],
			[640, 20, 100],
			[676, 50, 150],
		]);
		expect(verdictsOf(screen)).toEqual([
			[626, true, 'band'],
			[629, false, 'outside-band'],
			[640, true, 'top-k'],
			[676, true, 'top-k'],
		]);
		// The band set's gain side runs; the dropped set has no entry.
		const justicar2 = bonusOf(on.ranking, 626, 2);
		expect(justicar2?.unmeasured).toBeUndefined();
		expect(justicar2?.sameGearDps).toBeCloseTo(20, 9);
		expect((on.ranking.setBonuses ?? []).filter(b => b.setId === 629).map(b => [b.threshold, b.unmeasured])).toEqual([]);
	});

	it('a set whose best case loses to current gear is dropped, even below K', async () => {
		// Scenario kind: a worn set's other pieces are much worse than the
		// player's gear (a level-60 or off-spec set). Example: SD_SCENARIO;
		// 2σ = 4.898979. The dropped set is worn at 1 and its crossing check
		// clears, so its rows keep a crossing line.
		const off = await runScenario(SD_SCENARIO);
		const on = await runScenario({ ...SD_SCENARIO, setScreenMode: 'on' });
		const screen = on.ranking.setScreen!;
		expectOnModeSims(on, 3);
		expect(screen.sets.map(s => [s.setId, s.worn, s.reach, s.pair.dps, s.measure])).toEqual([
			[586, 0, 2, 20, -4.75],
			[640, 1, 4, 110, -45],
			// The pool fills 3 Thunderheart slots, but the sim lists no 3pc bonus,
			// so the reach is the 2pc.
			[676, 0, 2, 50, 20],
		]);
		expect(verdictsOf(screen)).toEqual([
			[586, true, 'top-k'],
			[640, false, 'below-zero'],
			[676, true, 'top-k'],
		]);
		// The dropped worn set's crossing check cleared, and its rows keep
		// the off run's single breaks, crossing and piece count.
		expect((on.ranking.crossingChecks ?? []).filter(g => g.setId === 640).map(g => [g.count, g.cleared])).toEqual([[2, true]]);
		expect(on.ranking.crossingChecks).toEqual(off.ranking.crossingChecks);
		const malorne = [MALORNE.shoulder, MALORNE.chest, MALORNE.legs];
		expect(droppedRowParts(on.ranking, malorne)).toEqual(droppedRowParts(off.ranking, malorne));
		for (const id of malorne) {
			const row = thRow(on.ranking, id);
			expect(row.setContext?.crossesThreshold).toBe(true);
			expect(row.setContext?.piecesAfterSwap).toBe(2);
			expect(row.setContext?.futureBonuses ?? []).toEqual([]);
			expect(rankableSetPotential(row, FLOOR)).toBe(0);
			expect(setCreditUnmeasured(row.setContext)).toBe(false);
		}
		expect((on.ranking.setBonuses ?? []).filter(b => b.setId === 640).map(b => [b.threshold, b.unmeasured])).toEqual([]);
	});

	it('a set whose screen readings failed is kept and measured as with the screen off', async () => {
		// Scenario kind: off-class Cryptstalker 530, whose sims
		// fail. Example: SR_SCENARIO's gear; the screen's high rung (Thunderheart
		// set-kept) fails at N = 300.
		const off = await runScenario(SR_SCENARIO);
		const on = await runScenario({
			...SR_SCENARIO,
			setScreenMode: 'on',
			failWhen: (ids, opts) =>
				opts.saveAllValues === true &&
				opts.iterations === 300 &&
				ids[SHOULDER_SLOT] === SET_KEPT_OFFSET + THUNDERHEART.shoulder &&
				ids[CHEST_SLOT] === SET_KEPT_OFFSET + THUNDERHEART.chest &&
				ids[LEGS_SLOT] === SET_KEPT_OFFSET + THUNDERHEART.legs,
		});
		const set = on.ranking.setScreen!.sets[0]!;
		expect(set.pair).toEqual({});
		expect(set.measure).toBeUndefined();
		expect([set.kept, set.reason]).toEqual([true, 'readings-absent']);
		// the screen sim's own error reaches the player.
		expect(setSkipLines(on.ranking)).toEqual([screenFailedLine]);
		// The gain side runs as with the screen off.
		expect(await screenFreeParts(on.ranking)).toEqual(await screenFreeParts(off.ranking));
	});

	it('the screen on changes only the gain-side set list', async () => {
		// Scenario kind: the screen's invariant. (a) SN_SCENARIO's gear, which wears Malorne
		// 2pc (so the ladder runs) and gives Thunderheart a crossing check;
		// (b) SR_SCENARIO's gear, where every set survives.
		const offA = await runScenario(SN_SCENARIO);
		const onA = await runScenario({ ...SN_SCENARIO, setScreenMode: 'on' });
		expect(offA.ranking.wornSetLadder?.length).toBeGreaterThan(0);
		expect(offA.ranking.crossingChecks?.length).toBeGreaterThan(0);
		expect(onA.ranking.wornSetLadder).toEqual(offA.ranking.wornSetLadder);
		expect(onA.ranking.brokenSetValues).toEqual(offA.ranking.brokenSetValues);
		expect(onA.ranking.crossingChecks).toEqual(offA.ranking.crossingChecks);
		// Without the screen sims and Justicar's off-run gain sims, the two
		// runs send the same requests with the same options, in order.
		const justicar = Object.values(JUSTICAR);
		const offRest = offA.calls.map((ids, i) => [ids, offA.callOpts[i]!] as const).filter(([ids]) => !wearsCopyOf(ids, justicar));
		const onRest = onA.calls.map((ids, i) => [ids, onA.callOpts[i]!] as const).filter(([, o]) => o.saveAllValues !== true);
		expect(onRest).toEqual(offRest);
		expectOnModeSims(onA, 2);

		const offB = await runScenario(SR_SCENARIO);
		const onB = await runScenario({ ...SR_SCENARIO, setScreenMode: 'on' });
		expect(verdictsOf(onB.ranking.setScreen)).toEqual([[676, true, 'top-k']]);
		expect(await screenFreeParts(onB.ranking)).toEqual(await screenFreeParts(offB.ranking));
		expectOnModeSims(onB, 1);
	});

	// A single swap of a set worn at w reaches w + 1 pieces, so when
	// w + 1 is a bonus count each piece's single already holds that bonus. The
	// screen's estimate is meant to hold none of the set's own bonuses (the pair
	// adds them), so the estimate at t must count that bonus 0 times and the
	// measure exactly once.
	const singleOf = (ranking: ScenarioRanking, itemId: number) => {
		const row = thRow(ranking, itemId);
		return row.setContext?.singleDeltaDps ?? row.deltaDps;
	};

	it('at worn 1 the screen counts the 2pc once, not once per added piece plus the pair', async () => {
		// Scenario kind: a set worn at 1 whose pool reaches the 4pc. Example:
		// Thunderheart Gauntlets worn; pool Pauldrons, Chestguard, Leggings at
		// V_TH each, nothing displaced, 2pc B2_TH, 4pc B4_TH.
		const pieces = [THUNDERHEART.shoulder, THUNDERHEART.chest, THUNDERHEART.legs];
		const { ranking } = await runScenario({
			worn: wornGear({ hands: THUNDERHEART.hands }),
			pool: setPool({
				shoulder: THUNDERHEART.shoulder,
				chest: THUNDERHEART.chest,
				legs: THUNDERHEART.legs,
			}),
			measureSetBonuses: true,
			reportsSetBonuses: true,
			setScreenMode: 'on',
		});
		// Each single reaches 2 pieces, so it holds the 2pc once.
		for (const id of pieces) {
			expect(singleOf(ranking, id)).toBeCloseTo(V_TH + B2_TH, 9);
		}
		const set = ranking.setScreen!.sets.find(s => s.setId === 676)!;
		expect([set.worn, set.reach]).toEqual([1, 4]);
		// The pair: 2pc and 4pc, each once.
		expect(set.pair.dps).toBeCloseTo(B2_TH + B4_TH, 9);
		// The best estimate is all three pieces' own value, with no 2pc in it.
		const twoPcTimesInEstimate = (set.bestStats! - 3 * V_TH) / B2_TH;
		expect(twoPcTimesInEstimate).toBeCloseTo(0, 9);
		// The measure counts the 2pc once: 300 + 50 + 80 = 430.
		const twoPcTimesInMeasure = (set.measure! - 3 * V_TH - B4_TH) / B2_TH;
		expect(twoPcTimesInMeasure).toBeCloseTo(1, 9);
		expect(set.measure).toBeCloseTo(3 * V_TH + B2_TH + B4_TH, 9);
	});

	it('at worn 3 of a set with a 6pc, the screen counts the 4pc once', async () => {
		// Scenario kind: a set worn at 3 whose bonus at 4 is reached by every
		// single swap, and whose pool reaches a higher bonus, so the screen runs.
		// Example: Cryptstalker 530 (model 2pc 10, 4pc 20, 6pc 30, 8pc 40) worn
		// head, shoulder, chest; pool wrist, hands, waist at 100 each.
		const B4 = 20;
		const B6 = 30;
		const pieces = [CRYPTSTALKER.wrist, CRYPTSTALKER.hands, CRYPTSTALKER.waist];
		const { ranking } = await runScenario({
			worn: wornGear({
				head: CRYPTSTALKER.head,
				shoulder: CRYPTSTALKER.shoulder,
				chest: CRYPTSTALKER.chest,
			}),
			pool: setPool({
				wrist: CRYPTSTALKER.wrist,
				hands: CRYPTSTALKER.hands,
				waist: CRYPTSTALKER.waist,
			}),
			itemValue: withValues(Object.values(CRYPTSTALKER).map(id => [id, 100] as const)),
			setBonuses: {
				...SET_BONUSES,
				530: { b2: 10, b4: B4, b6: B6, b8: 40 },
			},
			measureSetBonuses: true,
			reportsSetBonuses: true,
			setScreenMode: 'on',
		});
		// Each single reaches 4 pieces, so it holds the 4pc once.
		for (const id of pieces) {
			expect(singleOf(ranking, id)).toBeCloseTo(100 + B4, 9);
		}
		const set = ranking.setScreen!.sets.find(s => s.setId === 530)!;
		expect([set.worn, set.reach]).toEqual([3, 6]);
		expect(set.pair.dps).toBeCloseTo(B4 + B6, 9);
		const fourPcTimesInEstimate = (set.bestStats! - 3 * 100) / B4;
		expect(fourPcTimesInEstimate).toBeCloseTo(0, 9);
		const fourPcTimesInMeasure = (set.measure! - 3 * 100 - B6) / B4;
		expect(fourPcTimesInMeasure).toBeCloseTo(1, 9);
	});

	it('when the crossing check at worn + 1 has no value, the screen keeps the set unread', async () => {
		// Scenario kind: the worn-1 case's gear, with the crossing check's sim failing, so
		// the bonus each single holds is unknown and the estimate cannot take it
		// out. Example: the check's "off" sim fails: one Thunderheart piece and
		// one set-less copy of another, the only request with that mix.
		const th: readonly number[] = Object.values(THUNDERHEART);
		const { ranking } = await runScenario({
			worn: wornGear({ hands: THUNDERHEART.hands }),
			pool: setPool({
				shoulder: THUNDERHEART.shoulder,
				chest: THUNDERHEART.chest,
				legs: THUNDERHEART.legs,
			}),
			measureSetBonuses: true,
			reportsSetBonuses: true,
			setScreenMode: 'on',
			failWhen: (ids, opts) =>
				opts.saveAllValues !== true && ids.filter(id => th.includes(id)).length === 1 && ids.filter(id => th.includes(id - COPY_OFFSET)).length === 1,
		});
		const crossing = ranking.crossingChecks?.filter(c => c.setId === 676);
		expect(crossing?.map(c => [c.count, c.dps])).toEqual([[2, undefined]]);
		const set = ranking.setScreen!.sets.find(s => s.setId === 676)!;
		expect(set.bestStats).toBeUndefined();
		expect([set.kept, set.reason]).toEqual([true, 'readings-absent']);
	});

	it('"on" has its own content hash, and unset hashes as before', async () => {
		const store = new MemoryStore();
		const unset = await runScenario({ ...SR_SCENARIO, store });
		// Unset, the hashed object has no setScreen key, as before.
		expect(unset.ranking.contentHash).not.toContain('"setScreen"');
		expect(unset.ranking.setScreen).toBeUndefined();
		// "on" on the same store is not served the cached ranking: it sends only
		// its two screen sims and answers everything else from the store.
		const on = await runScenario({
			...SR_SCENARIO,
			store,
			setScreenMode: 'on',
		});
		expect(on.ranking.contentHash).toContain('"setScreen":"on"');
		expect(on.ranking.setScreen?.mode).toBe('on');
		expect(on.runCount).toBe(2);
		const explicitOff = await runScenario({
			...SR_SCENARIO,
			setScreenMode: 'off',
		});
		const hashes = new Set([on.ranking.contentHash, explicitOff.ranking.contentHash, unset.ranking.contentHash]);
		expect(hashes.size).toBe(3);
	});
});
