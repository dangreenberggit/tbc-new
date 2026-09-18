/**
 * BulkHttpSimRunner — the bulk screening capability over the packaged local
 * Go server's HTTP transport.
 *
 * This is a *transport* sibling of `BulkWasmSimRunner`, not a second design.
 * Both hand the whole chunk loop — partitioning, the single-stage guard, cancel,
 * response mapping and chunk-failure handling — to the shared
 * `runBulkScreenChunks`, so neither transport can drift from the other on any of
 * it. The only difference is where the tournament runs:
 * `BulkWasmSimRunner` drives upstream's TypeScript tournament in-browser
 * (`runConcurrentBulkSim`), because the WASM worker's `bulkSimAsync` is a stub
 * (`ui/worker/sim_worker.ts:15-18,107`); this runner calls the RPC for real,
 * because the HTTP worker maps `bulkSimAsync` to a genuine async request
 * (`ui/worker/worker_http.ts:64`) that the Go server answers with its own
 * native bulk engine at NumCPU concurrency.
 *
 * `run()` — the accurate final pass (paired-seed replication) and the set-bonus
 * sims — is inherited unchanged from `WorkerPoolSimRunner`. Only screening batches.
 * The class name says WASM but the code is transport-blind: it builds a
 * `WorkerPool` and calls `raidSimAsync`, and under the packaged server those
 * workers are `net_worker.js` (the server rewrites the script path,
 * `sim/web/main.go:402-403`). So inheriting it here posts HTTP, not WASM.
 *
 * ## Why this runner does not size a worker pool
 *
 * `bulkPoolSizeFrom` refuses fewer than 2 workers on the WASM side for a real
 * reason: that tournament's baseline probe splits one request across workers,
 * so a 1-worker pool has nothing to split across. None of that applies here.
 * One HTTP request sends the whole batch to a server that threads it over
 * NumCPU internally (`sim/core/bulk/stage.go`), with no client-side knob —
 * which is exactly why upstream itself refuses to apply the user's WASM
 * concurrency setting when the pool is not WASM: "Local sim has native
 * threading" (`ui/core/sim.ts:163-169`). A single worker is the right size,
 * and the user's WASM concurrency choice is not a statement about this path.
 */

import { SimSignalManager } from '../../../../sim_signal_manager.js';
import { WorkerPool } from '../../../../worker_pool.js';
import type { BulkScreenRequest, BulkScreenResult } from '../engine/seams/sim-runner.js';
import { runBulkScreenChunks } from './bulk_screen_driver.js';
import { WorkerPoolSimRunner } from './worker_pool_sim_runner.js';

export class BulkHttpSimRunner extends WorkerPoolSimRunner {
	private readonly bulkPool: WorkerPool;
	private readonly bulkSignals = new SimSignalManager();

	constructor(numWorkers: number) {
		super(numWorkers);
		// Its own pool, for the same reason `BulkWasmSimRunner` keeps one: a bulk
		// request occupies its worker for the whole tournament, and sharing the
		// pool that `run()` uses would let a screening batch starve the final
		// pass. Size 1 — see the header on why no sizing policy applies here.
		this.bulkPool = new WorkerPool(1);
	}

	// The chunk bound that keeps every batch inside the Go engine's single-stage
	// (no-culling) regime lives in `engine/bulk/partition.ts`, and the driver
	// asserts it per built request against upstream's own estimator
	// (`assertSingleStageChunk`, ticket 349).
	async runBulkScreen(req: BulkScreenRequest): Promise<BulkScreenResult> {
		return runBulkScreenChunks(req, {
			signals: this.bulkSignals,
			simVersion: await this.version(),
			// `/asyncProgress` returns 204 once the server evicts a run's progress
			// after 10 minutes (`sim/web/main.go:219,310`), and the HTTP worker
			// treats 204 as normal completion — it simply `break`s out of its poll
			// loop (`ui/worker/worker_http.ts:40-42`) and returns whatever it last
			// received. A truncated screen would then read as a complete one and
			// silently drop candidates from the ranking. The driver's shared
			// `bulkScreenResultFrom` throws unless the chunk returned one row per
			// candidate with `dpsMetrics`, which is what converts that silent path
			// into a hard error.
			dispatch: (request, signals) => this.bulkPool.bulkSimAsync(request, () => {}, signals),
		});
	}
}
