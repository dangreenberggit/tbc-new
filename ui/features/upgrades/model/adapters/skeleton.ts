/**
 * Skeleton serialization (plan §2.3, decision D5) — the page's *current* sim
 * state, in protojson form, without `simOptions`. D5: our sim must match the
 * user's by construction, so the skeleton is never anything the user did not
 * themselves configure on the page.
 *
 * `Sim.makeRaidSimRequest(options)` (`ui/sim/sim.ts:299`) is upstream's own
 * request builder — the same one the page's Simulate button runs — so this
 * calls it directly rather than re-deriving raid/encounter/player state by
 * hand. Empty options are a real run's request; `singleIteration` would force
 * `iterations: 1`, which would make every candidate sim meaningless.
 *
 * `simOptions` and `requestId` are stripped, mirroring engine/compose.ts's
 * own `delete req.simOptions; delete req.requestId` — compose() is what
 * patches this skeleton per candidate, and PLAN.md §7 [R6] requires the
 * cache key to be formed before seed/iterations are injected. `WorkerPoolSimRunner`
 * (worker_pool_sim_runner.ts) is what injects them back, once, right before the
 * actual sim call.
 */

import { RaidSimRequest as RaidSimRequestProto } from '@generated/proto/api';
import type { Spec } from '@generated/proto/common';
import type { IndividualSimHost } from '@sim/sim_host';

import type { RaidSimRequest } from '../engine/seams/sim-runner';

export function currentPageSkeleton(simUI: IndividualSimHost<Spec>): RaidSimRequest {
	const proto = simUI.sim.makeRaidSimRequest({});
	const json = RaidSimRequestProto.toJson(proto) as Record<string, unknown>;
	delete json.simOptions;
	delete json.requestId;
	return json as RaidSimRequest;
}
