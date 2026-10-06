import { Spec } from '@generated/proto/common';
import type { IndividualSimHost } from '@sim/sim_host';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RANKING_FIXTURE } from '../testing/ranking_fixture';
import type { WorkerPoolSimRunner } from './adapters/worker_pool_sim_runner';
import { poolFor } from './data/data';
import type { Deps, PartialRanking, Progress, RankedItem, RankInput } from './engine/rank';
import { MemoryStore } from './engine/seams/store';
import { progressOf } from './progress_channel';
import { createRunContext, rankForPlayer, type RunContext, type RunDeps } from './run';

// The page adapters read a live sim page, which a unit test does not have; the
// engine itself is covered by the repo's E-W3 parity test. This test covers what
// the run model adds around the engine: where the runner comes from, the ticks,
// the landed rows, Stop and the duration.
vi.mock('./adapters/skeleton', () => ({ currentPageSkeleton: () => ({}) }));
vi.mock('./adapters/sim_database', () => ({ simDatabaseResolverFor: () => () => undefined }));
vi.mock('./adapters/player_gear_source', () => ({ PlayerGearSource: class {} }));

type RankCall = { input: RankInput; deps: Deps; onProgress?: (p: Progress) => void };
const rankCalls: RankCall[] = [];
let rankBehaviour: (call: RankCall) => Promise<typeof RANKING_FIXTURE | PartialRanking>;

vi.mock('./engine/rank', async importOriginal => ({
	...(await importOriginal<typeof import('./engine/rank')>()),
	rankUpgrades: (input: RankInput, deps: Deps, onProgress?: (p: Progress) => void) => {
		const call = { input, deps, onProgress };
		rankCalls.push(call);
		return rankBehaviour(call);
	},
}));

const fakeHost = (spec = Spec.SpecRetributionPaladin) =>
	({
		sim: { waitForInit: () => Promise.resolve(), getPhase: () => 3 },
		player: { getSpec: () => spec, getName: () => 'Tester' },
	}) as unknown as IndividualSimHost<Spec>;

const fakeContext = (): RunContext => ({
	simRunner: { concurrency: 2 } as unknown as WorkerPoolSimRunner,
	store: new MemoryStore(),
	terminate: vi.fn(),
});

const SETTINGS = { iterations: 500, candidateCap: 10 };

const depsFor = (overrides: Partial<RunDeps> = {}): RunDeps => {
	const context = fakeContext();
	return { signal: new AbortController().signal, onLanded: () => {}, runContext: () => context, ...overrides };
};

/** Emits each row as the engine does, then resolves the whole ranking, or a partial on Stop. */
const streamRows = async ({ deps, onProgress }: RankCall) => {
	onProgress?.({ stage: 'resolving' });
	const items: RankedItem[] = [];
	for (const [i, row] of RANKING_FIXTURE.items.entries()) {
		onProgress?.({ stage: 'simming', done: i + 1, total: RANKING_FIXTURE.items.length });
		onProgress?.({ kind: 'row', row });
		items.push(row);
		if (deps.signal?.aborted) return { ...RANKING_FIXTURE, items, complete: false as const };
		await Promise.resolve();
	}
	onProgress?.({ stage: 'ranking' });
	return RANKING_FIXTURE;
};

beforeEach(() => {
	rankCalls.length = 0;
	rankBehaviour = streamRows;
});

describe('rankForPlayer', () => {
	it('ranks with the runner, store and signal it was given, and resolves with the duration', async () => {
		const context = fakeContext();
		const signal = new AbortController().signal;
		const result = await rankForPlayer(fakeHost(), SETTINGS, depsFor({ signal, runContext: () => context }));

		expect(result).toMatchObject({ complete: true, items: RANKING_FIXTURE.items });
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
		const [{ input, deps }] = rankCalls as [RankCall];
		expect(deps.sim).toBe(context.simRunner);
		expect(deps.store).toBe(context.store);
		expect(deps.signal).toBe(signal);
		expect(deps.concurrency).toBe(2);
		expect(input).toMatchObject({ spec: 'ret', maxPhase: 3, iterations: 500, candidateCap: 10 });
	});

	it('hands every landed row to onLanded, in order', async () => {
		const landed: RankedItem[] = [];
		await rankForPlayer(fakeHost(), SETTINGS, depsFor({ onLanded: row => landed.push(row) }));
		expect(landed).toEqual(RANKING_FIXTURE.items);
	});

	it('ticks the progress channel as sims finish', async () => {
		const host = fakeHost();
		await rankForPlayer(host, SETTINGS, depsFor());
		expect(progressOf(host.player)).toMatchObject({ done: RANKING_FIXTURE.items.length, total: RANKING_FIXTURE.items.length });
	});

	it('resolves the partial ranking when Stop lands mid-run', async () => {
		const controller = new AbortController();
		let landed = 0;
		const onLanded = () => {
			landed += 1;
			if (landed === 2) controller.abort();
		};
		const result = await rankForPlayer(fakeHost(), SETTINGS, depsFor({ signal: controller.signal, onLanded }));

		expect(result.complete).toBe(false);
		expect(result.items).toHaveLength(2);
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
	});

	it('takes the run context before its first await, so an unmount after the click can end it', () => {
		const runContext = vi.fn(fakeContext);
		const pending = rankForPlayer(fakeHost(), SETTINGS, depsFor({ runContext }));
		expect(runContext).toHaveBeenCalledTimes(1);
		return pending;
	});

	it('uses the one context the tab keeps across two runs', async () => {
		let kept: RunContext | undefined;
		const build = vi.fn(fakeContext);
		const runContext = () => (kept ??= build());
		await rankForPlayer(fakeHost(), SETTINGS, depsFor({ runContext }));
		await rankForPlayer(fakeHost(), SETTINGS, depsFor({ runContext }));

		expect(build).toHaveBeenCalledTimes(1);
		expect(rankCalls[0]!.deps.sim).toBe(rankCalls[1]!.deps.sim);
		expect(rankCalls[0]!.deps.store).toBe(rankCalls[1]!.deps.store);
	});

	it('records that the worker pool measured the result', async () => {
		expect(await rankForPlayer(fakeHost(), SETTINGS, depsFor())).toMatchObject({ runner: 'WorkerPoolSimRunner' });
	});

	it('sims the whole pool when no setting narrows it', async () => {
		await rankForPlayer(fakeHost(), SETTINGS, depsFor());
		expect(rankCalls[0]!.deps.pool).toHaveLength(poolFor('ret', 3).length);
	});

	it('leaves an excluded raid’s items out of the pool it ranks', async () => {
		const dropsIn = (zone: string) => (e: { source: object; sources?: object[] }) => (e.sources ?? [e.source]).some(s => 'zone' in s && s.zone === zone);
		const full = poolFor('ret', 3);
		expect(full.some(dropsIn('Black Temple'))).toBe(true);

		await rankForPlayer(fakeHost(), { ...SETTINGS, excludedSources: ['Black Temple'] }, depsFor());
		const pool = rankCalls[0]!.deps.pool ?? [];
		expect(pool.length).toBeLessThan(full.length);
		// An item that also drops in a raid still ticked stays.
		expect(pool.filter(dropsIn('Black Temple')).every(e => (e.sources ?? []).some(s => 'zone' in s && s.zone !== 'Black Temple'))).toBe(true);
	});

	it('with prune, ranks only the selected sets’ items', async () => {
		const [a, b] = poolFor('ret', 3);
		await rankForPlayer(fakeHost(), { ...SETTINGS, guaranteedSetItemIds: [a!.itemId, b!.itemId], prune: true }, depsFor());
		expect((rankCalls[0]!.deps.pool ?? []).map(e => e.itemId)).toEqual([a!.itemId, b!.itemId]);
	});

	it('refuses a spec it has no data for', async () => {
		await expect(rankForPlayer(fakeHost(Spec.SpecProtectionWarrior), SETTINGS, depsFor())).rejects.toMatchObject({
			name: 'RankError',
			kind: 'not-implemented',
		});
		expect(rankCalls).toHaveLength(0);
	});
});

describe('createRunContext', () => {
	class FakeWorker {
		static instances: FakeWorker[] = [];
		terminated = false;
		constructor() {
			FakeWorker.instances.push(this);
		}
		addEventListener() {}
		postMessage() {}
		terminate() {
			this.terminated = true;
		}
	}

	beforeEach(() => {
		FakeWorker.instances = [];
		vi.stubGlobal('Worker', FakeWorker);
	});
	afterEach(() => vi.unstubAllGlobals());

	const ENV = { storageRead: () => null, hardwareConcurrency: 3, deviceMemoryGiB: undefined };

	it('builds one worker pool and one store', () => {
		const context = createRunContext(ENV);
		expect(FakeWorker.instances).toHaveLength(3);
		expect(context.store).toBeInstanceOf(MemoryStore);
		expect(context.simRunner.concurrency).toBe(3);
	});

	it('ends every worker on terminate', () => {
		createRunContext(ENV).terminate();
		expect(FakeWorker.instances.every(worker => worker.terminated)).toBe(true);
	});
});
