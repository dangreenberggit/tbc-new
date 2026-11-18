/**
 * The page's current sim state as a protojson request, without `simOptions`.
 * The tab's sims must match the page's, so the skeleton holds only what the
 * user configured.
 *
 * It calls `Sim.makeRaidSimRequest` (`ui/sim/sim.ts`), the builder the page's
 * Simulate button runs. Empty options give a real run's request;
 * `singleIteration` would force `iterations: 1`.
 *
 * `simOptions` and `requestId` are stripped, as compose() strips them, so the
 * cache key is formed before seed and iterations go in. `WorkerPoolSimRunner`
 * puts them back right before the sim call.
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
