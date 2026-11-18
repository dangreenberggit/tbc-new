/**
 * The page's sim state as a protojson request from `Sim.makeRaidSimRequest`, as the
 * Simulate button builds it. `simOptions` and `requestId` are stripped so the cache
 * key forms before seed and iterations go in; `WorkerPoolSimRunner` puts them back.
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
