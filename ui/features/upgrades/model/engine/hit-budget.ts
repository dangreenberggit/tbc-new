/**
 * The repair hit budget: the baseline's stats read that sets it, hit read from a gear's
 * stats, and the budget's correction by a stats read for each set-phase gear
 * (`makeRequestsPerLayout`) and for a candidate that turns the meta off
 * (`candidateRepairGems`).
 */

import type { GemContext } from './candidate-gems';
import { type CapProfile, hitCapBudgetFrom, perSpellHitTalentTaken } from './cap-profile';
import { gearHitRating } from './caps';
import type { RunNote } from './disclosure';
import { candidateSwapPreRepair, type ChainBuild } from './gear-swap';
import { type GemRecolor, inactiveMeta, MetaRepairError } from './meta-repair';
import type { RunContext } from './rank-setup';
import { type Deps, RankError } from './rank-types';
import { hitCapFullWeightNote, hitCapPerSpellTalentNote, hitCapUnknownNote } from './run-notes';
import { type PlayerStatsObservation, type RaidSimRequest, type SimObservation, type SpellDamageBySchool, stableStringify } from './seams/sim-runner';
import { applyCopies, type BuildFailure, errorText, isBuildFailure } from './set-less-copies';
import { readStats, StopRefusedSim } from './sim-calls';

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

/**
 * One stats read of `request`: its hit percent and the `HitCapBudget` it
 * gives. A spell-hit budget also needs a sim result's spell damage by
 * school.
 */
export async function readHitCap(deps: Deps, capProfile: CapProfile, request: RaidSimRequest, slot: number, spellDamageBySchool?: SpellDamageBySchool) {
	const { observed, hitPercent } = await hitPercentOrSimFailed(readStats(deps.sim, request, deps.signal), slot);
	return {
		hitPercent,
		budget: hitCapBudgetFrom(capProfile, request, observed.pseudoStats, spellDamageBySchool),
	};
}

function talentsStringFromRequest(request: RaidSimRequest): string | undefined {
	const raw = (
		request as {
			raid?: {
				parties?: Array<{ players?: Array<{ talentsString?: string }> }>;
			};
		}
	).raid?.parties?.[0]?.players?.[0]?.talentsString;
	return typeof raw === 'string' ? raw : undefined;
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
 * (`makeRequestsPerLayout` builds it). `base` is the gear on the run's budget;
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

/**
 * What the baseline's stats read settles. `gems` is the gem context every
 * later repair site starts from: with `repairHitBudget` when the read gave a
 * budget, else as setup built it.
 */
export type BaselineHitBudget = {
	gems: GemContext;
	/** The baseline's sim hit rating, once the budget is set. */
	baselineSimHit: number | undefined;
	/**
	 * How repair priced hit where the ranking cannot show it: no cap used
	 * (a full-weight spec, or a target not at level 73), or a per-spell hit
	 * talent the cap leaves out.
	 */
	hitCapNotes: RunNote[];
};

/**
 * One stats read of the baseline, which sets the repair hit budget, and the
 * notes on how repair priced hit. A read Stop ended leaves `gems` as it
 * came and adds no note; a read that fails fails the run.
 */
export async function readBaselineHitBudget(ctx: RunContext, gems: GemContext, observation: SimObservation): Promise<BaselineHitBudget> {
	const { deps, capProfile, hitPercentStat, equipment, request } = ctx;
	let baselineSimHit: number | undefined;
	const hitCapNotes: RunNote[] = [];
	if (hitPercentStat !== undefined) {
		try {
			const { hitPercent, budget } = await readHitCap(deps, capProfile, request, hitPercentStat, observation.spellDamageBySchool);
			if (budget) {
				gems = {
					...gems,
					repairHitBudget: {
						stat: budget.stat,
						baselineRemaining: budget.remaining,
						baselineGearHit: gearHitRating(equipment, budget.stat),
						...(budget.groups ? { groups: budget.groups } : {}),
					},
				};
				baselineSimHit = hitPercent * capProfile.ratingPerPercent;
				const talent = perSpellHitTalentTaken(capProfile, talentsStringFromRequest(request));
				if (talent !== undefined) {
					hitCapNotes.push(hitCapPerSpellTalentNote(talent));
				}
			} else {
				hitCapNotes.push(hitCapUnknownNote());
			}
		} catch (err) {
			if (!(err instanceof StopRefusedSim)) throw err;
		}
	} else if (capProfile.repair.kind === 'fullWeight') {
		hitCapNotes.push(hitCapFullWeightNote());
	}
	return { gems, baselineSimHit, hitCapNotes };
}

/**
 * The requests for one set-phase gear and its copies, each with gems
 * repaired on its own hit budget. A request's missed hit is the set-bonus
 * hit that counting gear hit alone cannot see:
 * `sim hit(request) − sim hit(baseline) − (gear hit(build) − gear hit(baseline))`,
 * with gear hit taken on real item ids before the copies. A gear whose
 * repair changed nothing is never read. One read per distinct request,
 * raced against Stop. The first read Stop ends turns this off for this
 * call and every later one, so the two sims of a pair never use different
 * gems. A read that fails fails the run.
 */
export function makeRequestsPerLayout(ctx: RunContext, baselineHitBudget: BaselineHitBudget): RequestsPerCopyLayout {
	const { deps, composeFor, capProfile, hitPercentStat } = ctx;
	const { gems, baselineSimHit } = baselineHitBudget;
	const statsReadsByRequest = new Map<string, Promise<PlayerStatsObservation>>();
	let perGearHitBudgetsOff = false;
	return async (rebuild, base, copiesList) => {
		let plain: RaidSimRequest | BuildFailure;
		try {
			plain = composeFor(base.equipment);
		} catch (err) {
			plain = { buildError: errorText(err) };
		}
		const defaults = copiesList.map((copies): RaidSimRequest | BuildFailure => {
			if (isBuildFailure(plain)) return plain;
			try {
				return applyCopies(plain, copies);
			} catch (err) {
				return { buildError: errorText(err) };
			}
		});
		const shared = () => defaults.map(request => (isBuildFailure(request) ? request : { request, recolors: base.recolors }));
		const hitBudget = gems.repairHitBudget;
		if (!base.repaired || !hitBudget || hitPercentStat === undefined || baselineSimHit === undefined || perGearHitBudgetsOff) {
			return shared();
		}
		try {
			const buildHit = gearHitRating(base.equipment, hitBudget.stat);
			const out: LayoutResult[] = [];
			for (let i = 0; i < copiesList.length; i++) {
				const request = defaults[i]!;
				if (isBuildFailure(request)) {
					out.push(request);
					continue;
				}
				const key = stableStringify(request);
				let read = statsReadsByRequest.get(key);
				if (!read) {
					read = readStats(deps.sim, request, deps.signal);
					statsReadsByRequest.set(key, read);
				}
				const { hitPercent } = await hitPercentOrSimFailed(read, hitPercentStat);
				const missed = missedHit(hitPercent, capProfile, baselineSimHit, buildHit, hitBudget);
				if (Math.abs(missed) < MISSED_HIT_TOLERANCE) {
					out.push({ request, recolors: base.recolors });
					continue;
				}
				let rebuilt: ChainBuild;
				try {
					rebuilt = rebuild(withShiftedBudget(gems, hitBudget, missed));
				} catch (err) {
					if (!(err instanceof MetaRepairError)) throw err;
					out.push({ repairError: err });
					continue;
				}
				out.push({
					request: applyCopies(composeFor(rebuilt.equipment), copiesList[i]!),
					recolors: rebuilt.recolors,
				});
			}
			return out;
		} catch (err) {
			if (!(err instanceof StopRefusedSim)) throw err;
			perGearHitBudgetsOff = true;
			return shared();
		}
	};
}

/**
 * The gem context one candidate's repair runs with. The run's hit budget
 * moves by the swap's gear hit, which misses set-bonus hit the swap breaks
 * or completes (a warlock's Mana-Etched head breaks a +35 spell hit set).
 * So when the swap turns the meta off, the candidate's own stats read
 * corrects the budget, as `requestsPerLayout` does above. The read runs on the
 * candidate sim's worker, so a failed read rejects with
 * `CandidateHitReadFailed`, reported as that candidate's failed sim; a
 * read Stop refused rejects with `StopRefusedSim`.
 */
export async function candidateRepairGems(ctx: RunContext, baselineHitBudget: BaselineHitBudget, slotIndex: number, itemId: number): Promise<GemContext> {
	const { deps, composeFor, capProfile, hitPercentStat, equipment } = ctx;
	const { gems, baselineSimHit } = baselineHitBudget;
	const hitBudget = gems.repairHitBudget;
	if (!hitBudget || hitPercentStat === undefined || baselineSimHit === undefined) {
		return gems;
	}
	const pre = candidateSwapPreRepair(equipment, slotIndex, itemId, gems);
	if (!inactiveMeta(pre.socketed)) return gems;
	const request = composeFor(pre.swapped);
	let hitPercent: number;
	try {
		hitPercent = hitPercentOf(await readStats(deps.sim, request, deps.signal), hitPercentStat);
	} catch (err) {
		if (err instanceof StopRefusedSim) throw err;
		throw new CandidateHitReadFailed(err);
	}
	const missed = missedHit(hitPercent, capProfile, baselineSimHit, gearHitRating(pre.swapped, hitBudget.stat), hitBudget);
	if (Math.abs(missed) < MISSED_HIT_TOLERANCE) return gems;
	return withShiftedBudget(gems, hitBudget, missed);
}

/** The repair hit budget on a gem context, never absent. */
type RepairHitBudget = NonNullable<GemContext['repairHitBudget']>;

/**
 * A gear's missed hit: the hit its stats read shows beyond the baseline's,
 * less the part its gear hit already counts. What is left is set-bonus hit
 * the gear breaks or completes.
 */
function missedHit(hitPercent: number, capProfile: CapProfile, baselineSimHit: number, buildGearHit: number, hitBudget: RepairHitBudget): number {
	return hitPercent * capProfile.ratingPerPercent - baselineSimHit - (buildGearHit - hitBudget.baselineGearHit);
}

/** `gems` with the run's hit budget moved by a gear's missed hit. */
function withShiftedBudget(gems: GemContext, hitBudget: RepairHitBudget, missed: number): GemContext {
	return {
		...gems,
		repairHitBudget: {
			...hitBudget,
			baselineRemaining: hitBudget.baselineRemaining - missed,
		},
	};
}
