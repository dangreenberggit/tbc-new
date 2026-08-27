/**
 * Skeleton serialization (plan §2.3, decision D5) — the page's *current* sim
 * state, protojson-shaped, without `simOptions`. D5: our sim must match the
 * user's by construction, so the skeleton is never anything the user did not
 * themselves configure on the page.
 *
 * `Sim.makeRaidSimRequest(debug)` (`ui/core/sim.ts`) is upstream's own
 * request builder — the same one the page's Simulate button runs — so this
 * calls it directly rather than re-deriving raid/encounter/player state by
 * hand. `debug: false` is what the page's own Simulate button passes for a
 * real run (`runRaidSim`/`runRaidSimWithLogs` both call
 * `makeRaidSimRequest(false)`); `debug: true` forces `iterations: 1`, which
 * would make every candidate sim meaningless.
 *
 * `simOptions` and `requestId` are stripped, mirroring engine/compose.ts's
 * own `delete req.simOptions; delete req.requestId` — compose() is what
 * patches this skeleton per candidate, and PLAN.md §7 [R6] requires the
 * cache key to be formed before seed/iterations are injected. `WasmSimRunner`
 * (wasm_sim_runner.ts) is what injects them back, once, right before the
 * actual sim call.
 */

import { RaidSimRequest as RaidSimRequestProto } from '../../../../proto/api.js';
import type { IndividualSimUI } from '../../../../individual_sim_ui.js';
import type { RaidSimRequest } from '../engine/seams/sim-runner.js';

export function currentPageSkeleton(simUI: IndividualSimUI<any>): RaidSimRequest {
	const proto = simUI.sim.makeRaidSimRequest(false);
	const json = RaidSimRequestProto.toJson(proto) as Record<string, unknown>;
	delete json.simOptions;
	delete json.requestId;
	return json as RaidSimRequest;
}
