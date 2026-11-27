import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { UIDatabase } from '@generated/proto/ui';
import { describe, expect, it, vi } from 'vitest';

import { characterFightKey, fightGearKey, RecordedGearSource } from '../testing/recorded_gear_source';
import { epWeightsFileFor } from './data/data';
import { getItem } from './engine/items';
import type { PoolEntry } from './engine/pool';
import { rankUpgrades } from './engine/rank';
import { type Progress, RankError } from './engine/rank-types';
import type { FightSummary } from './engine/seams/gear-source';
import type { PlayerStatsObservation, RaidSimRequest, SimObservation, SimRunner, SimRunOpts } from './engine/seams/sim-runner';
import { MemoryStore, type Store } from './engine/seams/store';
import { SET_KEPT_ID_OFFSET, SET_LESS_ID_OFFSET } from './engine/set-less-copies';
import { SIM_ORDER, type SimOrderName } from './engine/slots';
import { itemEpFor } from './item_ep';

/**
 * At `rankUpgrades`, a store read or write that fails stops the run with an `internal`
 * `RankError`, wherever in the run it happens. The database is the real
 * `assets/database/db.json`; the sim is a synthetic one.
 */

vi.mock('@sim/proto/database', async importOriginal => {
	const actual = await importOriginal<typeof import('@sim/proto/database')>();
	// Read here, not through `testing/db_pool`: that module imports this one, and the mock would wait on itself.
	const { UIDatabase } = await import('@generated/proto/ui');
	const dbPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../assets/database/db.json');
	const proto = UIDatabase.fromJson(JSON.parse(readFileSync(dbPath, 'utf8')), { ignoreUnknownFields: true });
	const db = new (actual.Database as unknown as new (proto: UIDatabase) => unknown)(proto);
	return { ...actual, Database: { getSync: () => db } };
});

// Malorne Harness (set 640) is worn in hands and legs; Thunderheart Harness (set 676)
// pieces and two non-set items are the candidates, so the set-bonus sims run.
const MALORNE = { hands: 29097, legs: 29099 } as const;
const THUNDERHEART = { head: 31039, shoulder: 31048, chest: 31042, hands: 31034, legs: 31044 } as const;
const NEUTRAL = { hands: 10140, legs: 8289 } as const;
const ITEM_DPS = new Map<number, number>([...Object.values(THUNDERHEART).map(id => [id, 100] as const), [NEUTRAL.hands, 120], [NEUTRAL.legs, 120]]);
const SET_BONUS_DPS: Record<number, { two: number; four: number }> = { 640: { two: 40, four: 70 }, 676: { two: 50, four: 80 } };

const ref = { region: 'US' as const, realm: 'synthetic', name: 'syn-feral' };
const summary: FightSummary = { reportCode: 'synthetic-feral', fightId: 1, encounterName: 'Synthetic feral', route: 'ranked', confidence: 1 };
const worn: Partial<Record<SimOrderName, number>> = { hands: MALORNE.hands, legs: MALORNE.legs };

const skeleton = {
	raid: {
		parties: [
			{
				players: [
					{
						name: 'synthetic',
						race: 'RaceNightElf',
						class: 'ClassDruid',
						talentsString: '-503032132322105301251-05503301',
						equipment: { items: [] },
						feralCatDruid: { options: { classOptions: {} } },
					},
				],
			},
		],
	},
	encounter: { duration: 180, targets: [{ level: 73 }] },
} as unknown as RaidSimRequest;

const pool: PoolEntry[] = [
	...(Object.entries(THUNDERHEART) as Array<[PoolEntry['slot'], number]>).map(([slot, itemId]) => ({ itemId, slot })),
	{ itemId: NEUTRAL.hands, slot: 'hands' as const },
	{ itemId: NEUTRAL.legs, slot: 'legs' as const },
].map(({ itemId, slot }) => ({ itemId, name: `item ${itemId}`, slot, phase: 1, source: { kind: 'badge' as const, cost: 1 } }));

function equippedIds(req: RaidSimRequest): number[] {
	const player = (req as { raid?: { parties?: Array<{ players?: Array<{ equipment?: { items?: Array<{ id?: number }> } }> }> } }).raid?.parties?.[0]
		?.players?.[0];
	return (player?.equipment?.items ?? []).map(item => item?.id ?? 0);
}

/** A DPS from the equipped ids and the set bonuses their set ids reach; calls `onRun` with the call count. */
class SyntheticSimRunner implements SimRunner {
	private calls = 0;
	constructor(private readonly onRun: (calls: number) => void = () => {}) {}
	async version(): Promise<string> {
		return 'synthetic-1';
	}
	async run(req: RaidSimRequest, opts: SimRunOpts): Promise<SimObservation> {
		this.onRun(++this.calls);
		let dps = 3000;
		const setCounts = new Map<number, number>();
		for (const sentId of equippedIds(req)) {
			if (!sentId) continue;
			// A copy keeps its item's stats; a set-less copy drops its set (set-less-copies.ts).
			const setLess = sentId >= SET_LESS_ID_OFFSET && sentId < SET_KEPT_ID_OFFSET;
			const id = sentId >= SET_KEPT_ID_OFFSET ? sentId - SET_KEPT_ID_OFFSET : setLess ? sentId - SET_LESS_ID_OFFSET : sentId;
			dps += ITEM_DPS.get(id) ?? 0;
			const setId = setLess ? undefined : getItem(id)?.setId;
			if (setId) setCounts.set(setId, (setCounts.get(setId) ?? 0) + 1);
		}
		for (const [setId, count] of setCounts) {
			const bonus = SET_BONUS_DPS[setId];
			if (bonus && count >= 2) dps += bonus.two;
			if (bonus && count >= 4) dps += bonus.four;
		}
		return { dps, stdev: 30, iterationsDone: opts.iterations, simVersion: 'synthetic-1' };
	}
	async computeStats(): Promise<PlayerStatsObservation> {
		return { stats: [], pseudoStats: new Array<number>(25).fill(0) };
	}
}

type StoreCall = {
	method: 'get' | 'put';
	key?: string;
	/** Candidate rows landed before this call, and whether the run had reached its ranking stage. */
	rowsLanded: number;
	afterRanking: boolean;
};

/** A `MemoryStore` that logs each call and fails the one numbered `faultAt` (from 1). */
class FaultingStore implements Store {
	readonly calls: StoreCall[] = [];
	rowsLanded = 0;
	afterRanking = false;
	private readonly inner = new MemoryStore();
	constructor(private readonly faultAt: number | undefined) {}

	private enter(method: StoreCall['method'], key?: string): void {
		this.calls.push({ method, ...(key !== undefined ? { key } : {}), rowsLanded: this.rowsLanded, afterRanking: this.afterRanking });
		if (this.calls.length === this.faultAt) throw new Error(`store fault at call ${this.faultAt}`);
	}

	async get<T>(key: string): Promise<T | undefined> {
		this.enter('get', key);
		return this.inner.get<T>(key);
	}
	async put<T>(key: string, value: T): Promise<void> {
		this.enter('put', key);
		return this.inner.put(key, value);
	}
}

/**
 * One cold run as the tab calls it (`model/run.ts`: set-bonus sims and the set screen
 * on), one sim at a time so the store calls come in a fixed order, with the store
 * failing call `faultAt`. With `stopAtSim`, Stop is pressed during that sim.
 */
async function runWithFault(faultAt?: number, stopAtSim?: number) {
	const store = new FaultingStore(faultAt);
	const controller = new AbortController();
	const onProgress = (p: Progress) => {
		if ('kind' in p && p.kind === 'row') store.rowsLanded++;
		else if ('stage' in p && p.stage === 'ranking') store.afterRanking = true;
	};
	const weights = epWeightsFileFor('feral');
	const outcome = await rankUpgrades(
		{ spec: 'feral', character: ref, maxPhase: 5, iterations: 3000 },
		{
			gear: new RecordedGearSource({
				fights: new Map([[characterFightKey(ref, 'feral'), [summary]]]),
				gear: new Map([
					[
						fightGearKey(summary),
						{
							items: SIM_ORDER.map(slot => ({ id: worn[slot] ?? 0, slot, gems: [] })),
							talentPointsByTree: [0, 44, 17],
							provenance: { reportCode: summary.reportCode, fightId: summary.fightId, sourceID: 1 },
						},
					],
				]),
			}),
			sim: new SyntheticSimRunner(calls => {
				if (calls === stopAtSim) controller.abort();
			}),
			store,
			clock: () => new Date('2026-11-22T00:00:00Z'),
			raidSimSkeleton: skeleton,
			epWeights: weights.weights,
			itemEp: itemEpFor(weights),
			pool,
			concurrency: 1,
			measureSetBonuses: true,
			setScreenMode: 'on',
			signal: controller.signal,
		},
		onProgress,
	).then(
		ranking => ({ ranking }),
		(error: unknown) => ({ error }),
	);
	return { calls: store.calls, outcome };
}

/** The store calls of a run with no fault, numbered from 1. */
async function cleanRunCalls(): Promise<Array<StoreCall & { n: number }>> {
	const { calls, outcome } = await runWithFault();
	if (!('ranking' in outcome)) throw new Error('the run with no fault failed');
	// The set-bonus sims ran: the run has the values they measure.
	expect(outcome.ranking.setBonuses?.length).toBeGreaterThan(0);
	expect(outcome.ranking.wornSetLadder?.length).toBeGreaterThan(0);
	return calls.map((call, i) => ({ ...call, n: i + 1 }));
}

/** For each call number: how the run with that call failing ended. */
async function outcomesWithFaultAt(ns: readonly number[]): Promise<Array<{ n: number; ended: string }>> {
	const out: Array<{ n: number; ended: string }> = [];
	for (const n of ns) {
		const { outcome } = await runWithFault(n);
		let ended: string;
		if ('ranking' in outcome) {
			ended = `ranked; notes: ${outcome.ranking.substitutions.map(s => `${s.field}: ${s.detail.split('\n')[0]}`).join(' | ')}`;
		} else if (outcome.error instanceof RankError) {
			ended = `RankError(${outcome.error.kind}): ${outcome.error.message}`;
		} else {
			ended = `${(outcome.error as Error)?.name ?? typeof outcome.error}: ${(outcome.error as Error)?.message ?? String(outcome.error)}`;
		}
		out.push({ n, ended });
	}
	return out;
}

const stoppedAsInternal = (n: number) => ({ n, ended: `RankError(internal): store fault at call ${n}` });

describe('rankUpgrades: a store read or write that fails', () => {
	it("in the run's own calls (the saved ranking) stops the run with an internal RankError", { timeout: 60_000 }, async () => {
		const own = (await cleanRunCalls()).filter(call => call.key?.startsWith('ranking:'));
		// The saved-ranking read and the ranking write.
		expect(own.map(call => call.method)).toEqual(['get', 'put']);
		const ns = own.map(call => call.n);
		expect(await outcomesWithFaultAt(ns)).toEqual(ns.map(stoppedAsInternal));
	});

	it('in a set-bonus sim stops the run with an internal RankError, not a note that the sim failed', { timeout: 60_000 }, async () => {
		const calls = await cleanRunCalls();
		const lastRow = Math.max(...calls.map(call => call.rowsLanded));
		// After the last candidate's row and before the ranking stage, every sim is a set-bonus sim.
		const setPhase = calls.filter(call => call.rowsLanded === lastRow && !call.afterRanking && call.key?.startsWith('sim:'));
		expect(setPhase.length).toBeGreaterThanOrEqual(10);
		const ns = setPhase.map(call => call.n);
		expect(await outcomesWithFaultAt(ns)).toEqual(ns.map(stoppedAsInternal));
	});

	it('at any store call of the run stops the run with an internal RankError', { timeout: 60_000 }, async () => {
		const calls = await cleanRunCalls();
		const ns = calls.map(call => call.n);
		expect(await outcomesWithFaultAt(ns)).toEqual(ns.map(stoppedAsInternal));
	});
});

describe('rankUpgrades: a run Stop cut short', () => {
	it('writes no saved ranking', async () => {
		// Stop during the third sim: the run returns the rows so far and saves no ranking.
		const stopped = await runWithFault(undefined, 3);
		if (!('ranking' in stopped.outcome)) throw new Error('the stopped run with no fault failed');
		expect(stopped.outcome.ranking.complete).toBe(false);
		expect(stopped.calls.filter(call => call.method === 'put' && call.key?.startsWith('ranking:'))).toEqual([]);
	});
});
