import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RaidSimRequest } from '../engine/seams/sim-runner';

// A unit test starts no sim workers, so the pool answers the stats call and the sim itself.
const computeStats = vi.fn();
const raidSimAsync = vi.fn();
vi.mock('@sim/workers/worker_pool', async importOriginal => ({
	...(await importOriginal<typeof import('@sim/workers/worker_pool')>()),
	WorkerPool: class {
		computeStats = computeStats;
		raidSimAsync = raidSimAsync;
		getNumWorkers = () => 1;
		setNumWorkers = () => {};
	},
}));

const { DEFAULT_WORKER_COUNT, memoryCapFromDeviceMemory, resetWorkerPoolForTests, workerCountFor, WorkerPoolSimRunner } =
	await import('./worker_pool_sim_runner');
type RunnerEnv = import('./worker_pool_sim_runner').RunnerEnv;

const env = (stored: string | null, overrides: Partial<RunnerEnv> = {}): RunnerEnv => ({
	storageRead: () => stored,
	hardwareConcurrency: 16,
	deviceMemoryGiB: 64,
	...overrides,
});

describe('workerCountFor', () => {
	it('treats no choice as the default, capped by the cores', () => {
		expect(workerCountFor(env(null))).toBe(DEFAULT_WORKER_COUNT);
		expect(workerCountFor(env(null, { hardwareConcurrency: 3 }))).toBe(3);
	});

	it('gives the default, uncapped, when the setting cannot be read', () => {
		const throwing = env(null, {
			storageRead: () => {
				throw new Error('storage blocked');
			},
		});
		expect(workerCountFor(throwing)).toBe(DEFAULT_WORKER_COUNT);
		expect(workerCountFor(env('"many"', { hardwareConcurrency: 2 }))).toBe(DEFAULT_WORKER_COUNT);
	});

	it('gives one worker for Off and for one', () => {
		expect(workerCountFor(env('0'))).toBe(1);
		expect(workerCountFor(env('1'))).toBe(1);
	});

	it('caps a larger choice by the cores and the memory, with a floor of two', () => {
		expect(workerCountFor(env('6'))).toBe(6);
		expect(workerCountFor(env('6', { hardwareConcurrency: 3 }))).toBe(3);
		expect(workerCountFor(env('6', { hardwareConcurrency: 1 }))).toBe(2);
		expect(workerCountFor(env('6', { deviceMemoryGiB: 1 }))).toBe(2);
		// A browser with no memory figure gets the default as its memory cap.
		expect(workerCountFor(env('6', { deviceMemoryGiB: undefined }))).toBe(memoryCapFromDeviceMemory(undefined));
	});
});

describe('WorkerPoolSimRunner.activeSetBonuses', () => {
	const request = { raid: { parties: [] }, encounter: { duration: 180 } } as unknown as RaidSimRequest;
	const answer = (over: Record<string, unknown>) => ({ errorResult: '', ...over });

	beforeEach(() => {
		computeStats.mockReset();
		resetWorkerPoolForTests();
	});

	it("gives the first player's active set bonuses from the stats call, sent with the request's raid and encounter", async () => {
		computeStats.mockResolvedValue(
			answer({ raidStats: { parties: [{ players: [{ sets: ['Thunderheart Harness (2pc)', 'Thunderheart Harness (4pc)'] }] }] } }),
		);
		const names = await new WorkerPoolSimRunner(1).activeSetBonuses(request);
		expect(names).toEqual(['Thunderheart Harness (2pc)', 'Thunderheart Harness (4pc)']);
		expect(computeStats).toHaveBeenCalledTimes(1);
		expect(computeStats.mock.calls[0]![0]).toMatchObject({ raid: { parties: [] }, encounter: { duration: 180 } });
	});

	it('rejects when the stats call reports an error, or names no player', async () => {
		const runner = new WorkerPoolSimRunner(1);
		computeStats.mockResolvedValueOnce(answer({ errorResult: 'bad gear' }));
		await expect(runner.activeSetBonuses(request)).rejects.toThrow('computeStats error: bad gear');
		computeStats.mockResolvedValueOnce(answer({ raidStats: { parties: [] } }));
		await expect(runner.activeSetBonuses(request)).rejects.toThrow('no first player');
	});
});

describe('WorkerPoolSimRunner.run', () => {
	beforeEach(() => {
		raidSimAsync.mockReset();
		resetWorkerPoolForTests();
	});

	it("gives the first player's spell damage by school, without melee actions or pets", async () => {
		const action = (spellSchool: number, damages: number[], isMelee = false) => ({
			isMelee,
			spellSchool,
			targets: damages.map(damage => ({ damage })),
		});
		raidSimAsync.mockResolvedValue({
			iterationsDone: 10,
			raidMetrics: {
				dps: { avg: 1000, stdev: 5 },
				parties: [
					{
						players: [
							{
								actions: [action(32, [600, 100]), action(32, [300]), action(64, [100]), action(1, [50], true), action(4, [0])],
								pets: [{ actions: [action(4, [999])] }],
							},
						],
					},
				],
			},
		});
		const request = { raid: { parties: [] }, encounter: { duration: 180 } } as unknown as RaidSimRequest;
		const observation = await new WorkerPoolSimRunner(1).run(request, { seed: 1, iterations: 10 });
		expect(observation.spellDamageBySchool).toEqual({ 32: 1000, 64: 100 });
	});
	describe('iterations done (tickets 897, 898)', () => {
		const request = { raid: { parties: [] }, encounter: { duration: 180 } } as unknown as RaidSimRequest;
		const result = { iterationsDone: 1000, raidMetrics: { dps: { avg: 1000, stdev: 5 }, parties: [] } };
		// The pool reports a sim's iterations as wowsims' Bulk sim reads them (`features/bulk/model/progress.ts:46-67`).
		const reporting = (answer: unknown) => async (_request: unknown, onProgress: (p: { completedIterations: number; totalIterations: number }) => void) => {
			onProgress({ completedIterations: 400, totalIterations: 1000 });
			onProgress({ completedIterations: 900, totalIterations: 1000 });
			return answer;
		};
		const requestIdOf = (call: number) => (raidSimAsync.mock.calls[call]![0] as { requestId: string }).requestId;

		it('tells a listener how far each sim has got, by its request id, and that it ended', async () => {
			raidSimAsync.mockImplementation(reporting(result));
			const runner = new WorkerPoolSimRunner(1);
			const heard: Array<[string, number, number]> = [];
			runner.onIterations((simId, completed, total) => heard.push([simId, completed, total]));
			await runner.run(request, { seed: 1, iterations: 1000 });
			const id = requestIdOf(0);
			expect(heard).toEqual([
				[id, 400, 1000],
				[id, 900, 1000],
				[id, 1000, 1000],
			]);
		});

		it('says a failed sim ended too', async () => {
			raidSimAsync.mockImplementation(reporting({ error: { type: 1, message: 'bad gear' } }));
			const runner = new WorkerPoolSimRunner(1);
			const heard: Array<[string, number, number]> = [];
			runner.onIterations((simId, completed, total) => heard.push([simId, completed, total]));
			await expect(runner.run(request, { seed: 1, iterations: 1000 })).rejects.toThrow('bad gear');
			expect(heard.at(-1)).toEqual([requestIdOf(0), 1000, 1000]);
		});

		it('stops telling a listener once it unsubscribes', async () => {
			raidSimAsync.mockImplementation(reporting(result));
			const runner = new WorkerPoolSimRunner(1);
			const heard: string[] = [];
			const off = runner.onIterations(simId => heard.push(simId));
			off();
			await runner.run(request, { seed: 1, iterations: 1000 });
			expect(heard).toEqual([]);
		});
	});
});
