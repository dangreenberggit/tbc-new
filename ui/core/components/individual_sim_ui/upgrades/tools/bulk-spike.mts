/**
 * Bulk-sim spike (plan-web Steps 2 and 3).
 *
 * Answers two questions the plan must measure rather than model:
 *
 *   Step 2 — where the TS cull boundary actually sits, by running synthetic
 *            requests at n = 19, 20, 25, 30 candidates x highStageIterations
 *            3,000 and 5,000 and recording, per arm, the stages run, the
 *            survivors, and whether every candidate came back with a row.
 *   Step 3 — whether `runConcurrentBulkSim` can be called directly from our
 *            own adapter with our own `WorkerPool`, at pool sizes 4 and 1.
 *
 * PRECONDITION — read this before trying to run the file. `runConcurrentBulkSim`
 * reaches a real WASM sim only through `WorkerPool`, whose `SimWorker`
 * constructor calls `new window.Worker('/tbc/sim_worker.js')`
 * (`ui/core/worker_pool.ts:32,309`). That is a browser Web Worker loading a
 * site-absolute URL, and the worker itself boots by
 * `WebAssembly.instantiateStreaming(fetch('lib.wasm'))`
 * (`ui/worker/sim_worker.ts:123`). The headless harness in `headless.mts`
 * shims `window` as an inert object with no `Worker`, deliberately: its
 * doc comment states that a shim growing beyond an inert placeholder is the
 * signal that the thing being borrowed is UI behaviour rather than a pure
 * decision. A WASM sim worker is exactly that.
 *
 * So this spike does NOT run under `node --import <tsx-loader>`, which is what
 * plan-web C11 assumed. It is written to run in the browser, against the built
 * site, where `window.Worker` and `/tbc/sim_worker.js` are both real. See the
 * executor ledger's Step 2/3 rows for the flag this raised.
 *
 * Not part of the site build; not under `engine/`, so no PROVENANCE row
 * (`tools/README.md:11`).
 */

import { BulkGearCandidate, BulkSimRequest, RaidSimRequest as RaidSimRequestProto } from '../../../../proto/api.js';
import { EquipmentSpec } from '../../../../proto/common.js';
import { RequestTypes, SimSignalManager } from '../../../../sim_signal_manager.js';
import { WorkerPool } from '../../../../worker_pool.js';
import { runConcurrentBulkSim } from '../../../../wasm/bulk_sim/index.js';

export type SpikeArm = {
	candidateCount: number;
	highStageIterations: number;
	poolSize: number;
};

export type SpikeArmResult = {
	arm: SpikeArm;
	/** One entry per stage the tournament actually ran. */
	stages: { stage: number; iterations: number; survivors: number; durationSeconds: number }[];
	rowsReturned: number;
	/** R2: a row present but lacking `dpsMetrics` is dropped by `statistics.ts:107`. */
	rowsWithDpsMetrics: number;
	allCandidatesReturned: boolean;
	baselinePopulated: boolean;
	/** C15: at least one baseline probe per chunk; adaptive passes can add more. */
	baselineSegments: number;
	error?: string;
};

/**
 * Builds the spike's request. `topResults` is set to the candidate count per
 * L-new-1 — the default is 5 (`wasm/bulk_sim/constants.ts:1`) and truncates the
 * response independently of culling, so without this the row-count measurement
 * would fail for a reason that has nothing to do with the cull boundary.
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
	// only the static types disagree. `wasm_sim_runner.ts:112` never hits this
	// because it passes a fresh object literal, so the cast is new at this
	// boundary — Step 6's builder inherits it and should carry the same note.
	const baseRequest = RaidSimRequestProto.fromJson(baseRequestJson as Record<string, never>, { ignoreUnknownFields: true });
	return BulkSimRequest.create({
		baseRequest,
		candidates: candidateGear.map((gear, index) => BulkGearCandidate.create({ index, gear })),
		topResults: candidateGear.length,
		highStageIterations,
	});
}

export async function runSpikeArm(
	arm: SpikeArm,
	baseRequestJson: Readonly<Record<string, unknown>>,
	candidateGear: readonly EquipmentSpec[],
): Promise<SpikeArmResult> {
	const request = buildSpikeRequest(baseRequestJson, candidateGear.slice(0, arm.candidateCount), arm.highStageIterations);
	const pool = new WorkerPool(arm.poolSize);
	const signalManager = new SimSignalManager();
	const signals = signalManager.registerRunning(RequestTypes.BulkSim);
	let baselineSegments = 0;
	try {
		const result = await runConcurrentBulkSim(
			request,
			pool,
			progress => {
				if (progress.finalBulkSimResult?.baseline) baselineSegments += 1;
			},
			signals,
		);
		if (result.error) {
			return {
				arm,
				stages: [],
				rowsReturned: 0,
				rowsWithDpsMetrics: 0,
				allCandidatesReturned: false,
				baselinePopulated: false,
				baselineSegments,
				error: result.error.message,
			};
		}
		const rowsWithDpsMetrics = result.topResults.filter(row => row.dpsMetrics).length;
		return {
			arm,
			stages: result.stageMetrics.map(metrics => ({
				stage: metrics.stage,
				iterations: metrics.iterations,
				survivors: metrics.survivors,
				durationSeconds: metrics.durationSeconds,
			})),
			rowsReturned: result.topResults.length,
			rowsWithDpsMetrics,
			// R4: baseline is a separate field, never an n+1th row.
			allCandidatesReturned: result.topResults.length === arm.candidateCount && rowsWithDpsMetrics === arm.candidateCount,
			baselinePopulated: result.baseline !== undefined,
			baselineSegments,
		};
	} finally {
		signalManager.unregisterRunning(signals);
	}
}

/** Step 2's eight arms, plus Step 3's pool-size-1 probe. */
export const STEP_2_ARMS: readonly SpikeArm[] = [19, 20, 25, 30].flatMap(candidateCount =>
	[3000, 5000].map(highStageIterations => ({ candidateCount, highStageIterations, poolSize: 4 })),
);

export function formatArmTable(results: readonly SpikeArmResult[]): string {
	const header = '| n | highStageIterations | pool | stages | survivors | rows | rows w/ dpsMetrics | all returned? |';
	const divider = '| --- | --- | --- | --- | --- | --- | --- | --- |';
	const rows = results.map(r => {
		const stages = r.stages.map(s => s.stage).join('/') || '(none)';
		const survivors = r.stages.map(s => s.survivors).join('/') || '(none)';
		return `| ${r.arm.candidateCount} | ${r.arm.highStageIterations} | ${r.arm.poolSize} | ${stages} | ${survivors} | ${r.rowsReturned} | ${r.rowsWithDpsMetrics} | ${r.allCandidatesReturned ? 'yes' : 'NO'} |`;
	});
	return [header, divider, ...rows].join('\n');
}
