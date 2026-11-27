/**
 * Set versions get their own meta repair: the set phase sims a set-kept and a
 * set-less version of each package, and each version's repair reads its own
 * hit, so a set bonus's hit moves the layout.
 */

import { describe, expect, it, vi } from 'vitest';

import {
	BASELINE_HIT_PERCENT,
	CHEST,
	holdsGem,
	INSCRIBED,
	metaOf,
	RAGESTEEL_BREASTPLATE,
	RAGESTEEL_SHOULDERS,
	RIGID,
	SHOULDER,
} from '../testing/meta_repair_inputs';
import {
	BURNING_RAGE,
	gearKey,
	incrementScenario,
	JUSTICAR,
	realId,
	requestItems,
	runSpec,
	scriptedStats,
	SET_KEPT_OFFSET,
	SET_LESS_OFFSET,
	SIM_FAILED_WORKER_DIED,
	type SpecRun,
	V_BONUS_HIT,
} from '../testing/meta_repair_runs';
import { candidateSwapPreRepair, candidateSwapWithRepairs } from './engine/gear-swap';
import type { PlayerStatsObservation, RaidSimRequest } from './engine/seams/sim-runner';
import type { SetScreenMode } from './engine/set-screen';
import { SIM_ORDER, type SimItemSpec } from './engine/slots';

vi.mock('@sim/proto/database', importOriginal => import('../testing/database_mock').then(m => m.withTestDatabase(importOriginal)));

/**
 * Lets the gem-repair-failure tests fail a set version's gem repair. The hit
 * budget sets how a repair scores layouts (`meta-repair.ts` `valueModel`), and
 * a version read of 1e308 percent still repaired, so the tests fake the
 * failure instead. While `belowRemaining` is set, a repair whose hit budget is
 * below it throws the engine's own `MetaRecolorLimitExceededError`; every other
 * repair, and every other test, gets the real one.
 */
const repairFault = vi.hoisted(() => ({
	belowRemaining: undefined as number | undefined,
	/** How many repairs the fault failed, so a test can show it fired. */
	fired: 0,
}));
vi.mock('./engine/meta-repair', async importOriginal => {
	const real = await importOriginal<typeof import('./engine/meta-repair')>();
	const repairMetaGems: typeof real.repairMetaGems = opts => {
		const below = repairFault.belowRemaining;
		if (below !== undefined && (opts.hitBudget?.remaining ?? 0) < below) {
			repairFault.fired += 1;
			throw new real.MetaRecolorLimitExceededError('meta repair exceeded its recolor limit');
		}
		return real.repairMetaGems(opts);
	};
	return { ...real, repairMetaGems };
});

const BR_POOL = [
	{ itemId: RAGESTEEL_SHOULDERS, slot: 'shoulder' },
	{ itemId: RAGESTEEL_BREASTPLATE, slot: 'chest' },
] as const;

/**
 * DPS for the Burning Rage scenarios: 2000, plus 5 per Ragesteel piece worn
 * (a copy counts), plus 30 when Burning Rage counts two pieces, so its check
 * clears and the screen keeps the set.
 */
function brDps(req: RaidSimRequest): number {
	const items = requestItems(req);
	let dps = 2000;
	let counted = 0;
	for (const spec of items) {
		if (!spec.id) continue;
		const id = realId(spec.id);
		if (id === RAGESTEEL_SHOULDERS || id === RAGESTEEL_BREASTPLATE) {
			dps += 5;
			if (spec.id < SET_LESS_OFFSET || spec.id >= SET_KEPT_OFFSET) counted += 1;
		}
	}
	return counted >= 2 ? dps + 30 : dps;
}

/** The gems of every slot, as a sorted multiset. */
const gemMultiset = (items: readonly SimItemSpec[]) => items.flatMap(spec => spec.gems.filter(g => g > 0)).sort((a, b) => a - b);

function multisetMinus(a: readonly number[], b: readonly number[]): number[] {
	const rest = [...b];
	const out: number[] = [];
	for (const x of a) {
		const i = rest.indexOf(x);
		if (i >= 0) rest.splice(i, 1);
		else out.push(x);
	}
	return out;
}

/** The received requests that are the screen's top (set-kept) and bottom (set-less) count sims. */
function brVersions(requests: readonly RaidSimRequest[]) {
	const all = requests.map(requestItems);
	const kept = all.filter(
		items => items[SHOULDER]?.id === SET_KEPT_OFFSET + RAGESTEEL_SHOULDERS && items[CHEST]?.id === SET_KEPT_OFFSET + RAGESTEEL_BREASTPLATE,
	);
	const setLess = all.filter(
		items => items[SHOULDER]?.id === SET_LESS_OFFSET + RAGESTEEL_SHOULDERS && items[CHEST]?.id === SET_LESS_OFFSET + RAGESTEEL_BREASTPLATE,
	);
	return { kept, setLess };
}

function brRun(bonusHit: number, extra: Partial<SpecRun> = {}, read?: (req: RaidSimRequest, call: number) => Promise<PlayerStatsObservation>) {
	const stats = scriptedStats({
		baselineGearHit: 52,
		baselineHitPercent: BASELINE_HIT_PERCENT,
		bonusHit: { [BURNING_RAGE]: bonusHit },
	});
	let call = 0;
	return runSpec({
		pool: BR_POOL,
		measureSetBonuses: true,
		setScreenMode: 'on',
		dps: brDps,
		controller: new AbortController(),
		computeStats: req => {
			call += 1;
			return read ? read(req, call) : Promise.resolve(stats(req));
		},
		...extra,
	});
}

/** The kept version holds no Rigid; the set-less one holds one. */
function expectOwnLayouts(requests: readonly RaidSimRequest[]) {
	const { kept, setLess } = brVersions(requests);
	expect(kept.length).toBeGreaterThan(0);
	expect(setLess.length).toBeGreaterThan(0);
	for (const k of kept) expect(holdsGem(k, RIGID)).toBe(false);
	for (const s of setLess) {
		expect(gemMultiset(s).filter(g => g === RIGID)).toHaveLength(1);
	}
	expect(multisetMinus(gemMultiset(setLess[0]!), gemMultiset(kept[0]!))).toEqual([RIGID]);
	expect(multisetMinus(gemMultiset(kept[0]!), gemMultiset(setLess[0]!))).toEqual([INSCRIBED]);
}

describe('set versions get their own repair', () => {
	it('the set-kept version drops the dead Rigid; the set-less version keeps one', async () => {
		// Oracle: the kept budget is 9.31 − 20 = −10.69, where two Inscribed win;
		// the set-less budget is 9.31, where one Rigid and one Inscribed win
		// (the Burning Rage package's scores in `meta-repair.test.ts`); both
		// were the best measured layouts.
		const run = await brRun(20);
		expectOwnLayouts(run.requests);
	});

	it('a set bonus with no hit leaves both versions one layout', async () => {
		// Oracle: equal missed hit gives equal budgets, which keeps the screen's
		// exact 0.
		const run = await brRun(0);
		const { kept, setLess } = brVersions(run.requests);
		expect(kept.length).toBeGreaterThan(0);
		expect(setLess.length).toBeGreaterThan(0);
		for (const k of kept) {
			for (const s of setLess) {
				expect(k.map(spec => spec.gems)).toEqual(s.map(spec => spec.gems));
			}
		}
	});

	it('one stats read per distinct request', async () => {
		// Oracle: the set phase reads each distinct request's stats once and
		// reuses the read for a repeat of the same request. The increment
		// scenario's run is checked below, where an increment's version is
		// built twice.
		const run = await brRun(20);
		const keys = run.statsRequests.map(gearKey);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it.each<SetScreenMode>(['on', 'off'])("a failed set-version read fails the run with the sim's error (set screen %s)", async setScreenMode => {
		// Oracle: a set version's read is a sim call, so its failure ends the
		// run with the sim's own message, as a failed baseline sim does. No
		// version goes on with the shared layout under a note of the tab's own
		// wording. The screen reads the first version when it is on; with it
		// off, the package's same-gear check does.
		const stats = scriptedStats({
			baselineGearHit: 52,
			baselineHitPercent: BASELINE_HIT_PERCENT,
			bonusHit: { [BURNING_RAGE]: 20 },
		});
		// A version read is of the package: both Ragesteel pieces worn. The
		// baseline and the candidates' own reads wear at most one.
		const isPackage = (req: RaidSimRequest) => {
			const ids = requestItems(req).map(spec => realId(spec.id ?? 0));
			return ids.includes(RAGESTEEL_SHOULDERS) && ids.includes(RAGESTEEL_BREASTPLATE);
		};
		let versionReads = 0;
		await expect(
			brRun(20, { setScreenMode }, req => {
				if (!isPackage(req)) return Promise.resolve(stats(req));
				versionReads += 1;
				return Promise.reject(new Error('worker died'));
			}),
		).rejects.toMatchObject(SIM_FAILED_WORKER_DIED);
		expect(versionReads).toBe(1);
	});

	it.each<SetScreenMode>(['off', 'on'])(
		'a gem repair that fails on a set version skips that set bonus, as on its own build (set screen %s)',
		async setScreenMode => {
			// Oracle: a failed gem repair is no failed sim. On a set package's own
			// build it skips the package with the meta-off note
			// (`set-bonus-values.ts`, the package loop); the same failure while rebuilding one of the
			// package's versions does the same, and the run goes on. Every
			// version's rebuild goes through the one catch in `requestsPerLayout`.
			// Burning Rage's 1000 hit puts each set-kept version's budget near
			// −990 rating, and only those repairs fail. No sim ran for the bonus,
			// so no note says one failed.
			repairFault.belowRemaining = -500;
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			let run;
			try {
				run = await brRun(1000, { setScreenMode });
			} finally {
				repairFault.belowRemaining = undefined;
				warn.mockRestore();
			}
			expect(run.ranking.complete).toBe(true);
			// A gem repair that fails is no failed call, so its rule follows the
			// sentence for the console and `error` stays unset: the run's error
			// toast shows only a failed call's error.
			expect(run.ranking.substitutions).toContainEqual({
				field: 'Burning Rage 2-piece set bonus',
				detail:
					'The Burning Rage 2-piece set bonus was not measured, because no ' +
					'gem swap could turn your meta gem on.\nmeta repair exceeded its recolor limit',
			});
			expect(run.ranking.substitutions.map(s => s.detail).join('\n')).not.toContain('the sims that measure it failed');
		},
	);

	it.each<SetScreenMode>(['off', 'on'])(
		'a gem repair that fails on a set version gives no line with an error and none that says a request was not built (set screen %s)',
		async setScreenMode => {
			// Oracle: the run's error toast shows the first line with an `error`
			// (`run_session.ts`), so a failed gem repair, which is no failed call,
			// must give no such line, and each caller says what it says for a
			// failed repair on its own build. The set screen once gave the line
			// "the check's sim could not be built" with the repair's message.
			// This run's failed rebuilds are in the package loop and, with the
			// screen on, the set screen.
			repairFault.belowRemaining = -500;
			repairFault.fired = 0;
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			let run;
			try {
				run = await brRun(1000, { setScreenMode });
			} finally {
				repairFault.belowRemaining = undefined;
				warn.mockRestore();
			}
			expect(repairFault.fired).toBeGreaterThan(0);
			expect(run.ranking.complete).toBe(true);
			const lines = run.ranking.substitutions;
			expect(lines.filter(s => s.error !== undefined)).toEqual([]);
			expect(lines.filter(s => /could not be built/.test(s.detail))).toEqual([]);
		},
	);

	it('a Stop during a set-phase sim stops the version reads, with no warning', async () => {
		// Oracle: after Stop the guard refuses each version read, and a refused
		// read is no failure to warn about.
		const controller = new AbortController();
		let readsAfterAbort = 0;
		const stats = scriptedStats({
			baselineGearHit: 52,
			baselineHitPercent: BASELINE_HIT_PERCENT,
			bonusHit: { [BURNING_RAGE]: 20 },
		});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		let run;
		try {
			run = await brRun(
				20,
				{
					controller,
					onRun: req => {
						const holdsCopy = requestItems(req).some(s => (s.id ?? 0) >= SET_LESS_OFFSET);
						if (holdsCopy && !controller.signal.aborted) controller.abort();
					},
				},
				req => {
					if (controller.signal.aborted) readsAfterAbort += 1;
					return Promise.resolve(stats(req));
				},
			);
			const versionWarnings = warn.mock.calls.filter(args => String(args[0]).startsWith('[upgrades] meta repair: set version'));
			expect(versionWarnings).toHaveLength(0);
		} finally {
			warn.mockRestore();
		}
		expect(controller.signal.aborted).toBe(true);
		expect(readsAfterAbort).toBe(0);
		expect(run.ranking.complete).toBe(false);
	});

	it('the increment after a rebuilt increment keeps its break split', async () => {
		// Oracle: the increment's break split keeps its pairing: `plain` is the
		// request the first increment simmed, so the store holds it.
		const s = await incrementScenario('V6');
		const hands = SIM_ORDER.indexOf('hands');
		const legs = SIM_ORDER.indexOf('legs');
		// Check 1: the first increment's gear (the Gauntlets row plus the Greaves)
		// needs a meta repair.
		const afterRow = candidateSwapWithRepairs(s.worn, hands, JUSTICAR.hands, s.gems).equipment;
		const pre = candidateSwapPreRepair(afterRow, legs, JUSTICAR.legs, s.gems);
		expect(metaOf(pre.socketed).status.kind).toBe('inactive');
		// Check 2: the first increment's simmed request differs in gems from the
		// default build, so the per-version rebuild ran.
		const defaultFirstIncrement = candidateSwapWithRepairs(afterRow, legs, JUSTICAR.legs, s.gems).equipment;
		const firstIncrementRequests = s.run.requests
			.map(requestItems)
			.filter(
				items =>
					items[hands]?.id === JUSTICAR.hands &&
					items[legs]?.id === JUSTICAR.legs &&
					items[SHOULDER]?.id === RAGESTEEL_SHOULDERS &&
					items[CHEST]?.id === RAGESTEEL_BREASTPLATE,
			);
		expect(firstIncrementRequests.length).toBeGreaterThan(0);
		for (const items of firstIncrementRequests) {
			expect(items.map(spec => spec.gems)).not.toEqual(defaultFirstIncrement.map(spec => spec.gems));
		}
		// Check 3: the increments cleared their checks, so the 4pc increment is split.
		const row = s.run.ranking.items.find(r => r.itemId === JUSTICAR.hands)!;
		const four = row.setContext?.futureBonuses?.find(f => f.threshold === 4);
		expect(four?.bonusGearDps).toBeDefined();
		expect(four?.bonusOffDps).toBeDefined();
		expect(s.run.ranking.setBonusOffSims?.skippedIncrements).toBe(0);
		// One read per distinct request on this run too: the first increment's
		// version is built for its own sim and again as the 4pc increment's
		// `plain`, and read once.
		const keys = s.run.statsRequests.map(gearKey);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("a first increment whose gear before has set hit the run's budget missed is skipped, not mismeasured", async () => {
		// Oracle: a first increment's split pairs with the gear before built on the
		// run's budget. Here the row's single swap completes Justicar 2pc, whose
		// hit that budget misses, so `requestsPerLayout`' entry 0 is a rebuild that
		// differs from it, and the split is skipped.
		const s = await incrementScenario('V7');
		const legs = SIM_ORDER.indexOf('legs');
		const hands = SIM_ORDER.indexOf('hands');
		// The row's single swap needs a repair, and its rebuild for the set's
		// hit changes a gem.
		const pre = candidateSwapPreRepair(s.worn, legs, JUSTICAR.legs, s.gems);
		expect(metaOf(pre.socketed).status.kind).toBe('inactive');
		const hitBudget = s.gems.repairHitBudget!;
		const rebuilt = candidateSwapWithRepairs(s.worn, legs, JUSTICAR.legs, {
			...s.gems,
			repairHitBudget: {
				...hitBudget,
				baselineRemaining: hitBudget.baselineRemaining - V_BONUS_HIT,
			},
		}).equipment;
		const single = candidateSwapWithRepairs(s.worn, legs, JUSTICAR.legs, s.gems).equipment;
		expect(rebuilt.map(x => x.gems)).not.toEqual(single.map(x => x.gems));
		// No request is the first increment's bonus-off version: the row's gear with
		// the Burning Rage pieces set-less.
		const bonusOff = s.run.requests
			.map(requestItems)
			.filter(
				items =>
					items[legs]?.id === JUSTICAR.legs &&
					items[hands]?.id === JUSTICAR.hands &&
					items[SHOULDER]?.id === SET_LESS_OFFSET + RAGESTEEL_SHOULDERS &&
					items[CHEST]?.id === SET_LESS_OFFSET + RAGESTEEL_BREASTPLATE,
			);
		expect(bonusOff).toEqual([]);
		const row = s.run.ranking.items.find(r => r.itemId === JUSTICAR.legs)!;
		const four = row.setContext?.futureBonuses?.find(f => f.threshold === 4);
		expect(four?.bonusGearDps).toBeDefined();
		expect(four?.bonusOffDps).toBeUndefined();
		expect(s.run.ranking.setBonusOffSims?.skippedIncrements).toBe(1);
	});
});
