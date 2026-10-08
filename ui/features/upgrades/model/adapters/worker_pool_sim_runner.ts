/**
 * WorkerPoolSimRunner — SimRunner over the site's own WorkerPool (WASM workers
 * on the web build, HTTP net workers on the desktop build) (plan §2.4).
 *
 * Owns an independent `WorkerPool`, rather than reaching into `Sim`'s
 * private `workerPool` field — `Sim.workerPool` has no public accessor
 * (`ui/core/sim.ts`), and `WorkerPool`'s own constructor is self-contained
 * (points every worker at the fixed `SIM_WORKER_URL`, no dependency on `Sim`
 * state), so a second pool is the same kind of object the page already runs,
 * not a workaround.
 *
 * Deliberately does **not** call `runConcurrentSim`
 * (`ui/core/sim_concurrent.ts`): that function splits *one request's
 * iterations* across workers by sharding the seed
 * (`sim/core/sim_concurrent.go`'s `SplitSimRequestForConcurrency`), which is
 * a different number for a different worker count (confirmed empirically in
 * `docs/plans/compute-topology.md` §3.1 — same seed, different core count,
 * different float in the last few digits). So `raidSimAsync` is called once per
 * candidate, unsharded, and the pool's own least-busy-worker balancing
 * (`WorkerPoolManager`) is what runs several candidates concurrently.
 *
 * The old tab's bulk screening runners were measured slower than this loop and
 * deleted, with the engine's bulk branch (tbc-gear-prio tickets 411 and 567).
 */

import { ComputeStatsRequest, RaidSimRequest as RaidSimRequestProto } from '@generated/proto/api';
import type { JsonValue } from '@protobuf-ts/runtime';
import { CURRENT_API_VERSION } from '@sim/constants/other';
import { RequestTypes, SimSignalManager } from '@sim/sim_signal_manager';
import { generateRequestId, WorkerPool } from '@sim/workers/worker_pool';
import { SimRequest } from '@worker/types';

import type { PlayerStatsObservation, RaidSimRequest, SimObservation, SimRunner, SimRunOpts } from '../engine/seams/sim-runner';

/** Matches upstream's own default (`ui/core/sim.ts`'s WorkerPool(1) plus its
 * wasm-concurrency auto-sizing, capped at 4 — see that file's constructor). */
export const DEFAULT_WORKER_COUNT = 4;

/**
 * E-W5 measured **183.8 MB** peak RSS for one `wowsimcli` process running
 * 5,000 iterations (candidate-pool.md §3.1) — the Node/CLI sim binary, not
 * this browser's WASM worker. No in-browser RSS-per-worker measurement
 * exists yet (that number was explicitly out of scope for E-W5, which ran
 * against the CLI), so this constant is the CLI figure carried over as the
 * best available proxy: same Go sim core compiled to WASM instead of a
 * native binary, running the same fixed-duration encounter loop that
 * dominates RSS. Treat `memoryCapFromDeviceMemory` below as a
 * **hypothesis**, not a measured browser number, until a WASM-side RSS
 * sample replaces it — flagged here so a future change to this constant
 * updates the reasoning in both places at once.
 */
const MEASURED_MB_PER_SIM_PROCESS = 183.8;

/**
 * `min(workers, memoryCap)` per candidate-pool.md §5.1.2/§5.2. `memoryCap`
 * comes from `navigator.deviceMemory` (Chrome/Chromium only — the Device
 * Memory API; Firefox and Safari never expose it and the property is
 * `undefined` there), read as an approximate device RAM figure in GiB.
 * Reserves half of reported RAM for everything else already running (the
 * OS, the tab's own DOM/JS heap, other tabs) rather than assuming this sim
 * can claim the whole figure, then divides the remainder by the measured
 * per-process cost above. Falls back to `DEFAULT_WORKER_COUNT` (matching
 * upstream's own hardcoded default, `ui/core/sim.ts`) when the API is
 * unavailable, so a Firefox/Safari user is not capped to 1 by a browser
 * quirk unrelated to their actual RAM. The caller reads `navigator.deviceMemory`
 * (`utils/runner_env.ts`): `model/` may not touch browser globals.
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
	 * `min(workers, memoryCap)` (candidate-pool.md §5.1.2) — how many
	 * candidate sims `rankUpgrades`'s `promisePool` may dispatch at once.
	 * Distinct from the `WorkerPool`'s own `numWorkers`: that number sizes
	 * how many WASM workers exist to *service* requests; this number caps how
	 * many *requests* are in flight so their combined memory stays under
	 * `memoryCap`. `numWorkers` is itself already `min`-folded in when it is
	 * lower than the memory cap, since dispatching more requests than there
	 * are workers to run them buys nothing.
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
		// Only the set screen asks for per-iteration values (ticket 511). Without
		// the option, the request and the observation are exactly as before.
		const saveAllValues = opts.saveAllValues === true;
		const withOptions = {
			...req,
			requestId: generateRequestId(SimRequest.raidSimAsync),
			simOptions: {
				iterations: opts.iterations,
				// protobuf-ts int64 fields accept a numeric string on fromJson;
				// matches how the CLI seam (packages/core/src/seams/cli-sim-runner.ts)
				// and the recorded fixtures already spell a seed (D4's sibling
				// adaptation, same convention, not a new one invented here).
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
			};
		} finally {
			this.signalManager.unregisterRunning(signals);
		}
	}

	/**
	 * The first player's final stats for the request's gear (ticket 535), the
	 * call the page's own stats panel makes (`ui/core/sim.ts`
	 * `getCharacterStatsForGear`). Meta repair reads hit from it.
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
}
