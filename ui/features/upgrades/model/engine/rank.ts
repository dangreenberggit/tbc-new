/**
 * rankUpgrades: the engine's entry point, RankInput → Ranking.
 *
 * No spec-mismatch check: the gear source reads the page's gear under the
 * page's selected spec, so it always matches `input.spec`, and
 * `LoggedGear.className`/`specIdHint` go unused. The content hash is the
 * canonical-JSON string itself, not a digest, like `simCacheKey` in
 * seams/sim-runner.ts.
 */

import { type GemContext, gemContext } from './candidate-gems';
import { capProfileFor } from './cap-profile';
import { compose } from './compose';
import { CUTOFF } from './cutoff';
import { buildStandingAssumptions, notesFromMetaRepair } from './disclosure';
import { applyRepairedGems } from './gear-swap';
import { gemsForPhase } from './gems';
import { type BaselineHitBudget, makeRequestsPerLayout, readBaselineHitBudget } from './hit-budget';
import { equipmentFromLoggedGear } from './logged-gear';
import type { GemRecolor } from './meta-repair';
import { type CandidateResults, runCandidates } from './rank-candidates';
import { applyReplicatedDeltas, type ReplicatedRow, replicateTopItems, type SimCounts } from './rank-replication';
import {
	type EligibleCandidates,
	eligibleCandidates,
	presetIdFor,
	raceFromSkeleton,
	rankingContentHash,
	repairWornMeta,
	resolveFight,
	resolveSeeds,
	type RunContext,
} from './rank-setup';
import { type Deps, type PartialRanking, type Progress, type RankedItem, RankError, type Ranking, type RankInput, type ResolvedFight } from './rank-types';
import { candidateSkipNote, metaPreferenceNotes, offHandBlockedNotes, oneHandBlockedNotes, uniqueNotes } from './run-notes';
import type { SimObservation } from './seams/sim-runner';
import { emptySetPhase, runSetPhase, type SetPhaseOutcome } from './set-phase';
import { asInternal, rankingCacheKey, simOrFailure, stopGuardedDeps, StopRefusedSim } from './sim-calls';
import type { SimItemSpec } from './slots';
export {
	type RankInput,
	type Deps,
	type Progress,
	type RankErrorKind,
	RankError,
	type RankedItem,
	type SetContext,
	type AddedPiecesContext,
	type BrokenSetValue,
	type WornSetCountEntry,
	type CrossingCheck,
	type BonusGearSims,
	type SetBonusOffSims,
	type SetBonusValue,
	type ResolvedFight,
	type Ranking,
	type PartialRanking,
} from './rank-types';

/**
 * What setup settled that only `runRanking` reads, beside the fixed inputs
 * in `RunContext`.
 */
type RunSetup = {
	resolved: ResolvedFight;
	contentHash: string;
	/** The gem context before the baseline's stats read adds the hit budget. */
	gems: GemContext;
	metaAdjusted: boolean;
	metaRecolors: GemRecolor[];
	pool: EligibleCandidates;
};

export async function rankUpgrades(input: RankInput, deps: Deps, onProgress?: (p: Progress) => void): Promise<Ranking | PartialRanking> {
	onProgress?.({ stage: 'resolving' });
	const cutoff = CUTOFF;
	const fights = await deps.gear.findFights(input.character, input.spec);
	const maybeResolved = resolveFight(fights, input.fight);
	if (!maybeResolved) {
		throw new RankError('no-qualifying-fight', `no qualifying fights for ${input.character.name}`);
	}
	const resolved: ResolvedFight = maybeResolved;
	const fight = { reportCode: resolved.reportCode, fightId: resolved.fightId };

	onProgress?.({ stage: 'reading-gear' });
	const logged = await deps.gear.readGear(fight);

	onProgress?.({ stage: 'composing' });
	const race = input.race ?? raceFromSkeleton(deps.raidSimSkeleton);
	// Every request describes its own equipment in its own database, as the sim
	// does when it sets `player.database` from the gear (`ui/sim/sim.ts`).
	// Without a resolver this is a plain compose call, the CLI path.
	const composeFor = (forEquipment: readonly SimItemSpec[]) => {
		const database = deps.simDatabaseFor?.(forEquipment);
		return compose(deps.raidSimSkeleton, {
			name: input.character.name.toLowerCase(),
			race,
			equipment: forEquipment,
			// Spread rather than `database: undefined`: exactOptionalPropertyTypes
			// tells an absent key from an explicit undefined. `!== undefined`, not
			// truthiness: an empty database ("no extra rows") is still written.
			...(database !== undefined ? { database } : {}),
		});
	};
	// Set when the gem repair values hit only up to the hit cap, read through
	// `computeStats`, which every runner has.
	const capProfile = capProfileFor(input.spec);
	const hitPercentStat = capProfile.repair.kind === 'budget' ? capProfile.repair.hitPercentPseudoStat : undefined;

	const { iterations, seeds, runOpts } = resolveSeeds(input);

	const gems = gemContext(deps.phaseGems ?? gemsForPhase(input.maxPhase), deps.epWeights, input.spec);
	const { socketed, metaAdjusted, metaRecolors } = await repairWornMeta({ deps, logged, capProfile, hitPercentStat, composeFor, runOpts, gems });

	const equipment = applyRepairedGems(equipmentFromLoggedGear(logged), socketed);

	const request = composeFor(equipment);

	const guardedDeps = stopGuardedDeps(deps);

	onProgress?.({ stage: 'building-pool' });
	const pool = eligibleCandidates(input, deps, equipment);

	const simVersion = await deps.sim.version();

	// Hashed on every eligible candidate, not the post-cap set; `candidateCap`
	// is its own hashed field. Hashed here rather than at entry because the
	// logged gear, the largest input to every delta, is known only after
	// readGear, and this is still before the expensive sim loop.
	const contentHash = rankingContentHash({ input, race, fight, logged, ordered: pool.ordered, gems, deps, iterations, seeds, simVersion, hitPercentStat });

	const cached = await asInternal(() => deps.store.get<Ranking>(rankingCacheKey(contentHash)));
	if (cached) {
		onProgress?.({ stage: 'ranking' });
		return cached;
	}

	const ctx: RunContext = {
		input,
		deps,
		guardedDeps,
		onProgress,
		cutoff,
		race,
		composeFor,
		capProfile,
		hitPercentStat,
		iterations,
		seeds,
		runOpts,
		simVersion,
		equipment,
		request,
	};

	return runRanking(ctx, { resolved, contentHash, gems, metaAdjusted, metaRecolors, pool });
}

/**
 * The run past the ranking-cache miss: baseline, hit budget, candidates, set
 * phase, replication, ranks, and the saved ranking.
 */
async function runRanking(ctx: RunContext, setup: RunSetup): Promise<Ranking | PartialRanking> {
	const { deps, onProgress, simVersion, runOpts, request } = ctx;
	const simCounts: SimCounts = { done: 0, total: 0 };

	const baselineOutcome = await simOrFailure(deps, request, simVersion, runOpts);
	if ('simError' in baselineOutcome) {
		const err = baselineOutcome.simError;
		throw new RankError('sim-failed', err instanceof Error ? err.message : String(err));
	}
	const { observation } = baselineOutcome;
	simCounts.done = 1;

	// One stats read of the baseline gives the repair hit budget every later
	// swap starts from, so it runs before the first candidate. A read Stop
	// ended is no failure: the candidate loop returns a partial ranking.
	const baselineHitBudget = await readBaselineHitBudget(ctx, setup.gems, observation);
	// One instance per run, built after the read: its read memo and its Stop
	// latch are shared by every set-phase call.
	const requestsPerLayout = makeRequestsPerLayout(ctx, baselineHitBudget);

	const candidates = await runCandidates(ctx, setup.pool, baselineHitBudget, observation.dps, simCounts);
	const { ranked, winningRequests } = candidates;
	let { aborted } = candidates;
	const signal = deps.signal;

	// The set-bonus sims and paired replication only refine the ranking, so
	// once Stop fires neither runs: what already simmed stands and the
	// unsimmed rows stay unsimmed.
	const setPhase = await runSetPhase(ctx, candidates, baselineHitBudget, observation, requestsPerLayout, aborted);
	if (signal?.aborted) aborted = true;
	onProgress?.({ stage: 'ranking' });
	// Sorted here so replication can pick the top of the list, and again
	// below, because replication rewrites `deltaDps`. Unsimmed rows sort last.
	ranked.sort(bySimmedThenDelta);
	let replicated: ReplicatedRow[] = [];
	if (!aborted) {
		try {
			replicated = await replicateTopItems(ctx, simCounts, ranked, winningRequests);
		} catch (err) {
			// The guard refused a replication sim, so Stop fired; the re-read
			// below sees it. Any other error still fails the ranking.
			if (!(err instanceof StopRefusedSim)) throw err;
		}
	}
	if (signal?.aborted) aborted = true;
	if (aborted) {
		dropSetFigures(ranked, setPhase);
	} else {
		applyReplicatedDeltas(replicated, observation.dps, ctx.cutoff);
	}
	ranked.sort(bySimmedThenDelta);
	stampRanks(ranked);

	const rankingBase = assembleRanking(ctx, setup, observation, baselineHitBudget, candidates, setPhase);
	return saveRanking(deps, setup, rankingBase, aborted);
}

/**
 * The order rows are ranked in: simmed rows by delta, unsimmed rows last.
 * The tiebreak matches view.ts's compareRows (bisTags richness, then
 * itemId), so stamped rank and rendered order agree inside exact ties,
 * unless set potential is on and compareRows adds rankableSetPotential.
 */
function bySimmedThenDelta(a: RankedItem, b: RankedItem): number {
	if (a.simmed === false && b.simmed !== false) return 1;
	if (b.simmed === false && a.simmed !== false) return -1;
	if (a.deltaDps !== b.deltaDps) return b.deltaDps - a.deltaDps;
	const richness = b.bisTags.length - a.bisTags.length;
	if (richness !== 0) return richness;
	return a.itemId - b.itemId;
}

/**
 * A Stop after the candidate loop returns what a Stop during its last
 * sim returns. Worn-set values cut short would charge losses at counts
 * never measured, so no partial set figure is kept.
 */
function dropSetFigures(ranked: RankedItem[], setPhase: SetPhaseOutcome): void {
	setPhase.setBonusResult = emptySetPhase();
	setPhase.bonusGearResult = undefined;
	setPhase.setBonusNotes.length = 0;
	setPhase.setCheckNotes.length = 0;
	for (const item of ranked) delete item.setContext;
}

/**
 * Numbers the simmed rows that meet the cutoff in their sorted order. Every
 * other row gets `rank: null`.
 */
function stampRanks(ranked: readonly RankedItem[]): void {
	let rank = 1;
	for (const item of ranked) {
		// Stop left this row unsimmed: there is no measured delta to classify
		// or group.
		if (item.simmed === false) {
			item.rank = null;
			continue;
		}
		if (item.belowCutoff) {
			item.rank = null;
		} else {
			item.rank = rank;
			rank += 1;
		}
	}
}

/**
 * The ranking's fields but `complete`: the baseline, the assumptions, every
 * note in its fixed order, the rows, and the set figures the run kept.
 */
function assembleRanking(
	ctx: RunContext,
	setup: RunSetup,
	observation: SimObservation,
	baselineHitBudget: BaselineHitBudget,
	candidates: CandidateResults,
	setPhase: SetPhaseOutcome,
): Omit<Ranking, 'complete'> {
	const { input, cutoff, race, iterations, seeds } = ctx;
	const { resolved, contentHash, metaAdjusted, metaRecolors } = setup;
	const { blockedOffHand, blockedOneHand } = setup.pool;
	const { gems, hitCapNotes } = baselineHitBudget;
	const { ranked, candidateSkips } = candidates;
	const { setBonusResult, bonusGearResult, setBonusNotes, setCheckNotes } = setPhase;
	const setBonuses = setBonusResult.bonuses;

	return {
		contentHash,
		cutoff,
		fight: resolved,
		baseline: {
			dps: observation.dps,
			stdev: observation.stdev,
			metaAdjusted,
		},
		assumptions: {
			maxPhase: input.maxPhase,
			seeds,
			iterations,
			race,
			presetId: presetIdFor(input.spec),
			standing: buildStandingAssumptions(race),
		},
		substitutions: [
			...notesFromMetaRepair(metaRecolors),
			...hitCapNotes,
			...metaPreferenceNotes(gems.spec),
			...offHandBlockedNotes(blockedOffHand.length),
			...oneHandBlockedNotes(blockedOneHand.length),
			...candidateSkips.map(candidateSkipNote),
			...uniqueNotes([...setCheckNotes, ...setBonusNotes]),
		],
		items: ranked,
		...(setBonuses.length > 0 ? { setBonuses } : {}),
		...(setBonusResult.brokenSetValues.length > 0 ? { brokenSetValues: setBonusResult.brokenSetValues } : {}),
		...(setBonusResult.wornSetLadder.length > 0 ? { wornSetLadder: setBonusResult.wornSetLadder } : {}),
		...(setBonusResult.crossingChecks.length > 0 ? { crossingChecks: setBonusResult.crossingChecks } : {}),
		...(bonusGearResult ? { bonusGearSims: bonusGearResult.bonusGearSims } : {}),
		...(bonusGearResult ? { setBonusOffSims: bonusGearResult.bonusOffSims } : {}),
		...(setBonusResult.setScreen ? { setScreen: setBonusResult.setScreen } : {}),
	};
}

/**
 * Writes a complete ranking to the ranking cache, then returns it. A partial
 * ranking is returned without a write.
 */
async function saveRanking(deps: Deps, setup: RunSetup, rankingBase: Omit<Ranking, 'complete'>, aborted: boolean): Promise<Ranking | PartialRanking> {
	if (aborted) {
		// No ranking-cache row for a partial run; this branch is the only
		// thing that enforces it (see `Ranking.complete`). Per-sim rows already
		// landed via `cacheSimResult`, so a re-run still resumes cheaply.
		const partial: PartialRanking = { ...rankingBase, complete: false };
		return partial;
	}

	const ranking: Ranking = { ...rankingBase, complete: true };
	await asInternal(() => deps.store.put(rankingCacheKey(setup.contentHash), ranking));
	return ranking;
}
