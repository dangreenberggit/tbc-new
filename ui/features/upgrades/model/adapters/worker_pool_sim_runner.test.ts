import { describe, expect, it } from 'vitest';

import { DEFAULT_WORKER_COUNT, memoryCapFromDeviceMemory, type RunnerEnv, workerCountFor } from './worker_pool_sim_runner';

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
