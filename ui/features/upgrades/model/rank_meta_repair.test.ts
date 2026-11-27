/**
 * Meta repair with a hit budget, through `rankUpgrades`: the run reads the
 * worn gear's, the baseline's and each candidate's hit with `computeStats`,
 * and each repair counts hit only up to the cap that read leaves. The cases
 * check the layouts against literals from the sim's `/computeStats` readings
 * and probe results.
 */

import { describe, expect, it, vi } from 'vitest';

import {
	BASELINE_HIT_PERCENT,
	BOLD,
	changesBetween,
	CHEST,
	holdsGem,
	INSCRIBED,
	pseudoStatsWithHit,
	RAGESTEEL_SHOULDERS,
	RIGID,
} from '../testing/meta_repair_inputs';
import {
	baselineReadOnce,
	chestRequestChanges,
	gearHitReads,
	gearKey,
	GREAT_DAWNSTONE,
	incrementScenario,
	isHitCapNote,
	JUSTICAR,
	MANA_ETCHED_HIT,
	requestItems,
	runSpec,
	S_POOL,
	SIM_FAILED_WORKER_DIED,
	skeletonAtLevel,
	V_BONUS_HIT,
	warlockRun,
	wornWithMetaOff,
} from '../testing/meta_repair_runs';
import { candidateSwapWithRepairs } from './engine/gear-swap';
import type { PlayerStatsObservation } from './engine/seams/sim-runner';
import { MemoryStore } from './engine/seams/store';
import { SIM_ORDER } from './engine/slots';

vi.mock('@sim/proto/database', importOriginal => import('../testing/database_mock').then(m => m.withTestDatabase(importOriginal)));

/** The note a full-weight spec gets. */
const FULL_WEIGHT_DETAIL = 'If gems were swapped to turn your meta gem on, hit rating was counted ' + 'at full value, with no hit cap applied for this spec.';

describe('rankUpgrades reads the baseline hit', () => {
	it("with the baseline's hit read, the capped row gets two Inscribed and the uncapped row two Rigid", async () => {
		const run = await runSpec({ pool: S_POOL, computeStats: gearHitReads() });
		const capped = chestRequestChanges(run.requests, run.worn, 32365);
		expect(capped.length).toBeGreaterThan(0);
		for (const c of capped) {
			expect(c).toEqual([`${BOLD}->${INSCRIBED}`, `${BOLD}->${INSCRIBED}`]);
		}
		for (const req of run.requests) {
			const items = requestItems(req);
			if (items[CHEST]?.id === 32365) expect(holdsGem(items, RIGID)).toBe(false);
		}
		const uncapped = chestRequestChanges(run.requests, run.worn, 30907);
		expect(uncapped.length).toBeGreaterThan(0);
		for (const c of uncapped) {
			expect(c).toEqual([`${BOLD}->${RIGID}`, `${BOLD}->${RIGID}`]);
		}
	});

	it("a failed baseline read fails the run with the sim's error", async () => {
		// Oracle: the read is a sim call, so its failure ends the run as a
		// failed baseline sim does, with the sim's own message. No repair runs
		// at full weight under a note of the tab's own wording.
		let reads = 0;
		let sims = 0;
		await expect(
			runSpec({
				pool: S_POOL,
				onRun: () => {
					sims += 1;
				},
				computeStats: () => {
					reads += 1;
					return Promise.reject(new Error('worker died'));
				},
			}),
		).rejects.toMatchObject(SIM_FAILED_WORKER_DIED);
		// The worn meta is on, so the baseline's is the only read; it follows
		// the baseline sim and no candidate is simmed.
		expect(reads).toBe(1);
		expect(sims).toBe(1);
	});

	it('a target that is not level 73 gives no budget, and the ranking says repair used full weight', async () => {
		const run = await runSpec({
			pool: S_POOL,
			skeleton: skeletonAtLevel(72),
			computeStats: baselineReadOnce(),
		});
		for (const chestId of [32365, 30907]) {
			const changes = chestRequestChanges(run.requests, run.worn, chestId);
			expect(changes.length).toBeGreaterThan(0);
			for (const c of changes) {
				expect(c).toEqual([`${BOLD}->${RIGID}`, `${BOLD}->${RIGID}`]);
			}
		}
		const notes = run.ranking.substitutions.filter(isHitCapNote);
		expect(notes).toHaveLength(1);
		expect(notes[0]!.field).toBe('Meta gem swaps and the hit cap');
		expect(notes[0]!.detail).toMatch(/always useful/);
		expect(notes[0]!.detail).toMatch(/level 73/);
	});

	it('a full-weight spec gets the full-weight note', async () => {
		const run = await runSpec({ pool: S_POOL, spec: 'rogue' });
		const notes = run.ranking.substitutions.filter(s => s.detail === FULL_WEIGHT_DETAIL);
		expect(notes).toEqual([{ field: 'Meta gem swaps and the hit cap', detail: FULL_WEIGHT_DETAIL }]);
	});

	it("a budget spec on a runner with no computeStats fails at the baseline's read", async () => {
		// Oracle: `SimRunner.computeStats` is required, so no budget spec
		// repairs at full weight without saying so. A runner that breaks the
		// type fails the run at its first read, after the baseline sim and
		// before any candidate sim.
		for (const spec of ['ret', 'feral', 'mage', 'shadow', 'warlock'] as const) {
			let sims = 0;
			await expect(
				runSpec({
					pool: S_POOL,
					spec,
					onRun: () => {
						sims += 1;
					},
				}),
			).rejects.toThrow(/computeStats is not a function/);
			expect(sims).toBe(1);
		}
	});
});

describe('the worn-gear repair uses the hit cap', () => {
	it('with stats readable, the worn repair reads the un-repaired gear and puts Inscribed, not Rigid, in the chest', async () => {
		const worn = wornWithMetaOff();
		let calls = 0;
		const run = await runSpec({
			worn,
			pool: S_POOL,
			computeStats: () => {
				calls += 1;
				return Promise.resolve({ stats: [], pseudoStats: pseudoStatsWithHit(BASELINE_HIT_PERCENT) });
			},
		});
		const baselineChest = requestItems(run.requests[0]!)[CHEST]!;
		expect(baselineChest.gems).toEqual([BOLD, INSCRIBED, 28363]);
		expect(run.ranking.baseline?.metaAdjusted).toBe(true);
		// The worn gear's read, then the baseline's; candidate reads follow.
		expect(calls).toBeGreaterThanOrEqual(2);
		expect(requestItems(run.statsRequests[0]!)[CHEST]!.gems).toEqual(worn[CHEST]!.gems);
		expect(gearKey(run.statsRequests[1]!)).toBe(gearKey(run.requests[0]!));
	});

	it('with stats readable and hit under the cap, the worn repair keeps Rigid in the chest', async () => {
		const worn = wornWithMetaOff();
		// Two hit percent under the baseline's leaves about 31 rating of room, more than Rigid's 8.
		const run = await runSpec({
			worn,
			pool: S_POOL,
			computeStats: () => Promise.resolve({ stats: [], pseudoStats: pseudoStatsWithHit(BASELINE_HIT_PERCENT - 2) }),
		});
		const baselineChest = requestItems(run.requests[0]!)[CHEST]!;
		expect(baselineChest.gems).toEqual([BOLD, RIGID, 28363]);
		expect(run.ranking.baseline?.metaAdjusted).toBe(true);
		expect(run.statsRequests.length).toBeGreaterThan(0);
		expect(run.ranking.substitutions.filter(isHitCapNote)).toHaveLength(0);
	});

	it("a failed worn-gear read fails the run with the sim's error before any sim", async () => {
		// Oracle: the worn-gear read is the run's first sim call, so its failure
		// ends the run there, with the sim's own message. The worn repair does
		// not go on at full weight under a note of the tab's own wording.
		const worn = wornWithMetaOff();
		let reads = 0;
		let sims = 0;
		await expect(
			runSpec({
				worn,
				pool: S_POOL,
				onRun: () => {
					sims += 1;
				},
				computeStats: () => {
					reads += 1;
					return Promise.reject(new Error('worker died'));
				},
			}),
		).rejects.toMatchObject(SIM_FAILED_WORKER_DIED);
		expect(reads).toBe(1);
		expect(sims).toBe(0);
	});

	it('a run that reads stats is keyed apart from rankings whose worn repair used full weight', async () => {
		const run = await runSpec({ pool: S_POOL, computeStats: gearHitReads() });
		expect(run.ranking.contentHash).toContain('"metaRepairHitCap":"worn-and-candidates"');
		expect(run.ranking.contentHash).not.toContain('"metaRepairHitCap":true');
	});
});

describe('Stop ends a stats read', () => {
	it('a Stop during a never-answering stats read returns a PartialRanking', async () => {
		// The abort fires inside the read, before it returns its promise, so a
		// race that attached its listener after calling the read would miss it.
		const store = new MemoryStore();
		const controller = new AbortController();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		let stopped;
		try {
			stopped = await runSpec({
				pool: S_POOL,
				store,
				controller,
				computeStats: () => {
					controller.abort();
					return new Promise<PlayerStatsObservation>(() => {});
				},
			});
			const upgradesWarnings = warn.mock.calls.filter(args => String(args[0]).startsWith('[upgrades]'));
			expect(upgradesWarnings).toHaveLength(0);
		} finally {
			warn.mockRestore();
		}
		expect(stopped.ranking.complete).toBe(false);
		// No ranking was cached: a second run on the same store reads the hit
		// again instead of returning a stored ranking.
		const again = await runSpec({ pool: S_POOL, store, computeStats: gearHitReads() });
		expect(again.statsRequests.length).toBeGreaterThan(0);
		expect(again.ranking.complete).toBe(true);
	});
});

describe("a candidate's repair reads its own hit", () => {
	it("a caster's repair charges spell hit against the slot-13 budget", async () => {
		// Oracle: the read holds spell hit in slot 13 only. 10 rating over the
		// cap keeps Great Dawnstone out; 30 under it lets one in.
		const over = await warlockRun({ bonusHit: 0, localBudget: -10 });
		for (const items of over.rows) {
			expect(holdsGem(items, GREAT_DAWNSTONE)).toBe(false);
		}
		const under = await warlockRun({ bonusHit: 0, localBudget: 30 });
		for (const items of under.rows) {
			expect(holdsGem(items, GREAT_DAWNSTONE)).toBe(true);
		}
	});

	it('a candidate that breaks a spell hit set repairs on its own read, which counts the lost bonus', async () => {
		// Oracle: the run's budget moved by gear hit leaves −10, but the swap
		// also loses the 2pc's 35 spell hit, so the candidate's own read gives
		// 25 and Great Dawnstone fits.
		const run = await warlockRun({ bonusHit: MANA_ETCHED_HIT, localBudget: -10 });
		for (const items of run.rows) {
			expect(holdsGem(items, GREAT_DAWNSTONE)).toBe(true);
		}
	});

	it('a melee candidate that completes a hit set repairs on its own read', async () => {
		// Oracle: the Leggings row completes Justicar 2pc (+40, scripted),
		// which the run's budget misses. Justicar Greaves (23 hit, no socket)
		// replace Crystalforge Greaves (21 hit, the Ornate Topaz), so the meta
		// needs one yellow back. On the run's budget, 31.5 − 2 = 29.5 rating
		// left, the Ragesteel Shoulders' Bold becomes Rigid. On the row's own
		// read, 29.5 − 40 = −10.5, hit is worth nothing and it becomes Inscribed.
		const s = await incrementScenario('V7');
		expect(V_BONUS_HIT).toBe(40);
		expect(s.gems.repairHitBudget!.baselineRemaining).toBeCloseTo(31.54, 2);
		const legs = SIM_ORDER.indexOf('legs');
		const runBudget = candidateSwapWithRepairs(s.worn, legs, JUSTICAR.legs, s.gems).equipment;
		expect(changesBetween(s.worn, runBudget, legs)).toEqual([[RAGESTEEL_SHOULDERS, 1, BOLD, RIGID]]);
		const rows = s.run.requests
			.map(requestItems)
			.filter(items => items.every((spec, i) => (i === legs ? spec.id === JUSTICAR.legs : (spec.id ?? 0) === (s.worn[i]!.id ?? 0))));
		expect(rows.length).toBeGreaterThan(0);
		for (const items of rows) {
			expect(changesBetween(s.worn, items, legs)).toEqual([[RAGESTEEL_SHOULDERS, 1, BOLD, INSCRIBED]]);
		}
	});

	it("a failed candidate read fails that candidate's sim and leaves the others on their budgets", async () => {
		// Oracle: the read is a sim-worker call, so its failure is that
		// candidate's failed sim. Heartshatter still repairs on the budget (two
		// Inscribed; full weight would put Rigid in), and no row is said to
		// have repaired without the hit read.
		const reads = gearHitReads();
		const run = await runSpec({
			pool: S_POOL,
			computeStats: req => (requestItems(req)[CHEST]?.id === 30907 ? Promise.reject(new Error('worker died')) : reads(req)),
		});
		expect(run.ranking.items.map(r => r.itemId)).toEqual([32365]);
		const capped = chestRequestChanges(run.requests, run.worn, 32365);
		expect(capped.length).toBeGreaterThan(0);
		for (const c of capped) {
			expect(c).toEqual([`${BOLD}->${INSCRIBED}`, `${BOLD}->${INSCRIBED}`]);
		}
		expect(chestRequestChanges(run.requests, run.worn, 30907)).toEqual([]);
		expect(run.ranking.substitutions.filter(s => s.field === 'item 30907')).toEqual([
			{
				field: 'item 30907',
				slot: 'chest',
				// `error` is the call's own error, word for word, so the run's
				// error toast can show it; the item id is for the console only.
				detail: 'This item was not ranked in this slot, because its sim failed.\nitem 30907, slot chest',
				error: 'worker died',
			},
		]);
		expect(run.ranking.substitutions.filter(isHitCapNote)).toEqual([]);
	});

	it('a Stop during a candidate read ends the run as a partial, uncached ranking with no failed-sim row', async () => {
		// Oracle: Stop makes the read reject with StopRefusedSim, which
		// runCandidate returns on, so 30907 is left to the Stop placeholder
		// (simmed: false) and is not dropped as a failed sim.
		const store = new MemoryStore();
		const controller = new AbortController();
		const reads = gearHitReads();
		const stopped = await runSpec({
			pool: S_POOL,
			store,
			controller,
			computeStats: req => {
				if (requestItems(req)[CHEST]?.id !== 30907) return reads(req);
				controller.abort();
				return new Promise<PlayerStatsObservation>(() => {});
			},
		});
		expect(controller.signal.aborted).toBe(true);
		expect(stopped.ranking.complete).toBe(false);
		expect(stopped.ranking.items.find(r => r.itemId === 30907)).toMatchObject({ simmed: false });
		expect(stopped.ranking.substitutions.filter(s => s.field === 'item 30907' || /item 30907/.test(`${s.detail}\n${s.error ?? ''}`))).toEqual([]);
		// No ranking was cached: a second run on the same store reads the hit
		// again instead of returning a stored ranking.
		const again = await runSpec({ pool: S_POOL, store, computeStats: reads });
		expect(again.statsRequests.length).toBeGreaterThan(0);
		expect(again.ranking.complete).toBe(true);
	});

	it("a code error beside a candidate read fails the run; it is not that candidate's failed sim", async () => {
		// Oracle: only the read's own failure becomes a failed-sim row. The
		// throw stands in for a bug in the request built for 30907's read,
		// after its swap; it must reach the caller unchanged.
		const bug = new TypeError('code bug');
		await expect(
			runSpec({
				pool: S_POOL,
				computeStats: gearHitReads(),
				simDatabaseFor: equipment => {
					if (equipment[CHEST]?.id === 30907) throw bug;
					return undefined;
				},
			}),
		).rejects.toBe(bug);
	});

	it("a candidate read that gives no hit number fails that candidate's sim, not the run", async () => {
		// Oracle: a hit value that is not a finite number is a failed read, so
		// turning it into a number must sit inside the read's catch. 30907 gets
		// the failed-sim row; Heartshatter is still ranked.
		const reads = gearHitReads();
		const run = await runSpec({
			pool: S_POOL,
			computeStats: req =>
				requestItems(req)[CHEST]?.id === 30907 ? Promise.resolve({ stats: [], pseudoStats: new Array<number>(25).fill(NaN) }) : reads(req),
		});
		expect(run.ranking.items.map(r => r.itemId)).toEqual([32365]);
		expect(run.ranking.substitutions.filter(s => s.field === 'item 30907')).toEqual([
			{
				field: 'item 30907',
				slot: 'chest',
				detail: 'This item was not ranked in this slot, because its sim failed.\nitem 30907, slot chest',
				error: 'hit percent read as NaN',
			},
		]);
	});
});
