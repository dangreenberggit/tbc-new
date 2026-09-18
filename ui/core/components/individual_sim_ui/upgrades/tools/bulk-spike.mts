/**
 * Bulk-sim spike (plan-web Steps 2 and 3, as replaced by amendment A1/A1.1).
 *
 * Answers what only a real run can answer: inside the no-culling regime, does
 * every candidate come back with a row carrying `dpsMetrics`? The
 * stage-selection half of the original Step 2 is already settled exactly by
 * executing upstream's own pure functions offline (flip at n=40 @3,000 and
 * n=33 @5,000), so the arms here probe row completeness at n = 19, 25, 32 and
 * the first arm past the derived boundary, n = 33.
 *
 * WHY THIS RUNS IN THE BROWSER, NOT NODE. `runConcurrentBulkSim` reaches a sim
 * only through `WorkerPool`, whose `SimWorker` constructor calls
 * `new window.Worker('/tbc/sim_worker.js')` (`ui/core/worker_pool.ts:32,309`),
 * and that worker boots by `WebAssembly.instantiateStreaming(fetch('lib.wasm'))`
 * (`ui/worker/sim_worker.ts:123`). Measured under the Node loader recipe the
 * plan originally assumed: the pool fails to construct with "window.Worker is
 * not a constructor". Growing `headless.mts`'s shims to cover a WASM sim worker
 * is what that file's own doc comment warns against.
 *
 * WHY PORT 4180 AND NOT VITE. `vite.config.mts:20-25` rewrites
 * `/tbc/sim_worker.js` to `/tbc/local_worker.js`, which is the HTTP worker
 * (zero `WebAssembly` references; calls `.ready(false)`). On the vite dev server
 * `isWasm()` is therefore false and the pool never grows past one worker — it
 * would measure the HTTP transport while claiming to measure WASM. Serve the
 * built `dist/` instead (the `wowsims-fork-prod` launch entry, port 4180),
 * where the real `sim_worker.js` (`.ready(true)`) is served. `runSpike` asserts
 * `isWasm()` before any arm and refuses to run if it is false.
 *
 * THE EMBEDDED DATABASE MUST COVER EVERY CANDIDATE ITEM. A bulk request
 * sends ONE `player.database` for all candidates, while the per-candidate
 * loop composes a fresh request (and so a fresh database) per candidate. Since
 * `simDatabaseFor` builds rows from exactly the equipment handed to it
 * (`adapters/sim_database.ts:42-44`) and `lib.wasm` is built without `with_db`,
 * a candidate item absent from that one database makes the sim panic with
 * "No item with id: N" — the deliberate behaviour documented at
 * `adapters/sim_database.ts:19-22`. Measured: this is what made the tournament
 * look like a hang. The panic appears only after the whole candidate queue
 * drains (`wasm/bulk_sim/batch.ts:132-133` aborts on the first candidate error
 * but the error is returned by `index.ts:121-122` only once the batch settles),
 * so at n=19 @5,000 the failure takes many minutes to appear and reads as a
 * wedged run. Step 6's `buildBulkSimRequest` must widen the database to the
 * union over the baseline and every candidate.
 *
 * Not part of the site build; not under `engine/`, so no PROVENANCE row
 * (`tools/README.md:11`).
 */

import { BulkGearCandidate, BulkSimRequest, RaidSimRequest as RaidSimRequestProto } from '../../../../proto/api.js';
import { EquipmentSpec, ItemSpec } from '../../../../proto/common.js';
import { RequestTypes, SimSignalManager } from '../../../../sim_signal_manager.js';
import { SimRequest } from '../../../../../worker/types.js';
import { generateRequestId, WorkerPool } from '../../../../worker_pool.js';
import { runConcurrentBulkSim } from '../../../../wasm/bulk_sim/index.js';

export type SpikeArm = {
	label: string;
	candidateCount: number;
	highStageIterations: number;
	poolSize: number;
};

/** A1-2: every emitted line prints the transport provenance on its face. */
export type SpikeProvenance = {
	isWasm: boolean;
	numWorkers: number;
	workerUrl: string;
};

export type SpikeArmResult = {
	arm: SpikeArm;
	provenance: SpikeProvenance;
	stages: { stage: number; iterations: number; survivors: number; durationSeconds: number }[];
	stageCount: number;
	rowsReturned: number;
	/** R2: `statistics.ts:107` drops a result lacking `dpsMetrics` before slicing. */
	rowsWithDpsMetrics: number;
	allCandidatesReturned: boolean;
	/** R4: `baseline` is its own field (`index.ts:165`), never an n+1th row. */
	baselinePopulated: boolean;
	baselineDps: number | null;
	/** C15: at least one baseline probe per chunk; adaptive passes can add more. */
	baselineProgressEvents: number;
	candidateIndices: number[];
	elapsedSeconds: number;
	error?: string;
};

/** The worker URL `WorkerPool` actually resolves (`worker_pool.ts:32`). */
export const RESOLVED_WORKER_URL = '/tbc/sim_worker.js';

/**
 * `topResults` is set to the candidate count per L-new-1: the default is 5
 * (`wasm/bulk_sim/constants.ts:1`) and truncates the response independently of
 * culling, so leaving it unset would make a row-count measurement fail for a
 * reason that has nothing to do with the cull boundary.
 */
export function buildSpikeRequest(
	baseRequestJson: Readonly<Record<string, unknown>>,
	candidateGear: readonly EquipmentSpec[],
	highStageIterations: number,
): BulkSimRequest {
	// The seam types a request as `Readonly<Record<string, unknown>>` on purpose
	// (`engine/seams/sim-runner.ts:12-21` — the engine stays proto-unaware), but
	// protobuf-ts's `fromJson` wants a `JsonValue`, which an index signature of
	// `unknown` does not satisfy. The two describe the same protojson object;
	// only the static types disagree. `worker_pool_sim_runner.ts:112` never hits this
	// because it passes a fresh object literal, so the cast is new at this
	// boundary — Step 6's builder inherits it and should carry the same note.
	// `compose()` deliberately strips `simOptions` (`engine/compose.ts:32`) —
	// the engine's own runner supplies iterations and seed per call. But
	// `validateBulkSimRequest` rejects a request without it (`index.ts:49`), and
	// the tournament reads `baseRequest.simOptions.iterations` for its baseline
	// probe (`index.ts:91,157`). So the builder must put it back. Step 6's
	// `buildBulkSimRequest` inherits this obligation.
	const withSimOptions = {
		...baseRequestJson,
		simOptions: { iterations: highStageIterations, randomSeed: '11', debugFirstIteration: false },
	};
	const baseRequest = RaidSimRequestProto.fromJson(withSimOptions as unknown as Record<string, never>, { ignoreUnknownFields: true });
	return BulkSimRequest.create({
		baseRequest,
		candidates: candidateGear.map((gear, index) => BulkGearCandidate.create({ index, gear })),
		topResults: candidateGear.length,
		highStageIterations,
		// Every per-candidate sim derives its worker task id from this
		// (`wasm/bulk_sim/batch.ts:67`: `${request.requestId}-${index}-${offset}`),
		// and `SimWorker.doApiCall` throws `ApiCall with empty id!` on a falsy id
		// (`worker_pool.ts:407`). Measured: without this every arm fails instantly.
		// Step 6's `buildBulkSimRequest` inherits this obligation.
		requestId: generateRequestId(SimRequest.bulkSimAsync),
	});
}

export async function runSpikeArm(
	arm: SpikeArm,
	baseRequestJson: Readonly<Record<string, unknown>>,
	candidateGear: readonly EquipmentSpec[],
	pool: WorkerPool,
): Promise<SpikeArmResult> {
	const request = buildSpikeRequest(baseRequestJson, candidateGear.slice(0, arm.candidateCount), arm.highStageIterations);
	const signalManager = new SimSignalManager();
	const signals = signalManager.registerRunning(RequestTypes.BulkSim);
	const provenance: SpikeProvenance = {
		isWasm: await pool.isWasm(),
		numWorkers: pool.getNumWorkers(),
		workerUrl: RESOLVED_WORKER_URL,
	};
	let baselineProgressEvents = 0;
	const startedAt = performance.now();
	console.log(`BULK_SPIKE_ARM_START ${JSON.stringify({ label: arm.label, n: arm.candidateCount, iters: arm.highStageIterations, pool: provenance.numWorkers })}`);
	try {
		const result = await runConcurrentBulkSim(
			request,
			pool,
			progress => {
				if (progress.finalBulkSimResult?.baseline) baselineProgressEvents += 1;
			},
			signals,
		);
		const elapsedSeconds = (performance.now() - startedAt) / 1000;
		if (result.error) {
			return {
				arm,
				provenance,
				stages: [],
				stageCount: 0,
				rowsReturned: 0,
				rowsWithDpsMetrics: 0,
				allCandidatesReturned: false,
				baselinePopulated: false,
				baselineDps: null,
				baselineProgressEvents,
				candidateIndices: [],
				elapsedSeconds,
				error: result.error.message || `error type ${result.error.type}`,
			};
		}
		const rowsWithDpsMetrics = result.topResults.filter(row => row.dpsMetrics).length;
		return {
			arm,
			provenance,
			stages: result.stageMetrics.map(metrics => ({
				stage: metrics.stage,
				iterations: metrics.iterations,
				survivors: metrics.survivors,
				durationSeconds: metrics.durationSeconds,
			})),
			stageCount: result.stageMetrics.length,
			rowsReturned: result.topResults.length,
			rowsWithDpsMetrics,
			allCandidatesReturned: result.topResults.length === arm.candidateCount && rowsWithDpsMetrics === arm.candidateCount,
			baselinePopulated: result.baseline !== undefined,
			baselineDps: result.baseline?.dpsMetrics?.avg ?? null,
			baselineProgressEvents,
			// `BulkGearResult.candidateIndex` (`proto/api.ts:1920`), not `index` —
			// the request side uses `index` (`BulkGearCandidate`) and the response
			// side uses `candidateIndex`. Step 7's mapping must use this name.
			candidateIndices: result.topResults.map(row => row.candidateIndex).sort((a, b) => a - b),
			elapsedSeconds,
		};
	} catch (err) {
		return {
			arm,
			provenance,
			stages: [],
			stageCount: 0,
			rowsReturned: 0,
			rowsWithDpsMetrics: 0,
			allCandidatesReturned: false,
			baselinePopulated: false,
			baselineDps: null,
			baselineProgressEvents,
			candidateIndices: [],
			elapsedSeconds: (performance.now() - startedAt) / 1000,
			error: err instanceof Error ? err.message : String(err),
		};
	} finally {
		signalManager.unregisterRunning(signals);
	}
}

/**
 * Step 2's arms (row completeness inside and just past the derived regime) plus
 * Step 3's pool-size probes at the expected shared constant, 25.
 */
export function spikeArms(): SpikeArm[] {
	return [
		{ label: 'step2-n19', candidateCount: 19, highStageIterations: 5000, poolSize: 4 },
		{ label: 'step2-n25', candidateCount: 25, highStageIterations: 5000, poolSize: 4 },
		{ label: 'step2-n32', candidateCount: 32, highStageIterations: 5000, poolSize: 4 },
		{ label: 'step2-n33', candidateCount: 33, highStageIterations: 5000, poolSize: 4 },
		{ label: 'step3-pool4', candidateCount: 25, highStageIterations: 5000, poolSize: 4 },
		{ label: 'step3-pool1', candidateCount: 25, highStageIterations: 5000, poolSize: 1 },
	];
}

/** One candidate: put `itemId` in `slotIndex`, leaving every other slot alone. */
export type CandidatePlacement = { itemId: number; slotIndex: number };

/**
 * Swaps one item into a copy of the baseline equipment per candidate, so each
 * candidate is fully-slotted legal gear that differs from the baseline and from
 * its siblings. Placements carry their own slot because the boundary arms need
 * more candidates than any single slot on the page supplies (the best slot here
 * has 29, and the n=32/33 arms need more), so they are drawn across slots. The
 * spike only needs distinct legal gear, not gear that is good.
 */
export function candidateEquipmentFrom(baselineItems: readonly ItemSpec[], placements: readonly CandidatePlacement[]): EquipmentSpec[] {
	return placements.map(({ itemId, slotIndex }) => {
		const items = baselineItems.map(item => ItemSpec.clone(item));
		if (items[slotIndex]) items[slotIndex] = ItemSpec.create({ id: itemId });
		return EquipmentSpec.create({ items });
	});
}

export type SpikeReport = {
	precondition: SpikeProvenance & { passed: boolean };
	results: SpikeArmResult[];
};

/**
 * Drives every arm and emits one `BULK_SPIKE_RESULT ` line per arm. A1.1's
 * binding precondition is checked first: if `isWasm()` is false the spike
 * refuses to run, because the numbers would describe the HTTP transport.
 */
export async function runSpike(
	baseRequestJson: Readonly<Record<string, unknown>>,
	candidateGear: readonly EquipmentSpec[],
	arms: readonly SpikeArm[] = spikeArms(),
): Promise<SpikeReport> {
	const probePool = new WorkerPool(4);
	const isWasm = await probePool.isWasm();
	const precondition = {
		isWasm,
		numWorkers: probePool.getNumWorkers(),
		workerUrl: RESOLVED_WORKER_URL,
		passed: isWasm === true,
	};
	console.log(`BULK_SPIKE_PRECONDITION ${JSON.stringify(precondition)}`);
	if (!precondition.passed) {
		(window as unknown as Record<string, unknown>).__bulkSpikeDone = true;
		(window as unknown as Record<string, unknown>).__bulkSpikeResults = { precondition, results: [] };
		throw new Error('bulk spike precondition failed: isWasm() is false — refusing to measure the HTTP transport as if it were WASM');
	}

	// A single cheap arm (n=2 @200) for smoke-testing the harness end to end
	// without paying for the full grid. Used to confirm the request-field fixes;
	// the real measurement is the arm list below.
	if (new URLSearchParams(window.location.search).get('bulkProbe') === '1') {
		const probeArm: SpikeArm = { label: 'probe-n2', candidateCount: 2, highStageIterations: 200, poolSize: probePool.getNumWorkers() };
		const probeResult = await runSpikeArm(probeArm, baseRequestJson, candidateGear, probePool);
		console.log(`BULK_SPIKE_RESULT ${JSON.stringify(probeResult)}`);
		(window as unknown as Record<string, unknown>).__bulkSpikeResults = { precondition, results: [probeResult] };
		(window as unknown as Record<string, unknown>).__bulkSpikeDone = true;
		return { precondition, results: [probeResult] };
	}

	// `?bulkArm=<label>` runs a single arm. The grid is tens of minutes, so
	// re-running all six to recover one interrupted arm wastes an hour; this
	// keeps a resumed measurement honest by re-running exactly the arm that was
	// lost rather than reporting a partial grid as complete.
	const only = new URLSearchParams(window.location.search).get('bulkArm');
	const selected = only ? arms.filter(arm => arm.label === only) : arms;
	if (only && selected.length === 0) {
		throw new Error(`bulk spike: no arm labelled '${only}' (have: ${arms.map(a => a.label).join(', ')})`);
	}

	const results: SpikeArmResult[] = [];
	for (const arm of selected) {
		const pool = arm.poolSize === probePool.getNumWorkers() ? probePool : new WorkerPool(arm.poolSize);
		const result = await runSpikeArm(arm, baseRequestJson, candidateGear, pool);
		results.push(result);
		console.log(`BULK_SPIKE_RESULT ${JSON.stringify(result)}`);
		(window as unknown as Record<string, unknown>).__bulkSpikeResults = { precondition, results };
	}
	(window as unknown as Record<string, unknown>).__bulkSpikeDone = true;
	return { precondition, results };
}
