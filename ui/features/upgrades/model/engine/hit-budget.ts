/**
 * The repair hit budget: hit read from a gear's stats, and the types the requests for each
 * copy layout are built with (`requestsPerLayout` in `rank.ts` builds them).
 */

import type { GemContext } from './candidate-gems';
import type { ChainBuild } from './gear-swap';
import type { GemRecolor, MetaRepairError } from './meta-repair';
import { RankError } from './rank-types';
import type { PlayerStatsObservation, RaidSimRequest } from './seams/sim-runner';
import { type BuildFailure, errorText, isBuildFailure } from './set-less-copies';
import { StopRefusedSim } from './sim-calls';

/**
 * A candidate's own stats read failed. Its own class, so `runCandidate` can
 * report only the read as that candidate's failed sim and still fail the run
 * on a code error around it.
 */
export class CandidateHitReadFailed extends Error {
	override readonly name = 'CandidateHitReadFailed';

	// `cause` as a field: the TS lib is es2021, which has no Error options.
	constructor(readonly cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause));
	}
}

/**
 * The hit percent a stats read gives. It throws when the value is not a
 * finite number: `hitPercentOrSimFailed` lets that error fail the run as an
 * internal error, and `candidateRepairGems` reports it as the candidate's
 * failed sim.
 */
export function hitPercentOf(observed: PlayerStatsObservation, pseudoStat: number): number {
	const hitPercent = observed.pseudoStats[pseudoStat];
	if (typeof hitPercent !== 'number' || !Number.isFinite(hitPercent)) {
		throw new Error(`hit percent read as ${String(hitPercent)}`);
	}
	return hitPercent;
}

/**
 * The hit percent of a worn-gear, baseline or set-phase stats read. A read
 * that fails fails the run with the sim's error, as a failed baseline sim
 * does; a read Stop ended rejects with `StopRefusedSim`. A read with no hit
 * number is no sim failure: `hitPercentOf`'s error fails the run as internal.
 */
export async function hitPercentOrSimFailed(
	read: Promise<PlayerStatsObservation>,
	pseudoStat: number,
): Promise<{ observed: PlayerStatsObservation; hitPercent: number }> {
	let observed: PlayerStatsObservation;
	try {
		observed = await read;
	} catch (err) {
		if (err instanceof StopRefusedSim) throw err;
		throw new RankError('sim-failed', errorText(err));
	}
	return { observed, hitPercent: hitPercentOf(observed, pseudoStat) };
}

/** `{}` sends no copies. */
export type CopyLayout = {
	setKept?: readonly number[];
	setLess?: readonly number[];
};

export type LayoutRequest = {
	request: RaidSimRequest;
	recolors: readonly GemRecolor[];
};

/**
 * An entry whose gear, repaired again on its own hit budget, failed the gem
 * repair. It is no failed call, so a caller treats it like the same failure
 * on the first build, never as a request that could not be built: a build
 * error's line carries `RunNote.error`, which the run's error toast
 * shows.
 */
type RepairFailure = { repairError: MetaRepairError };

export type LayoutResult = LayoutRequest | BuildFailure | RepairFailure;

export const isRepairFailure = (entry: LayoutResult | undefined): entry is RepairFailure => entry !== undefined && 'repairError' in entry;

/** The first failed repair, or every entry when none failed. */
export const repairErrorOr = (entries: readonly LayoutResult[]): MetaRepairError | Array<LayoutRequest | BuildFailure> =>
	entries.find(isRepairFailure)?.repairError ?? entries.filter((entry): entry is LayoutRequest | BuildFailure => !isRepairFailure(entry));

/**
 * The requests for one set-phase gear, one per copy layout, each with gems
 * repaired on its own hit budget; both sims of a pair come from one call
 * (`rankUpgrades` defines it). `base` is the gear on the run's budget;
 * `rebuild` builds the same gear on another. An entry is a `BuildFailure`
 * when its request cannot be composed, and a `RepairFailure` when its rebuild
 * fails gem repair, unless Stop ends a later read in the same call.
 */
export type RequestsPerCopyLayout = (rebuild: (gems: GemContext) => ChainBuild, base: ChainBuild, copiesList: readonly CopyLayout[]) => Promise<LayoutResult[]>;

export const requestOf = (entry: LayoutRequest | BuildFailure): RaidSimRequest | BuildFailure => (isBuildFailure(entry) ? entry : entry.request);

/**
 * Missed hit below this many rating keeps a request on the run's budget. On
 * the measured gear, gem, item and enchant hit cancel inside `missed`, so
 * what is left is set-bonus hit, a whole number of rating (20 on Burning
 * Rage's 2pc); the tolerance only absorbs the percent round trip.
 */
export const MISSED_HIT_TOLERANCE = 0.5;
