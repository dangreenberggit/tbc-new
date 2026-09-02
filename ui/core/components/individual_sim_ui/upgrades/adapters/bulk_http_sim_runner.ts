/**
 * BulkHttpSimRunner — the bulk screening capability over the packaged local
 * Go server's HTTP transport.
 *
 * This is a *transport* sibling of `BulkWasmSimRunner`, not a second design.
 * Both partition with `partitionForBulkScreen`, build the identical typed
 * request with `buildBulkSimRequest`, and map the response with the shared
 * `bulkScreenResultFrom`. The only difference is where the tournament runs:
 * `BulkWasmSimRunner` drives upstream's TypeScript tournament in-browser
 * (`runConcurrentBulkSim`), because the WASM worker's `bulkSimAsync` is a stub
 * (`ui/worker/sim_worker.ts:15-18,107`); this runner calls the RPC for real,
 * because the HTTP worker maps `bulkSimAsync` to a genuine async request
 * (`ui/worker/worker_http.ts:64`) that the Go server answers with its own
 * native bulk engine at NumCPU concurrency.
 *
 * `run()` — the accurate final pass (paired-seed replication) and the set-bonus
 * sims — is inherited unchanged from `WasmSimRunner`. Only screening batches.
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
 * One HTTP request carries the whole batch to a server that threads it over
 * NumCPU internally (`sim/core/bulk/stage.go`), with no client-side knob —
 * which is exactly why upstream itself refuses to apply the user's WASM
 * concurrency setting when the pool is not WASM: "Local sim has native
 * threading" (`ui/core/sim.ts:163-169`). A single worker is the right size,
 * and the user's WASM concurrency choice is not a statement about this path.
 */

import { RequestTypes, SimSignalManager } from '../../../../sim_signal_manager.js';
import { WorkerPool } from '../../../../worker_pool.js';
import { MAX_CANDIDATES_PER_BULK_REQUEST, partitionForBulkScreen } from '../engine/bulk/partition.js';
import type { BulkScreenRequest, BulkScreenResult, SimObservation } from '../engine/seams/sim-runner.js';
import { buildBulkSimRequest } from './bulk_request_builder.js';
import { bulkScreenResultFrom } from './bulk_wasm_sim_runner.js';
import { WasmSimRunner } from './wasm_sim_runner.js';

export class BulkHttpSimRunner extends WasmSimRunner {
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

	async runBulkScreen(req: BulkScreenRequest): Promise<BulkScreenResult> {
		const chunks = partitionForBulkScreen(req.candidates, MAX_CANDIDATES_PER_BULK_REQUEST);
		const simVersion = await this.version();
		let baseline: SimObservation | undefined;
		const rows: { index: number; observation: SimObservation }[] = [];

		for (const chunk of chunks) {
			// A fresh `SimSignalManager` registration per chunk, so this signal
			// cannot already be aborted: nothing holds a reference to it before this
			// line. Inter-chunk cancellation therefore does not exist on this path
			// yet — a caller's abort reaches neither the loop nor the in-flight
			// request, because no caller signal is wired through to either. Ticket
			// 347 owns that wiring; until it lands, a screening pass runs every
			// chunk it started with.
			const signals = this.bulkSignals.registerRunning(RequestTypes.BulkSim);
			try {
				const request = buildBulkSimRequest({ ...req, candidates: chunk });
				// The chunk bound (25) keeps every batch inside the Go engine's
				// single-stage regime, so nothing is culled and every candidate comes
				// back. That is the bound's whole job.
				//
				// The operative gate is `shouldUseLegacyBulkSim` (`sim/core/bulk/
				// estimate.go`), not the Medium stage's `MaxSurvivors: 25`
				// (`stage.go`). The survivor limit is real but is not what decides
				// whether the extra stages run at all: the estimator keeps a run
				// single-stage well past 26. Measured on the packaged server at 5,000
				// iterations, n = 26, 30 and 32 all come back single-stage with every
				// row present, while n = 33 goes two-stage and returns 5 rows of 33 —
				// so the flip sits at 32/33, identical to the TS tournament's measured
				// boundary. 25 is inside both regimes with margin.
				//
				// That boundary is iteration-sensitive and moves DOWN as iterations
				// rise, and nothing couples this bound to `req.iterations` (ticket
				// 349).
				//
				// It is not, on its own, enough. `/asyncProgress` returns 204 once
				// the server evicts a run's progress after 10 minutes
				// (`sim/web/main.go:219,310`), and the HTTP worker treats 204 as
				// normal completion — it simply `break`s out of its poll loop
				// (`ui/worker/worker_http.ts:40-42`) and returns whatever it last
				// received. A truncated screen would then read as a complete one and
				// silently drop candidates from the ranking. `bulkScreenResultFrom`
				// throws unless the chunk returned one row per candidate with
				// `dpsMetrics`, which is what converts that silent path into a hard
				// error. Shared with the WASM runner deliberately: the two transports
				// must not disagree about what a bulk response means.
				const result = await this.bulkPool.bulkSimAsync(request, () => {}, signals);
				const mapped = bulkScreenResultFrom(result, chunk.length, simVersion);
				// Each chunk re-probes its own baseline, so later chunks would
				// otherwise overwrite the first. Keeping the first makes every
				// screening delta in this batch share one reference point.
				baseline ??= mapped.baseline;
				rows.push(...mapped.rows);
			} finally {
				this.bulkSignals.unregisterRunning(signals);
			}
		}

		if (!baseline) {
			throw new Error('bulk screen produced no chunks');
		}
		return { baseline, rows };
	}
}
