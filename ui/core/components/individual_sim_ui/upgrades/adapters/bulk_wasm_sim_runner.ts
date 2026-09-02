/**
 * BulkWasmSimRunner — a `SimRunner` that adds the bulk screening capability on
 * top of the ordinary per-candidate one.
 *
 * `run()` is inherited unchanged from `WasmSimRunner`: the accurate final pass
 * (paired-seed replication) and the set-bonus sims still go one request at a
 * time, exactly as before. Only the screening pass batches.
 */

import { BulkSimResult } from '../../../../proto/api.js';
import { RequestTypes, SimSignalManager } from '../../../../sim_signal_manager.js';
import { WorkerPool } from '../../../../worker_pool.js';
import { runConcurrentBulkSim } from '../../../../wasm/bulk_sim/index.js';
import { MAX_CANDIDATES_PER_BULK_REQUEST, partitionForBulkScreen } from '../engine/bulk/partition.js';
import type { BulkScreenRequest, BulkScreenResult, SimObservation, SimRunner } from '../engine/seams/sim-runner.js';
import { buildBulkSimRequest } from './bulk_request_builder.js';
import { DEFAULT_WORKER_COUNT, memoryCapFromDeviceMemory, WasmSimRunner } from './wasm_sim_runner.js';

/** The user's own worker-count choice; `0` is a deliberate "off". */
const WASM_CONCURRENCY_KEY = '__tbc_new_wasmconcurrency';

/**
 * Maps one chunk's `BulkSimResult` onto the seam's vocabulary. **Exported and
 * shared** (reconciliation R3): the Go runner imports this rather than writing
 * its own, so the two transports cannot disagree about what a bulk response
 * means.
 *
 * Two integrity checks, not one (reconciliation R2). The partitioner bound
 * prevents *culling*, but `wasm/bulk_sim/statistics.ts:107` filters out any
 * result lacking `dpsMetrics` before slicing, and `index.ts:121-122` only
 * catches results whose `error` is set — so a row can vanish with no culling and
 * no error. Since screening deltas feed straight into the ranking, a missing row
 * would become a missing candidate rather than a failure; throwing is the only
 * honest option.
 */
export function bulkScreenResultFrom(result: BulkSimResult, expectedCount: number, simVersion: string): BulkScreenResult {
	if (result.error) {
		throw new Error(`bulk screen failed: ${result.error.message || `error type ${result.error.type}`}`);
	}
	// `baseline` is its own field (`index.ts:165`), never an n+1th row (`:166`).
	const baselineDps = result.baseline?.dpsMetrics;
	if (!baselineDps) {
		throw new Error('bulk screen returned no baseline dpsMetrics');
	}
	const rows = result.topResults.filter(row => row.dpsMetrics);
	if (result.topResults.length !== expectedCount || rows.length !== expectedCount) {
		throw new Error(
			`bulk screen row shortfall: expected ${expectedCount} rows with dpsMetrics, ` +
				`got ${result.topResults.length} rows of which ${rows.length} carry dpsMetrics`,
		);
	}

	const iterationsDone = result.stageMetrics.at(-1)?.iterations ?? 0;
	const toObservation = (dps: { avg: number; stdev: number }): SimObservation => ({
		dps: dps.avg,
		stdev: dps.stdev,
		iterationsDone,
		simVersion,
	});

	return {
		baseline: toObservation(baselineDps),
		// `candidateIndex` on the response side, `index` on the request side
		// (`proto/api.ts:1920` vs `BulkGearCandidate`). Rows come back sorted by
		// descending DPS, so this index is the only link back to the candidate.
		rows: rows.map(row => ({ index: row.candidateIndex, observation: toObservation(row.dpsMetrics!) })),
	};
}

/**
 * Reads the user's worker-count setting. `0` means Off — a deliberate choice,
 * never clamped upward (`sim.ts:175`). `1` cannot serve the bulk path either:
 * the tournament's baseline probe splits one request across workers, so a
 * single-worker pool has nothing to split across.
 */
export function bulkPoolSizeFrom(setting: number | undefined, hardwareConcurrency: number, memoryCap: number): number | undefined {
	if (setting === undefined || setting <= 1) return undefined;
	return Math.max(2, Math.min(setting, hardwareConcurrency, memoryCap));
}

/**
 * Reads the user's worker-count setting.
 *
 * Three outcomes, deliberately distinct. An *absent* key is a user who never
 * chose, so the default applies. A *present and readable* value is the user's
 * choice and is returned as-is — `0` means Off, never clamped upward
 * (`sim.ts:175`). An *unreadable* store (localStorage throwing, or a value that
 * does not parse to a finite number) is neither: it is an unknown setting, and
 * returning the default there would silently override a user who had chosen Off
 * — turning a deliberate "do not run workers" into a multi-worker bulk path on
 * the strength of a storage failure. `undefined` instead, which `makeSimRunner`
 * reads as no bulk capability, so an unknown setting fails to the quieter path
 * rather than the louder one.
 */
function readWasmConcurrency(): number | undefined {
	try {
		const raw = localStorage.getItem(WASM_CONCURRENCY_KEY);
		if (raw === null) return DEFAULT_WORKER_COUNT;
		const parsed = Number(JSON.parse(raw));
		return Number.isFinite(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export class BulkWasmSimRunner extends WasmSimRunner {
	private readonly bulkPool: WorkerPool;
	private readonly bulkSignals = new SimSignalManager();

	constructor(poolSize: number) {
		super(poolSize);
		this.bulkPool = new WorkerPool(poolSize);
	}

	async runBulkScreen(req: BulkScreenRequest): Promise<BulkScreenResult> {
		const chunks = partitionForBulkScreen(req.candidates, MAX_CANDIDATES_PER_BULK_REQUEST);
		const simVersion = await this.version();
		let baseline: SimObservation | undefined;
		const rows: { index: number; observation: SimObservation }[] = [];

		for (const chunk of chunks) {
			const request = buildBulkSimRequest({ ...req, candidates: chunk });
			const signals = this.bulkSignals.registerRunning(RequestTypes.BulkSim);
			try {
				// Upstream's TS tournament, not `workerPool.bulkSimAsync`: the WASM
				// worker's `bulkSimAsync` is a stub that logs "bulkSimAsync is only
				// supported by the HTTP worker" and returns an empty buffer
				// (`ui/worker/sim_worker.ts:15-18,107`). Switch to the RPC when
				// upstream implements it in WASM.
				const result = await runConcurrentBulkSim(request, this.bulkPool, () => {}, signals);
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

/**
 * Builds the runner the tab uses. By default returns a plain `WasmSimRunner` —
 * with no bulk capability at all — so `deps.sim.runBulkScreen` is undefined and
 * `rankUpgrades` takes its existing per-candidate path unchanged. Pass
 * `bulk = true` to opt into the in-browser tournament; even then the user's
 * setting still decides, and Off or 1 still yields the plain runner (a
 * deliberate Off is never clamped upward).
 *
 * The return type is the concrete class, not the `SimRunner` interface, because
 * the tab also reads `.concurrency` off it to size `rankUpgrades`'s own
 * dispatch pool.
 *
 * ## Why the WASM default is the per-candidate loop, not the bulk tournament
 *
 * `bulk` defaults to `false`, so on the WASM transport this returns the loop
 * runner even when the user's worker count would support a tournament. The bulk
 * capability is left to `BulkHttpSimRunner`, which the tab constructs itself
 * once it knows the page is served by the packaged Go server.
 *
 * This is a transport decision backed by measurement, not a retreat from the
 * batch path. One 25-candidate chunk costs **332 s** on the in-browser TS
 * tournament (`execution-ledger-web.md`, Step 2/3 arm table, pool 4) against
 * **9.35 s** for the same chunk on the Go server's native bulk RPC (ticket 347's
 * chunk table) — a ~35x transport gap for identical work. And because
 * `rank.ts`'s `screenCandidates` is a single `await` that prices every candidate
 * before the ranking's first row is emitted, that per-chunk cost is *first-row
 * latency*: the WASM bulk route shows an empty table for well over five minutes
 * where the loop streams a row roughly every 40 s. The layout gate's run phase
 * (`test-layout.mjs`, 120 s deadline for 5 rows) is the mechanical consequence,
 * but the user-facing one is the reason.
 *
 * Ticket 346 is the revisit trigger: it re-measures bulk against the loop at
 * matched accuracy, having found bulk 1.6x slower end-to-end at *unmatched*
 * accuracy (the arms ran 5,000 flat vs 7,091 adaptive iterations, so that figure
 * is explicitly not yet a verdict on batching). If 346 lands with the WASM
 * tournament competitive, flipping `bulk` back on is a one-argument change —
 * which is why `BulkWasmSimRunner` stays constructible here rather than deleted.
 */
export function makeSimRunner(bulk = false): WasmSimRunner {
	const setting = readWasmConcurrency();
	const poolSize = bulkPoolSizeFrom(setting, navigator.hardwareConcurrency || DEFAULT_WORKER_COUNT, memoryCapFromDeviceMemory());
	if (!bulk || poolSize === undefined) {
		// `setting` is undefined either because the user chose nothing readable or
		// because the store could not be read; `bulkPoolSizeFrom` has already
		// refused the bulk path for both. The plain runner still needs *a* worker
		// count, and the default is the right guess for an unknown setting — it
		// sizes a pool rather than enabling a capability, so guessing here cannot
		// override an Off the way enabling bulk would.
		//
		// `!bulk` reaches the same runner by the header's transport decision. The
		// pool size is unaffected either way: it sizes `run()`'s worker pool, which
		// the per-candidate path uses exactly as before.
		return new WasmSimRunner(Math.max(1, poolSize ?? setting ?? DEFAULT_WORKER_COUNT));
	}
	return new BulkWasmSimRunner(poolSize);
}
