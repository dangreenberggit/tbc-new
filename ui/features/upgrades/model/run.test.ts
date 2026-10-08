import { Spec } from '@generated/proto/common';
import type { IndividualSimHost } from '@sim/sim_host';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RANKING_FIXTURE } from '../testing/ranking_fixture';
import { simDatabaseResolverFor } from './adapters/sim_database';
import { resetWorkerPoolForTests, type WorkerPoolSimRunner } from './adapters/worker_pool_sim_runner';
import { epWeightsFor, poolFor } from './data/data';
import type { Deps, PartialRanking, Progress, RankedItem, RankInput } from './engine/rank';
import { MemoryStore } from './engine/seams/store';
import { progressOf } from './progress_channel';
import { createRunContext, rankForPlayer, type RunContext, type RunDeps } from './run';

// The page adapters read a live sim page, which a unit test does not have; the
// engine itself is covered by the repo's E-W3 parity test. This test covers what
// the run model adds around the engine: where the runner comes from, the ticks,
// the landed rows, Stop and the duration, and the engine options it passes.
const { PAGE_SKELETON, pageDatabase } = vi.hoisted(() => ({ PAGE_SKELETON: { raid: 'page' }, pageDatabase: () => undefined }));
vi.mock('./adapters/skeleton', () => ({ currentPageSkeleton: () => PAGE_SKELETON }));
vi.mock('./adapters/sim_database', () => ({ simDatabaseResolverFor: vi.fn(() => pageDatabase) }));
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
});

const SETTINGS = { iterations: 500, candidateCap: 10 };

const depsFor = (overrides: Partial<RunDeps> = {}): RunDeps => {
	const context = fakeContext();
	return { signal: new AbortController().signal, onLanded: () => {}, runContext: () => context, ...overrides };
};

/** Emits each row as the engine does, then resolves the whole ranking. */
const streamRows = async ({ onProgress }: RankCall) => {
	onProgress?.({ stage: 'resolving' });
	for (const [i, row] of RANKING_FIXTURE.items.entries()) {
		onProgress?.({ stage: 'simming', done: i + 1, total: RANKING_FIXTURE.items.length });
		onProgress?.({ kind: 'row', row });
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

	// These options change the numbers and nothing else checks them: the engine is mocked here, and a
	// re-recorded fixture would pin whatever values a dropped option gives (review A1).
	it('ranks the page skeleton with its sim database and the spec’s EP weights, broken set bonuses measured and the set screen on', async () => {
		const host = fakeHost();
		await rankForPlayer(host, SETTINGS, depsFor());

		const [{ deps }] = rankCalls as [RankCall];
		expect(deps.raidSimSkeleton).toBe(PAGE_SKELETON);
		expect(simDatabaseResolverFor).toHaveBeenCalledWith(host.player, PAGE_SKELETON);
		expect(deps.simDatabaseFor).toBe(pageDatabase);
		expect(deps.epWeights).toBe(epWeightsFor('ret'));
		expect(deps.measureBrokenSetValue).toBe(true);
		expect(deps.setScreen).toBe('on');
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

	it('hands Stop to the engine as its signal, and resolves the partial ranking the engine returns with a duration', async () => {
		const partial: PartialRanking = { ...RANKING_FIXTURE, items: RANKING_FIXTURE.items.slice(0, 2), complete: false };
		rankBehaviour = ({ deps }) => new Promise(resolve => deps.signal?.addEventListener('abort', () => resolve(partial), { once: true }));
		const controller = new AbortController();
		const pending = rankForPlayer(fakeHost(), SETTINGS, depsFor({ signal: controller.signal }));
		await vi.waitFor(() => expect(rankCalls).toHaveLength(1));

		controller.abort();
		expect(await pending).toEqual({ ...partial, durationMs: expect.any(Number), runner: 'WorkerPoolSimRunner' });
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
		constructor() {
			FakeWorker.instances.push(this);
		}
		addEventListener() {}
		postMessage() {}
		terminate() {}
	}

	beforeEach(() => {
		FakeWorker.instances = [];
		vi.stubGlobal('Worker', FakeWorker);
		resetWorkerPoolForTests();
	});
	afterEach(() => vi.unstubAllGlobals());

	const ENV = { storageRead: () => null, hardwareConcurrency: 3, deviceMemoryGiB: undefined };

	it('builds one worker pool and one store', () => {
		const context = createRunContext(ENV);
		expect(FakeWorker.instances).toHaveLength(3);
		expect(context.store).toBeInstanceOf(MemoryStore);
		expect(context.simRunner.concurrency).toBe(3);
	});

	it('shares one worker pool between run contexts on the same page', () => {
		const first = createRunContext(ENV);
		const second = createRunContext(ENV);
		expect(FakeWorker.instances).toHaveLength(3);
		expect(second.store).not.toBe(first.store);
	});
});
