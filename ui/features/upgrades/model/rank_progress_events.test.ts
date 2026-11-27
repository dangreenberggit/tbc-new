/**
 * The run progress tracker against the events the real engine sends.
 *
 * Drives `rankUpgrades` with a controlled sim and the engine's default seeds,
 * the way the tab calls it (no `seeds`), on a seven- and a twelve-candidate
 * pool, a pool where no row clears the cutoff, a capped pool and pools with
 * rings and trinkets, and checks the tracker's set-phase boundary, activities
 * and replication count, and that each run ends on `done === total`. The
 * tracker's own arithmetic, on hand-built events, is in `run_progress.test.ts`.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { statsOnlyItemEp, zeroHitStats } from '../testing/engine_fakes';
import feralSkeleton from '../testing/feral_p2.skeleton.json';
import { characterFightKey, fightGearKey, RecordedGearSource } from '../testing/recorded_gear_source';
import { epWeightsFor } from './data/data';
import { getItem } from './engine/items';
import type { ItemSlot, PoolEntry } from './engine/pool';
import { type Deps, type Progress, type RankInput, rankUpgrades } from './engine/rank';
import { PAIRED_REPLICATE_TOP_N } from './engine/se';
import type { RaidSimRequest, SimObservation, SimRunner } from './engine/seams/sim-runner';
import { MemoryStore } from './engine/seams/store';
import { SIM_ORDER, type SimOrderName } from './engine/slots';
import { doneAtLastCandidateFor, type RunActivity, RunProgressTracker, TAB_REPLICATE_SEED_COUNT } from './run_progress';

// The engine reads items and gems through `Database.getSync()`; the real class over the test database stands in for the page's.
vi.mock('@sim/proto/database', importOriginal => import('../testing/database_mock').then(m => m.withTestDatabase(importOriginal)));

const SIM_VERSION = 'v0.0.101';
const BASE_DPS = 3000;
const topN = PAIRED_REPLICATE_TOP_N;

// Real set-piece ids (Thunderheart Harness 676, Malorne Harness 640).
const THUNDERHEART = {
	head: 31039,
	shoulder: 31048,
	chest: 31042,
	hands: 31034,
	legs: 31044,
} as const;
const MALORNE = { hands: 29097, legs: 29099 } as const;
// Non-set items, so a candidate can replace a Malorne piece.
const NEUTRAL = { hands: 10140, legs: 8289 } as const;
// Five more pieces for slots nothing is worn in, so a pool can hold more
// candidates than PAIRED_REPLICATE_TOP_N (Thunderheart Wristguards,
// Waistguard and Treads; Primalstrike Bracers and Belt).
const EXTRA = [
	{ itemId: 34444, slot: 'wrist' },
	{ itemId: 34556, slot: 'waist' },
	{ itemId: 34573, slot: 'feet' },
	{ itemId: 29527, slot: 'wrist' },
	{ itemId: 29526, slot: 'waist' },
] as const;

const ITEM_VALUE = new Map<number, number>([
	...Object.values(THUNDERHEART).map(id => [id, 100] as const),
	[NEUTRAL.hands, 120],
	[NEUTRAL.legs, 120],
	...EXTRA.map(p => [p.itemId, 100] as const),
]);

/** A pool entry's slot: a sim slot, or a ring's or trinket's, which has two. */
type PoolSlot = { itemId: number; slot: ItemSlot };

const SMALL_POOL: readonly PoolSlot[] = [
	...(['head', 'shoulder', 'chest', 'hands', 'legs'] as const).map(slot => ({
		itemId: THUNDERHEART[slot],
		slot,
	})),
	{ itemId: NEUTRAL.hands, slot: 'hands' },
	{ itemId: NEUTRAL.legs, slot: 'legs' },
];
const LARGE_POOL: readonly PoolSlot[] = [...SMALL_POOL, ...EXTRA];
// Rings and trinkets, each one candidate with two slots, so two sims
// (Shapeshifter's Signet, Garona's Signet Ring, Dragonspine Trophy,
// Bloodlust Brooch), and the small pool's one-slot candidates.
const TWO_SLOT: readonly PoolSlot[] = [
	{ itemId: 30834, slot: 'finger' },
	{ itemId: 28649, slot: 'finger' },
	{ itemId: 28830, slot: 'trinket' },
	{ itemId: 29383, slot: 'trinket' },
];
const MIXED_POOL: readonly PoolSlot[] = [...TWO_SLOT, ...SMALL_POOL];
const MIXED_VALUE = new Map<number, number>([...ITEM_VALUE, ...TWO_SLOT.map(p => [p.itemId, 100] as const)]);
const SET_BONUSES: Record<number, { b2: number; b4: number }> = {
	676: { b2: 50, b4: 80 },
	640: { b2: 40, b4: 70 },
};

const feralWeights = epWeightsFor('feral');

function equippedIds(req: RaidSimRequest): number[] {
	const raid = (req as { raid?: { parties?: unknown[] } }).raid;
	const party = raid?.parties?.[0] as { players?: unknown[] } | undefined;
	const player = party?.players?.[0] as { equipment?: { items?: Array<{ id?: number }> } } | undefined;
	return (player?.equipment?.items ?? []).map(i => i?.id ?? 0);
}

const FERAL_CHAR = { region: 'US' as const, realm: 'test', name: 'progress' };
const FERAL_SUMMARY = {
	reportCode: 'prog001',
	fightId: 1,
	encounterName: 'Test Dummy',
	killedAt: '2026-10-03T00:00:00.000Z',
	route: 'ranked' as const,
	confidence: 1,
};

type RecordedEvent = { progress: Progress; simCallsSoFar: number };

/**
 * What every run here shares: Malorne 2pc worn in hands and legs, the pool
 * given, the broken-bonus measurement on, and no `seeds`, as the tab calls
 * it. The worn gear holds no meta, so the baseline's is the only stats read
 * and it moves no gem. `candidateCap` defaults to 100, more than any pool
 * here, so only a run that passes a smaller one is capped. `dpsOf` is the
 * sim's answer: the base, each worn item's value and the set bonuses.
 */
function feralRun(
	poolSlots: readonly PoolSlot[],
	candidateCap = 100,
): {
	input: RankInput;
	deps: Omit<Deps, 'sim' | 'store'>;
	dpsOf: (req: RaidSimRequest, value: ReadonlyMap<number, number>) => number;
} {
	const worn: Partial<Record<SimOrderName, number>> = {
		hands: MALORNE.hands,
		legs: MALORNE.legs,
	};
	const fightRef = {
		reportCode: FERAL_SUMMARY.reportCode,
		fightId: FERAL_SUMMARY.fightId,
	};
	const gearSource = new RecordedGearSource({
		fights: new Map([[characterFightKey(FERAL_CHAR, 'feral'), [FERAL_SUMMARY]]]),
		gear: new Map([
			[
				fightGearKey(fightRef),
				{
					items: SIM_ORDER.map(slot => ({
						id: worn[slot] ?? 0,
						slot,
						gems: [],
					})),
					talentPointsByTree: [0, 45, 16] as [number, number, number],
					provenance: { ...fightRef, sourceID: 1 },
				},
			],
		]),
	});

	const pool: PoolEntry[] = poolSlots.map(p => ({
		...p,
		name: `item ${p.itemId}`,
		phase: 1,
		source: { kind: 'badge' as const, cost: 1 },
	}));

	const dpsOf = (req: RaidSimRequest, value: ReadonlyMap<number, number>) => {
		let dps = BASE_DPS;
		const setCounts = new Map<number, number>();
		for (const id of equippedIds(req)) {
			if (!id) continue;
			dps += value.get(id) ?? 0;
			const setId = getItem(id)?.setId;
			if (setId != null) setCounts.set(setId, (setCounts.get(setId) ?? 0) + 1);
		}
		for (const [setId, count] of setCounts) {
			const bonus = SET_BONUSES[setId];
			if (!bonus) continue;
			if (count >= 2) dps += bonus.b2;
			if (count >= 4) dps += bonus.b4;
		}
		return dps;
	};

	return {
		input: {
			character: FERAL_CHAR,
			spec: 'feral',
			maxPhase: 5,
			fight: fightRef,
			iterations: 3000,
			candidateCap,
		},
		deps: {
			gear: gearSource,
			clock: () => new Date('2026-10-03T12:00:00.000Z'),
			raidSimSkeleton: feralSkeleton as RaidSimRequest,
			epWeights: feralWeights,
			itemEp: statsOnlyItemEp(feralWeights),
			pool,
			measureSetBonuses: true,
		},
		dpsOf,
	};
}

/**
 * One run on `feralRun`'s setup, with a sim that answers at once: cold, unless
 * it is given the store an earlier run filled.
 */
async function recordRun(
	candidateValue: ReadonlyMap<number, number> = ITEM_VALUE,
	poolSlots: readonly PoolSlot[] = SMALL_POOL,
	{ candidateCap = 100, store }: { candidateCap?: number; store?: MemoryStore } = {},
): Promise<RecordedEvent[]> {
	const run = feralRun(poolSlots, candidateCap);
	let simCalls = 0;
	const fakeSim: SimRunner = {
		version: () => Promise.resolve(SIM_VERSION),
		computeStats: zeroHitStats,
		run: (req, opts) => {
			simCalls += 1;
			return Promise.resolve({
				dps: run.dpsOf(req, candidateValue),
				stdev: 30,
				iterationsDone: opts.iterations,
				simVersion: SIM_VERSION,
			});
		},
	};

	const events: RecordedEvent[] = [];
	await rankUpgrades(run.input, { ...run.deps, sim: fakeSim, store: store ?? new MemoryStore() }, progress =>
		events.push({ progress, simCallsSoFar: simCalls }),
	);
	return events;
}

describe('run progress event order', () => {
	// Seven candidates take the small-pool branch of `doneAtLastCandidateFor`.
	// Twelve, all above the cutoff, take the large-pool branch and pass the
	// top-N cap on re-simmed rows.
	const recordings: Record<'seven' | 'twelve', RecordedEvent[]> = {
		seven: [],
		twelve: [],
	};
	const pools = ['seven', 'twelve'] as const;
	let zeroQualifyEvents: RecordedEvent[];
	const CAPPED_CANDIDATES = 4;
	let cappedEvents: RecordedEvent[];
	let mixedEvents: RecordedEvent[];
	let storedEvents: RecordedEvent[];

	beforeAll(async () => {
		recordings.seven = await recordRun();
		recordings.twelve = await recordRun(ITEM_VALUE, LARGE_POOL);
		// Every candidate loses 50 DPS, so no row clears the cutoff.
		zeroQualifyEvents = await recordRun(new Map([...ITEM_VALUE.keys()].map(id => [id, -50] as const)));
		// Capped at four of twelve, and the Thunderheart chest loses DPS, so
		// fewer rows clear the cutoff than the cap or top-N.
		cappedEvents = await recordRun(new Map([...ITEM_VALUE, [THUNDERHEART.chest, -50]]), LARGE_POOL, { candidateCap: CAPPED_CANDIDATES });
		mixedEvents = await recordRun(MIXED_VALUE, MIXED_POOL);
		// The small pool's sims fill a store; the mixed pool then finds them
		// there, so only the rings and trinkets run sims.
		const store = new MemoryStore();
		await recordRun(MIXED_VALUE, SMALL_POOL, { store });
		storedEvents = await recordRun(MIXED_VALUE, MIXED_POOL, { store });
	}, 240_000);

	const stageEvents = (from: RecordedEvent[]) =>
		from.filter(
			(
				e,
			): e is RecordedEvent & {
				progress: Exclude<Progress, { kind: 'row' }>;
			} => !('kind' in e.progress),
		);
	const rankingIndex = (from: RecordedEvent[]) => stageEvents(from).findIndex(e => e.progress.stage === 'ranking');
	const simmingAfterRanking = (from: RecordedEvent[]) =>
		stageEvents(from)
			.slice(rankingIndex(from) + 1)
			.filter(e => e.progress.stage === 'simming');
	const simmingBeforeRanking = (from: RecordedEvent[]) =>
		stageEvents(from)
			.slice(0, rankingIndex(from))
			.filter(e => e.progress.stage === 'simming');
	const landedRows = (from: RecordedEvent[]) =>
		from
			.map(e => e.progress)
			.filter((p): p is Extract<Progress, { kind: 'row' }> => 'kind' in p && p.kind === 'row')
			.map(p => p.row as { belowCutoff?: boolean; simmed?: boolean; owned?: boolean });
	/** Rows replication can re-sim: rank-replication.ts `replicateTopItems`' filter. */
	const replicableRowCount = (from: RecordedEvent[]) => landedRows(from).filter(r => r.belowCutoff === false && r.simmed !== false).length;

	/** Feeds a recording to a tracker; returns it and the activities it named. */
	const replay = (from: RecordedEvent[]) => {
		const tracker = new RunProgressTracker();
		tracker.setConcurrency(1);
		const activities: RunActivity[] = [tracker.view().activity];
		from.forEach((e, i) => {
			tracker.observe(e.progress, (i + 1) * 100);
			const activity = tracker.view().activity;
			if (activities[activities.length - 1] !== activity) activities.push(activity);
		});
		return { tracker, activities };
	};

	it('records one pool within top-N and one past it, with more rows above the cutoff than top-N', () => {
		// The first event before `ranking` is the baseline; each later one is
		// one candidate.
		expect(simmingBeforeRanking(recordings.seven).length - 1).toBeLessThanOrEqual(topN);
		expect(simmingBeforeRanking(recordings.twelve).length - 1).toBeGreaterThan(topN);
		const aboveCutoff = landedRows(recordings.twelve).filter(r => r.belowCutoff === false && r.simmed !== false);
		expect(aboveCutoff.length).toBeGreaterThan(topN);
	});

	it.each(pools)("solves the set-phase boundary from the engine's first total with the tab's seed count (%s candidates)", name => {
		const from = recordings[name];
		expect(rankingIndex(from)).toBeGreaterThan(0);
		const sims = simmingBeforeRanking(from);
		const first = sims[0]!.progress as { done: number; total: number };
		const last = sims[sims.length - 1]!.progress as { done: number };
		const candidates = sims.length - 1;
		expect(candidates).toBeGreaterThan(0);
		expect(doneAtLastCandidateFor(first.total, TAB_REPLICATE_SEED_COUNT, topN)).toBe(last.done);
		expect(last.done).toBe(1 + candidates);
	});

	it('runs set-phase sims between the last candidate event and ranking', () => {
		const from = recordings.seven;
		const sims = simmingBeforeRanking(from);
		const lastCandidate = sims[sims.length - 1]!;
		const ranking = stageEvents(from)[rankingIndex(from)]!;
		expect(ranking.simCallsSoFar).toBeGreaterThan(lastCandidate.simCallsSoFar);
	});

	it.each(pools)('counts replication sims after ranking, above the boundary (%s candidates)', name => {
		const from = recordings[name];
		const sims = simmingBeforeRanking(from);
		const first = sims[0]!.progress as { total: number };
		const boundary = (sims[sims.length - 1]!.progress as { done: number }).done;
		const after = simmingAfterRanking(from).map(e => e.progress as { done: number; total: number });
		expect(after.length).toBeGreaterThan(1);
		// The first event after ranking restates the total and runs no sim: it
		// repeats the boundary and names the done the run ends on.
		const [restated, ...replicas] = after;
		expect(restated!.done).toBe(boundary);
		expect(restated!.total).toBe(after[after.length - 1]!.done);
		for (const p of replicas) {
			expect(p.done).toBeGreaterThan(boundary);
			expect(p.done).toBeLessThanOrEqual(first.total);
		}
	});

	it.each(pools)('gives the tracker the activities preparing, candidates, set bonuses, replication, ranking (%s candidates)', name => {
		// The run ends on the done the tracker expects, so the last
		// replication sim names the final ranking.
		expect(replay(recordings[name]).activities).toEqual(['preparing', 'candidates', 'set-bonuses', 'replication', 'ranking']);
	});

	it.each(pools)('re-sims the baseline and each row the tracker counts, at most top-N (%s candidates)', name => {
		const from = recordings[name];
		const q = replay(from).tracker.view().replicableRowCount;
		expect(q).toBeGreaterThan(0);
		// The first event after ranking restates the total; the rest are sims.
		expect(simmingAfterRanking(from).slice(1)).toHaveLength((TAB_REPLICATE_SEED_COUNT - 1) * (1 + Math.min(topN, q)));
	});

	it('runs no replication when no row qualifies, and the tracker expects none', () => {
		const landed = landedRows(zeroQualifyEvents);
		expect(landed.length).toBeGreaterThan(0);
		for (const r of landed) expect(r.belowCutoff).toBe(true);
		expect(rankingIndex(zeroQualifyEvents)).toBeGreaterThan(0);
		// One event restates the total as the done so far; no sim follows it.
		const before = simmingBeforeRanking(zeroQualifyEvents);
		const boundary = (before[before.length - 1]!.progress as { done: number }).done;
		const after = simmingAfterRanking(zeroQualifyEvents);
		expect(after.map(e => e.progress)).toEqual([{ stage: 'simming', done: boundary, total: boundary }]);
		const ranking = stageEvents(zeroQualifyEvents)[rankingIndex(zeroQualifyEvents)]!;
		expect(zeroQualifyEvents[zeroQualifyEvents.length - 1]!.simCallsSoFar).toBe(ranking.simCallsSoFar);

		const { tracker, activities } = replay(zeroQualifyEvents);
		expect(activities).toEqual(['preparing', 'candidates', 'set-bonuses', 'ranking']);
		expect(tracker.view().remainingMs).toBeUndefined();
	});

	it('caps the candidates and has fewer rows above the cutoff than the cap', () => {
		const candidates = simmingBeforeRanking(cappedEvents).length - 1;
		const owned = landedRows(cappedEvents).filter(r => r.owned).length;
		expect(candidates).toBe(CAPPED_CANDIDATES + owned);
		const q = replicableRowCount(cappedEvents);
		expect(q).toBeGreaterThan(0);
		expect(q).toBeLessThan(CAPPED_CANDIDATES);
		expect(q).toBeLessThan(topN);
	});

	it.each([
		['seven', () => recordings.seven],
		['twelve', () => recordings.twelve],
		['zero-qualify', () => zeroQualifyEvents],
		['capped', () => cappedEvents],
		['rings and trinkets', () => mixedEvents],
		['rings and trinkets, the rest from the store', () => storedEvents],
	] as const)("sends the candidates' sims with each of the candidates' events, ending on the sims the runner ran for them (%s)", (_name, from) => {
		const events = from();
		const candidates = simmingBeforeRanking(events);
		const first = candidates[0]!;
		const last = candidates[candidates.length - 1]!;
		const sims = (e: RecordedEvent) => (e.progress as { candidateSims?: number }).candidateSims;
		for (const e of candidates) expect(sims(e)).toEqual(expect.any(Number));
		expect(sims(last)).toBe(last.simCallsSoFar - first.simCallsSoFar);
	});

	it('plans one sim per slot of a ring or trinket, and takes out the sims the store answers', () => {
		const sims = (from: RecordedEvent[]) => simmingBeforeRanking(from).map(e => (e.progress as { candidateSims: number }).candidateSims);
		// Seven one-slot candidates and four of two slots: 15 sims planned.
		// The Thunderheart head's meta repair fails, so its slot runs none.
		expect(sims(mixedEvents)[0]).toBe(15);
		expect(sims(mixedEvents).at(-1)).toBe(14);
		// The same 15 planned; the store answers the six one-slot sims the
		// small pool ran, and the head's repair fails again.
		expect(sims(storedEvents)[0]).toBe(15);
		expect(sims(storedEvents).at(-1)).toBe(8);
	});

	it("prices the candidates by the runner's own sims, so a ring's or trinket's first sim keeps its credit", async () => {
		// Four workers, each sim 1 s, reported every 100 ms, as the runner
		// reports a sim's iterations (`worker_pool_sim_runner.ts`).
		const CONCURRENCY = 4;
		const SIM_MS = 1_000;
		const STEP_MS = 100;
		const run = feralRun(MIXED_POOL);
		const tracker = new RunProgressTracker();
		tracker.setConcurrency(CONCURRENCY);
		let now = 0;
		type Running = {
			id: string;
			startedAt: number;
			iterations: number;
			end: () => void;
		};
		const running: Running[] = [];
		const runnerSims: Array<{ startedAt: number; endedAt?: number }> = [];
		let simCount = 0;
		let inCandidates = false;
		let planned: number | undefined;
		let latest: number | undefined;
		const fakeSim: SimRunner = {
			version: () => Promise.resolve(SIM_VERSION),
			computeStats: zeroHitStats,
			run: (req, opts) =>
				new Promise<SimObservation>(resolve => {
					const id = `sim${simCount++}`;
					const sim: { startedAt: number; endedAt?: number } = {
						startedAt: now,
					};
					if (inCandidates) runnerSims.push(sim);
					tracker.observeIterations(id, 0, opts.iterations, now);
					running.push({
						id,
						startedAt: now,
						iterations: opts.iterations,
						end: () => {
							sim.endedAt = now;
							resolve({
								dps: run.dpsOf(req, MIXED_VALUE),
								stdev: 30,
								iterationsDone: opts.iterations,
								simVersion: SIM_VERSION,
							});
						},
					});
				}),
		};
		const onProgress = (p: Progress) => {
			tracker.observe(p, now);
			if ('kind' in p || p.stage !== 'simming') return;
			if (planned === undefined) {
				planned = p.candidateSims;
				inCandidates = true;
			} else if (p.done === 1 + MIXED_POOL.length) inCandidates = false;
			if (inCandidates) latest = p.candidateSims;
		};

		const settle = () => new Promise<void>(r => setImmediate(r));
		let finished = false;
		const ranking = rankUpgrades(
			run.input,
			{
				...run.deps,
				sim: fakeSim,
				store: new MemoryStore(),
				concurrency: CONCURRENCY,
			},
			onProgress,
		).finally(() => {
			finished = true;
		});
		await settle();
		const samples: Array<{
			now: number;
			shown: number | undefined;
			size: number;
		}> = [];
		for (let guard = 0; !finished; guard++) {
			if (guard > 10_000) throw new Error('the run did not end');
			now += STEP_MS;
			const due = running.filter(r => now - r.startedAt >= SIM_MS);
			for (const r of running) {
				if (!due.includes(r)) tracker.observeIterations(r.id, ((now - r.startedAt) / SIM_MS) * r.iterations, r.iterations, now);
			}
			for (const r of due) {
				running.splice(running.indexOf(r), 1);
				// The worker's last report and the runner's own both say it ended.
				tracker.observeIterations(r.id, r.iterations, r.iterations, now);
				tracker.observeIterations(r.id, r.iterations, r.iterations, now);
				r.end();
			}
			await settle();
			if (inCandidates)
				samples.push({
					now,
					shown: tracker.view().remainingMs,
					size: latest!,
				});
		}
		await ranking;

		// 15 sims planned; the head's meta repair fails as it is dispatched, so
		// the count the engine sends drops to the 14 the runner ran.
		expect(planned).toBe(15);
		expect(runnerSims).toHaveLength(14);
		expect(samples.at(-1)!.size).toBe(14);
		const startedAt = runnerSims[0]!.startedAt;
		// wowsims' rule on the runner's own sims: a sim that ended counts as
		// one, one under way by its share (`progress.ts:60-67`).
		const rule = (at: number, size: number) => {
			const done = runnerSims.reduce(
				(sum, s) => sum + (s.endedAt !== undefined && s.endedAt <= at ? 1 : Math.max(0, Math.min(1, (at - s.startedAt) / SIM_MS))),
				0,
			);
			return ((at - startedAt) / done) * (size - done);
		};
		// The candidates' sims start after the baseline's, which starts their
		// clock: no figure at that first sample, then one at every sample.
		const [first, ...rest] = samples;
		expect(first!.now).toBe(startedAt);
		expect(first!.shown).toBeUndefined();
		expect(rest.length).toBeGreaterThan(10);
		for (const s of rest) {
			expect(s.shown).toBeDefined();
			expect(s.shown!).toBeCloseTo(rule(s.now, s.size), 3);
		}
		// So the figure never rises while the candidates run.
		for (let i = 1; i < rest.length; i++) expect(rest[i]!.shown!).toBeLessThanOrEqual(rest[i - 1]!.shown! + 1e-6);
	});

	// The first total budgets re-sims for min(top-N, candidates) rows; the run
	// re-sims only the rows that clear the cutoff, so the engine restates the
	// total and the counter must end on it.
	it.each([
		['seven', () => recordings.seven],
		['twelve', () => recordings.twelve],
		['zero-qualify', () => zeroQualifyEvents],
		['capped', () => cappedEvents],
	] as const)('ends with done equal to total (%s)', (_name, from) => {
		const events = from();
		const sims = stageEvents(events)
			.filter(e => e.progress.stage === 'simming')
			.map(e => e.progress as { done: number; total: number });
		const last = sims[sims.length - 1]!;
		expect(last.done).toBe(last.total);
		const candidates = simmingBeforeRanking(events).length - 1;
		const rows = Math.min(topN, replicableRowCount(events));
		expect(last.total).toBe(1 + candidates + (rows === 0 ? 0 : (TAB_REPLICATE_SEED_COUNT - 1) * (1 + rows)));
	});
});
