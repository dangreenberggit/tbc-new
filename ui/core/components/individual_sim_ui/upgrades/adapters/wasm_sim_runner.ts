/**
 * WasmSimRunner — SimRunner over the site's own in-browser WASM simulator
 * (plan §2.4).
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
 * Plan §2.4 justified the per-candidate loop with "there is no bulk RPC —
 * upstream's own Batch tab loops one ordinary sim per combination client-side".
 * That is **no longer true of this tree**, and the correction matters to anyone
 * reading this class as the only available shape. A bulk path now exists: the
 * screening pass goes through `runBulkScreen` on the `SimRunner` seam, served by
 * `BulkWasmSimRunner` and `BulkHttpSimRunner`. What remains true is narrower —
 * the WASM *worker* still has no bulk RPC, because `sim_worker.ts:15-18,107`
 * stubs `bulkSimAsync` to log and return an empty buffer, which is why the WASM
 * runner drives upstream's in-browser TS tournament instead. The HTTP worker
 * maps the RPC for real (`worker_http.ts:64`).
 *
 * This class keeps the per-candidate loop regardless, and that is deliberate
 * rather than unconverted: `run()` serves the accurate final pass (paired-seed
 * replication) and the set-bonus sims, which need one request per measurement.
 * Only screening batches.
 */

import { RaidSimRequest as RaidSimRequestProto } from '../../../../proto/api.js';
import { CURRENT_API_VERSION } from '../../../../constants/other.js';
import { generateRequestId, WorkerPool } from '../../../../worker_pool.js';
import { SimRequest } from '../../../../../worker/types.js';
import { RequestTypes, SimSignalManager } from '../../../../sim_signal_manager.js';
import type { RaidSimRequest, SimObservation, SimRunOpts, SimRunner } from '../engine/seams/sim-runner.js';

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
 * quirk unrelated to their actual RAM.
 */
export function memoryCapFromDeviceMemory(deviceMemoryGiB: number | undefined = (navigator as Navigator & { deviceMemory?: number }).deviceMemory): number {
	if (deviceMemoryGiB === undefined) return DEFAULT_WORKER_COUNT;
	const usableMb = (deviceMemoryGiB * 1024) / 2;
	const cap = Math.floor(usableMb / MEASURED_MB_PER_SIM_PROCESS);
	return Math.max(1, cap);
}

export class WasmSimRunner implements SimRunner {
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

	constructor(numWorkers: number = DEFAULT_WORKER_COUNT) {
		this.pool = new WorkerPool(numWorkers);
		this.concurrency = Math.max(1, Math.min(numWorkers, memoryCapFromDeviceMemory()));
	}

	async version(): Promise<string> {
		return `api-v${CURRENT_API_VERSION}`;
	}

	async run(req: RaidSimRequest, opts: SimRunOpts): Promise<SimObservation> {
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
			},
		};

		const proto = RaidSimRequestProto.fromJson(withOptions, {
			ignoreUnknownFields: true,
		});

		const signals = this.signalManager.registerRunning(RequestTypes.RaidSim);
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
			};
		} finally {
			this.signalManager.unregisterRunning(signals);
		}
	}
}
