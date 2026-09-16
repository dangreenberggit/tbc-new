/**
 * Builds the typed `BulkSimRequest` both transports send.
 *
 * This is the one place protojson becomes a typed proto for the bulk path. The
 * WASM runner hands the result straight to `runConcurrentBulkSim`; the Go runner
 * serialises the same object over HTTP. Single-sourcing it is the point — the
 * two transports must not drift on request shape, and every obligation below was
 * found by running the request, not by reading the proto.
 */

import { SimRequest } from '../../../../../worker/types.js';
import { BulkGearCandidate, BulkSimRequest, RaidSimRequest as RaidSimRequestProto } from '../../../../proto/api.js';
import { EquipmentSpec } from '../../../../proto/common.js';
import { shouldUseLegacyBulkSim } from '../../../../wasm/bulk_sim/estimate.js';
import { generateRequestId } from '../../../../worker_pool.js';
import type { BulkScreenRequest } from '../engine/seams/sim-runner.js';
// A value import, not `import type`: `BulkScreenIntegrityError` is thrown here.
import { BulkScreenIntegrityError } from '../engine/seams/sim-runner.js';

/**
 * Asserts that a built chunk will take the single-stage (High-only) path, where
 * nothing is culled and every candidate comes back with a row (ticket 349).
 *
 * It calls **upstream's own** `shouldUseLegacyBulkSim` on the actual request
 * rather than transcribing its formula: the estimator reads
 * `highStageIterations`, the stage table's minimum iterations and survivor
 * limits, and its own minimum-combinations floor, and a mirrored copy here
 * would drift the first time any of those moved. `true` from that function is
 * the legacy — that is, single-stage — path.
 *
 * It runs client-side on **both** transports, including the Go one, because
 * Go's `sim/core/bulk/estimate.go` is the same formula over the same constants
 * (minCombinations 20; Medium 1000/25; Low 100/100), and both engines were
 * measured flipping at the same n. So checking the TypeScript estimator against
 * the request that is about to be posted is a check on what the Go server will
 * do with it.
 *
 * Today's `MAX_CANDIDATES_PER_BULK_REQUEST` of 25 is single-stage at every
 * iteration count, so this can only fire if the constant is raised — which is
 * the point: a future 27 would otherwise cull silently above 28,000 iterations.
 *
 * It throws `BulkScreenIntegrityError`, the same class the response-side checks
 * use, because that class is what makes a failure loud: the driver rethrows it
 * unconditionally and `rank.ts` rethrows it rather than degrading. A bare
 * `Error` here would land in the generic branch at both sites and turn a raised
 * bound — the one condition this guard exists to catch — into a `screeningFallbacks`
 * entry and a quiet fall back to the per-candidate loop.
 */
export function assertSingleStageChunk(request: BulkSimRequest, candidateCount: number): void {
	if (shouldUseLegacyBulkSim(request, candidateCount)) return;
	throw new BulkScreenIntegrityError(
		`bulk chunk of ${candidateCount} candidates at ${request.highStageIterations} iterations would take ` +
			`the multi-stage (culling) path; keep MAX_CANDIDATES_PER_BULK_REQUEST <= 26 — see engine/bulk/partition.ts`,
	);
}

/**
 * Four things this must get right, each of which fails loudly-but-obscurely if
 * missed:
 *
 * 1. **`simOptions`** — `engine/compose.ts:34` deletes it deliberately (the
 *    per-candidate runner supplies iterations and seed itself), but
 *    `validateBulkSimRequest` rejects a request without it
 *    (`wasm/bulk_sim/index.ts:49`) and the tournament reads
 *    `baseRequest.simOptions.iterations` for its baseline probe (`:91,:157`).
 * 2. **`topResults`** — defaults to 5 (`wasm/bulk_sim/constants.ts:1`) and
 *    truncates the response independently of culling
 *    (`wasm/bulk_sim/statistics.ts:104-111`), so it must be the candidate count
 *    or most rows silently vanish. On the Go server it also sizes the finalist
 *    stage, so that forced equality refines every candidate (ticket 403).
 * 3. **`requestId`** — every per-candidate worker task id is derived from it
 *    (`wasm/bulk_sim/batch.ts:67`), and `SimWorker.doApiCall` throws
 *    `ApiCall with empty id!` on a falsy id (`worker_pool.ts:407`).
 * 4. **The embedded `SimDatabase` must already cover every candidate item.**
 *    A bulk request carries ONE `player.database` for all candidates, while the
 *    per-candidate loop composes a fresh one per request. `lib.wasm` is built
 *    without `with_db`, so an item absent from that database makes the sim panic
 *    with "No item with id: N" (`adapters/sim_database.ts:19-22`) — and the
 *    panic surfaces only after the whole candidate queue drains
 *    (`batch.ts:131-133` aborts, `index.ts:121-122` reports after the batch
 *    settles), so it presents as a wedged run rather than an error. This builder
 *    cannot fix that by itself: the database rides on `baseRequest`, so the
 *    CALLER must compose it as the union over the baseline and every candidate.
 *    Stated here because this is where the requirement is discoverable.
 */
export function buildBulkSimRequest(req: BulkScreenRequest): BulkSimRequest {
	// The seam types a request as `Readonly<Record<string, unknown>>` on purpose
	// (`engine/seams/sim-runner.ts` header — the engine stays proto-unaware), but
	// protobuf-ts's `fromJson` wants a `JsonValue`, which an index signature of
	// `unknown` does not satisfy. Both describe the same protojson object; only
	// the static types disagree.
	const withSimOptions = {
		...req.baseRequest,
		simOptions: {
			iterations: req.iterations,
			// protobuf-ts int64 accepts a numeric string on fromJson — same
			// convention `wasm_sim_runner.ts` already uses for a seed. The value
			// comes from the caller (`BulkScreenRequest.seed`), not a constant
			// here: the screening pass must run at the seed the per-candidate path
			// would have used, and a literal is only right for as long as it
			// happens to equal the caller's first seed.
			randomSeed: String(req.seed),
			debugFirstIteration: false,
		},
	};
	const baseRequest = RaidSimRequestProto.fromJson(withSimOptions as unknown as Record<string, never>, { ignoreUnknownFields: true });

	return BulkSimRequest.create({
		baseRequest,
		candidates: req.candidates.map(candidate =>
			BulkGearCandidate.create({
				index: candidate.index,
				gear: EquipmentSpec.fromJson(candidate.gear as unknown as Record<string, never>, { ignoreUnknownFields: true }),
			}),
		),
		topResults: req.candidates.length,
		highStageIterations: req.iterations,
		requestId: generateRequestId(SimRequest.bulkSimAsync),
	});
}
