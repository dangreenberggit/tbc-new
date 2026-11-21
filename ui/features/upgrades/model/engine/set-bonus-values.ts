/**
 * `measurePairTwoPiece`: a set's 2pc value from one sim of two of its pieces, which the set
 * phase needs to give the 4pc a `bonusDpsNet`.
 */

import type { GemContext } from './candidate-gems';
import { type ChainBuild, chainSwapsWithRepairs } from './gear-swap';
import { isRepairFailure, type RequestsPerCopyLayout } from './hit-budget';
import { MetaRepairError } from './meta-repair';
import type { Deps } from './rank-types';
import { SET_BONUS_SKIP_REASONS, type SkipReason } from './run-notes';
import type { RaidSimRequest, SimRunOpts } from './seams/sim-runner';
import { errorText, isBuildFailure } from './set-less-copies';
import { combineSe, type DpsSample, type OwnDelta, type PlacedItem } from './set-value';
import { cacheSimResult, readCachedSim } from './sim-calls';
import type { SimItemSpec } from './slots';

/**
 * One sim of two set pieces that lose no worn bonus, added together at worn
 * 1: the 2pc's value is their own gains minus the pair's gain. Undefined when
 * the gem repair or the sim fails; the caller then leaves the 4pc's
 * `bonusDpsNet` unset. Why goes to `onNotMeasured` with the error, except for
 * a sim Stop refused.
 */
export async function measurePairTwoPiece(
	bonusLabel: string,
	deps: Deps,
	pair: readonly PlacedItem[],
	equipment: readonly SimItemSpec[],
	gems: GemContext,
	composeFor: (equipment: readonly SimItemSpec[]) => RaidSimRequest,
	ownDeltasByItemId: ReadonlyMap<number, OwnDelta>,
	baseline: DpsSample,
	simVersion: string,
	runOpts: SimRunOpts,
	requestsPerLayout: RequestsPerCopyLayout,
	onNotMeasured: (reason: SkipReason) => void,
): Promise<{ dps: number; se: number } | undefined> {
	let pairBuild: ChainBuild;
	try {
		pairBuild = chainSwapsWithRepairs(equipment, pair, gems);
	} catch (err) {
		if (!(err instanceof MetaRepairError)) throw err;
		console.warn(`[upgrades] ${bonusLabel} net value not measured: gem repair failed for the worn-1 pair that measures the 2pc`, err);
		onNotMeasured(SET_BONUS_SKIP_REASONS.metaOff(err.message));
		return undefined;
	}
	const [entry] = await requestsPerLayout(g => chainSwapsWithRepairs(equipment, pair, g), pairBuild, [{}]);
	if (isRepairFailure(entry)) {
		console.warn(`[upgrades] ${bonusLabel} net value not measured: gem repair failed for the worn-1 pair that measures the 2pc`, entry.repairError);
		onNotMeasured(SET_BONUS_SKIP_REASONS.metaOff(entry.repairError.message));
		return undefined;
	}
	if (!entry || isBuildFailure(entry)) {
		console.warn(
			`[upgrades] ${bonusLabel} net value not measured: the request for the worn-1 pair that measures the 2pc could not be built`,
			entry?.buildError,
		);
		if (entry) onNotMeasured(SET_BONUS_SKIP_REASONS.notBuilt(entry.buildError));
		return undefined;
	}
	const request = entry.request;
	let obs = await readCachedSim(deps, request, simVersion, runOpts);
	if (!obs) {
		try {
			obs = await deps.sim.run(request, runOpts);
		} catch (err) {
			// No warning for a sim the Stop guard refused.
			if (!deps.signal?.aborted) {
				console.warn(`[upgrades] ${bonusLabel} net value not measured: the sim failed for the worn-1 pair that measures the 2pc`, err);
				onNotMeasured(SET_BONUS_SKIP_REASONS.simFailed(errorText(err)));
			}
			return undefined;
		}
		await cacheSimResult(deps, request, simVersion, runOpts, obs);
	}
	const ownDeltas = pair.map(p => ownDeltasByItemId.get(p.itemId)!);
	const pairSample: DpsSample = {
		dps: obs.dps,
		se: obs.stdev / Math.sqrt(runOpts.iterations),
	};
	return {
		dps: ownDeltas.reduce((sum, s) => sum + s.deltaDps, 0) - (pairSample.dps - baseline.dps),
		se: combineSe([baseline, pairSample, ...ownDeltas.map(s => ({ dps: 0, se: s.se }))]),
	};
}
