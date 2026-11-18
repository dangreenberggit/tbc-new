/**
 * SimRunner over the site's WorkerPool (WASM workers on the web build, HTTP
 * workers on the desktop build).
 *
 * It owns its own `WorkerPool`: `Sim`'s pool is private (`ui/sim/sim.ts`), and a
 * `WorkerPool` depends on no `Sim` state.
 *
 * It does not call `runConcurrentSim` (`ui/sim/wasm/sim.ts`). That splits one
 * request's iterations across workers by sharding the seed
 * (`SplitSimRequestForConcurrency`, `sim/core/sim_concurrent.go`), so the result
 * changes with the worker count. Each candidate runs unsharded through
 * `raidSimAsync`, and the pool's `WorkerPoolManager` runs candidates side by side.
 */

import { ComputeStatsRequest, RaidSimRequest as RaidSimRequestProto } from '@generated/proto/api';
import type { JsonValue } from '@protobuf-ts/runtime';
import { CURRENT_API_VERSION } from '@sim/constants/other';
import { RequestTypes, SimSignalManager } from '@sim/sim_signal_manager';
import { generateRequestId, WorkerPool } from '@sim/workers/worker_pool';
import { SimRequest } from '@worker/types';

import {
	type PlayerStatsObservation,
	type RaidSimRequest,
	type SimObservation,
	type SimRunner,
	type SimRunOpts,
	spellDamageBySchool,
} from '../engine/seams/sim-runner';

/** Matches the default worker count `Sim`'s constructor picks (`ui/sim/sim.ts`). */
export const DEFAULT_WORKER_COUNT = 4;

/**
 * Peak RSS of one `wowsimcli` process running 5,000 iterations. No in-browser
 * figure per WASM worker has been measured; the CLI runs the same Go sim, so its
 * figure stands in, and `memoryCapFromDeviceMemory` is an estimate until a
 * browser measurement replaces it.
 */
const MEASURED_MB_PER_SIM_PROCESS = 183.8;

/**
 * How many sims fit in memory, from `navigator.deviceMemory` in GiB (Chromium
 * only). Half the reported RAM is left for the OS, the page and other tabs, and
 * the rest is divided by the per-process figure above. Without the API (Firefox,
 * Safari) it returns `DEFAULT_WORKER_COUNT`, so those users are not capped to 1.
 * The caller reads `navigator.deviceMemory` (`utils/runner_env.ts`): `model/` may
 * not touch browser globals.
 */
export function memoryCapFromDeviceMemory(deviceMemoryGiB: number | undefined): number {
	if (deviceMemoryGiB === undefined) return DEFAULT_WORKER_COUNT;
	const usableMb = (deviceMemoryGiB * 1024) / 2;
	const cap = Math.floor(usableMb / MEASURED_MB_PER_SIM_PROCESS);
	return Math.max(1, cap);
}

/**
 * The browser values the tab sizes its worker pool from. `model/` may not touch
 * browser globals (`.oxlintrc.json`), so `utils/runner_env.ts` reads them and
 * the caller passes them in.
 */
export type RunnerEnv = {
	/** `localStorage.getItem`; may throw when storage is unavailable. */
	storageRead: (key: string) => string | null;
	/** `navigator.hardwareConcurrency`; 0 or undefined when unknown. */
	hardwareConcurrency: number | undefined;
	/** `navigator.deviceMemory` in GiB; undefined outside Chromium. */
	deviceMemoryGiB: number | undefined;
};

/** The user's own worker-count choice in the site's settings; `0` is a deliberate "off". */
const WASM_CONCURRENCY_KEY = '__tbc_new_wasmconcurrency';

/**
 * The user's worker-count setting: the default when the key is absent, the
 * stored number when it is readable, and undefined when the store throws or
 * the value is not a finite number.
 */
function readWasmConcurrency(storageRead: RunnerEnv['storageRead']): number | undefined {
	try {
		const raw = storageRead(WASM_CONCURRENCY_KEY);
		if (raw === null) return DEFAULT_WORKER_COUNT;
		const parsed = Number(JSON.parse(raw));
		return Number.isFinite(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * How many workers the tab's pool gets. A choice above one is capped by the
 * cores and by `memoryCapFromDeviceMemory`, with a floor of two; no choice
 * counts as the default and is capped the same way. Off (`0`) and `1` get one
 * worker, because the tab cannot rank with none. An unreadable setting gets
 * the default, uncapped.
 */
export function workerCountFor(env: RunnerEnv): number {
	const setting = readWasmConcurrency(env.storageRead);
	if (setting === undefined) return DEFAULT_WORKER_COUNT;
	if (setting <= 1) return 1;
	const cores = env.hardwareConcurrency || DEFAULT_WORKER_COUNT;
	return Math.max(2, Math.min(setting, cores, memoryCapFromDeviceMemory(env.deviceMemoryGiB)));
}

/**
 * The tab's one pool, kept for the page's life and never ended, as wowsims'
 * own `Sim` keeps its pool (`ui/sim/sim.ts`: created once, then only
 * resized). `WorkerPool` has no public way to end its workers, so a second
 * runner on the same page (a remount after a run) must reuse this pool;
 * a new one would leave the old workers running with nothing to reach them.
 */
let sharedPool: WorkerPool | undefined;

function sharedPoolOf(numWorkers: number): WorkerPool {
	if (!sharedPool) {
		sharedPool = new WorkerPool(numWorkers);
	} else if (sharedPool.getNumWorkers() !== numWorkers) {
		sharedPool.setNumWorkers(numWorkers);
	}
	return sharedPool;
}

/** Tests only: the next runner builds a new pool. The old pool's workers are not ended. */
export function resetWorkerPoolForTests(): void {
	sharedPool = undefined;
}

export class WorkerPoolSimRunner implements SimRunner {
	private readonly pool: WorkerPool;
	private readonly signalManager = new SimSignalManager();

	/**
	 * How many candidate sims `rankUpgrades`'s `promisePool` may dispatch at once:
	 * `min(numWorkers, memoryCap)`. `numWorkers` sizes the pool; this caps the
	 * requests in flight so their combined memory stays under the cap, and more
	 * requests than workers would buy nothing.
	 */
	readonly concurrency: number;

	constructor(numWorkers: number = DEFAULT_WORKER_COUNT, deviceMemoryGiB?: number) {
		this.pool = sharedPoolOf(numWorkers);
		this.concurrency = Math.max(1, Math.min(numWorkers, memoryCapFromDeviceMemory(deviceMemoryGiB)));
	}

	async version(): Promise<string> {
		return `api-v${CURRENT_API_VERSION}`;
	}

	async run(req: RaidSimRequest, opts: SimRunOpts): Promise<SimObservation> {
		// Only the set screen asks for per-iteration values.
		const saveAllValues = opts.saveAllValues === true;
		const withOptions = {
			...req,
			// The same id helper `Sim.makeRaidSimRequest` uses (`ui/sim/sim.ts`).
			requestId: generateRequestId(SimRequest.raidSimAsync),
			simOptions: {
				iterations: opts.iterations,
				// protobuf-ts int64 fields accept a numeric string on fromJson.
				randomSeed: String(opts.seed),
				debugFirstIteration: false,
				...(saveAllValues ? { saveAllValues: true } : {}),
			},
		};

		const proto = RaidSimRequestProto.fromJson(withOptions, {
			ignoreUnknownFields: true,
		});

		const signals = this.signalManager.registerRunning(RequestTypes.IndividualSim);
		try {
			const result = await this.pool.raidSimAsync(proto, () => {}, signals);
			if (result.error) {
				throw new Error(`sim error (${result.error.type}): ${result.error.message}`);
			}
			const dps = result.raidMetrics?.dps;
			if (!dps) {
				throw new Error('sim result has no raidMetrics.dps');
			}
			return {
				dps: dps.avg,
				stdev: dps.stdev,
				iterationsDone: result.iterationsDone,
				simVersion: await this.version(),
				...(saveAllValues ? { allValues: [...dps.allValues] } : {}),
				spellDamageBySchool: spellDamageBySchool(result.raidMetrics?.parties[0]?.players[0]?.actions ?? []),
			};
		} finally {
			this.signalManager.unregisterRunning(signals);
		}
	}

	/**
	 * The first player's final stats for the request's gear, the call the page's
	 * stats panel makes (`getCharacterStatsForGear`, `ui/sim/sim.ts`). Meta repair
	 * reads hit from it.
	 */
	async computeStats(req: RaidSimRequest): Promise<PlayerStatsObservation> {
		const proto = ComputeStatsRequest.fromJson({ raid: req.raid, encounter: req.encounter } as JsonValue, { ignoreUnknownFields: true });
		const result = await this.pool.computeStats(proto);
		if (result.errorResult !== '') {
			throw new Error(`computeStats error: ${result.errorResult}`);
		}
		const finalStats = result.raidStats?.parties[0]?.players[0]?.finalStats;
		if (!finalStats) {
			throw new Error('computeStats result has no first player finalStats');
		}
		return { stats: [...finalStats.stats], pseudoStats: [...finalStats.pseudoStats] };
	}

	/** The first player's active set bonuses from the same stats call. */
	async activeSetBonuses(req: RaidSimRequest): Promise<readonly string[]> {
		const proto = ComputeStatsRequest.fromJson({ raid: req.raid, encounter: req.encounter } as JsonValue, { ignoreUnknownFields: true });
		const result = await this.pool.computeStats(proto);
		if (result.errorResult !== '') {
			throw new Error(`computeStats error: ${result.errorResult}`);
		}
		const player = result.raidStats?.parties[0]?.players[0];
		if (!player) {
			throw new Error('computeStats result has no first player');
		}
		return [...player.sets];
	}
}
