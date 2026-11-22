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
import { buildStandingAssumptions, notesFromMetaRepair, type RunNote } from './disclosure';
import { applyRepairedGems } from './gear-swap';
import { gemsForPhase } from './gems';
import { type BaselineHitBudget, makeRequestsPerLayout, readBaselineHitBudget, type RequestsPerCopyLayout } from './hit-budget';
import { equipmentFromLoggedGear } from './logged-gear';
import type { GemRecolor } from './meta-repair';
import { plausibilityWarnings } from './plausibility';
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
import type { Job } from './seams/store';
import { measureBonusGear } from './set-bonus-gear';
import { applySetContext } from './set-context';
import { buildSetBonuses, emptySetPhase } from './set-phase';
import { type CountsAsBreak, sampleOf, setCounts } from './set-value';
import { countsAsBreakFrom } from './set-worn-ladder';
import { rankingCacheKey, simOrFailure, stopGuardedDeps, StopRefusedSim } from './sim-calls';
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
export {
	metaPreferenceNotes,
	oneHandBlockedNotes,
	offHandBlockedNotes,
	type CandidateSkip,
	candidateSkipNote,
	type SkipReason,
	SET_BONUS_SKIP_REASONS,
	type SetBonusSkip,
	setBonusSkipNote,
	setBonusCountsSkipNote,
	breakSplitSkipNote,
	type SetScreenSkip,
	setScreenSkipNote,
	wornSetSkipNote,
	uniqueNotes,
	hitCapUnknownNote,
	hitCapFullWeightNote,
	hitCapPerSpellTalentNote,
} from './run-notes';
export { resolveFight } from './rank-setup';
export { equipmentForCandidateSwap, candidateSwapPreRepair, candidateSwapWithRepairs } from './gear-swap';
export { bonusesWithItem } from './set-context';

/**
 * What setup settled that only `runRanking` reads, beside the fixed inputs
 * in `RunContext`.
 */
type RunSetup = {
	resolved: ResolvedFight;
	contentHash: string;
	job: Job;
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

	const cached = await deps.store.get<Ranking>(rankingCacheKey(contentHash));
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

	const job = await deps.store.job.create({ contentHash, input });
	await deps.store.job.update(job.id, { status: 'running' });

	try {
		return await runRanking(ctx, { resolved, contentHash, job, gems, metaAdjusted, metaRecolors, pool });
	} catch (err) {
		try {
			await deps.store.job.update(job.id, {
				status: 'error',
				errorKind: err instanceof RankError ? err.kind : 'internal',
				errorDetail: err instanceof Error ? err.message : String(err),
			});
		} catch {
			// A failed status write must not replace the error being rethrown.
		}
		throw err;
	}
}

/**
 * The run once its job row exists: baseline, hit budget, candidates, set
 * phase, replication, ranks, and the saved ranking. `rankUpgrades` marks the
 * job failed when this throws.
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
		dropSetFigures(deps, ranked, setPhase);
	} else {
		applyReplicatedDeltas(replicated, observation.dps, ctx.cutoff);
	}
	ranked.sort(bySimmedThenDelta);
	stampRanks(ranked);

	const rankingBase = assembleRanking(ctx, setup, observation, baselineHitBudget, candidates, setPhase);
	return saveRanking(deps, setup, rankingBase, aborted);
}

/**
 * What the set phase leaves for the ranking. `dropSetFigures` empties it in
 * place when Stop fires after the candidate loop.
 */
type SetPhaseOutcome = {
	setBonusResult: ReturnType<typeof emptySetPhase>;
	countsAsBreak: CountsAsBreak | undefined;
	bonusGearResult: Awaited<ReturnType<typeof measureBonusGear>> | undefined;
	/** The set phase pushes to both, and a Stop empties them in place. */
	setBonusNotes: RunNote[];
	setCheckNotes: RunNote[];
};

/**
 * The set phase and what it adds to the rows: the set-bonus sims, each
 * row's `setContext`, and the bonus-gear sims. After a Stop it runs no sim
 * and gives the empty set phase.
 */
async function runSetPhase(
	ctx: RunContext,
	candidates: CandidateResults,
	baselineHitBudget: BaselineHitBudget,
	observation: SimObservation,
	requestsPerLayout: RequestsPerCopyLayout,
	abortedBefore: boolean,
): Promise<SetPhaseOutcome> {
	const { input, deps, guardedDeps, cutoff, composeFor, iterations, simVersion, runOpts, equipment } = ctx;
	const { ranked, ownDeltasByItemId, simCandidates } = candidates;
	const { gems } = baselineHitBudget;
	const signal = deps.signal;
	let aborted = abortedBefore;

	// A line for every set bonus the set phase could not measure, and for
	// every set screen or worn-set value sim that failed, most with the sim's
	// error.
	const setBonusNotes: RunNote[] = [];
	const setCheckNotes: RunNote[] = [];

	const setBonusResult = aborted
		? emptySetPhase()
		: await buildSetBonuses({
				deps: guardedDeps,
				candidates: simCandidates,
				equipment,
				gems,
				input,
				composeFor,
				ownDeltasByItemId,
				baseline: sampleOf(observation, iterations),
				simVersion,
				runOpts,
				setBonusNotes,
				setCheckNotes,
				measureSetBonuses: deps.measureSetBonuses ?? false,
				cutoff,
				baselineStdev: observation.stdev,
				requestsPerLayout,
			});
	if (signal?.aborted) aborted = true;
	// With `measureSetBonuses`, a swap loses a worn bonus only at a count
	// `wornSetLadder` counted, and no table is read. An aborted run has none,
	// so it charges no loss.
	const countsAsBreak: CountsAsBreak | undefined = deps.measureSetBonuses ? countsAsBreakFrom(setBonusResult.wornSetLadder) : undefined;
	const setBonuses = setBonusResult.bonuses;
	// With `measureSetBonuses`, a set row's future bonuses are valued by
	// one sim of the row plus its partner pieces.
	const simBonusGear = (deps.measureSetBonuses ?? false) && !aborted;
	const hasSetContext = setBonuses.length > 0 || setBonusResult.setIdsNotValued.length > 0;
	if (hasSetContext) {
		applySetContext({
			ranked,
			setBonuses,
			equipment,
			brokenBonusDpsByKey: setBonusResult.brokenBonusDpsByKey,
			firstSlotIndexByItemId: setBonusResult.firstSlotIndexByItemId,
			ownDeltasByItemId,
			countsAsBreak,
			measured: simBonusGear ? { crossingChecks: setBonusResult.crossingChecks } : undefined,
			setIdsNotValued: setBonusResult.setIdsNotValued,
		});
	}
	// After the future bonuses are filled in and before replication rewrites
	// the top rows' `deltaDps`: one sim per distinct gear of a row plus its
	// partner pieces.
	const bonusGearResult =
		simBonusGear && hasSetContext && countsAsBreak
			? await measureBonusGear({
					deps: guardedDeps,
					ranked,
					setBonuses,
					equipment,
					gems,
					composeFor,
					ownDeltasByItemId,
					brokenBonusDpsByKey: setBonusResult.brokenBonusDpsByKey,
					firstSlotIndexByItemId: setBonusResult.firstSlotIndexByItemId,
					countsAsBreak,
					baseline: sampleOf(observation, iterations),
					simVersion,
					runOpts,
					cutoff,
					requestsPerLayout,
					bonusNotes: setBonusNotes,
				})
			: undefined;
	return { setBonusResult, countsAsBreak, bonusGearResult, setBonusNotes, setCheckNotes };
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
function dropSetFigures(deps: Deps, ranked: RankedItem[], setPhase: SetPhaseOutcome): void {
	setPhase.setBonusResult = emptySetPhase();
	setPhase.countsAsBreak = deps.measureSetBonuses ? countsAsBreakFrom(setPhase.setBonusResult.wornSetLadder) : undefined;
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
	const { input, cutoff, race, iterations, seeds, equipment } = ctx;
	const { resolved, contentHash, metaAdjusted, metaRecolors } = setup;
	const { blockedOffHand, blockedOneHand } = setup.pool;
	const { gems, hitCapNotes } = baselineHitBudget;
	const { ranked, candidateSkips } = candidates;
	const { setBonusResult, countsAsBreak, bonusGearResult, setBonusNotes, setCheckNotes } = setPhase;
	const setBonuses = setBonusResult.bonuses;

	const warnings = plausibilityWarnings({
		baselineDps: observation.dps,
		setBonuses,
		rows: ranked.map(i => ({
			itemId: i.itemId,
			name: i.name,
			slot: i.slot,
			deltaDps: i.deltaDps,
			...(i.owned === true ? { owned: true } : {}),
		})),
		wornSetCounts: setCounts(equipment),
		...(countsAsBreak ? { countsAsBreak } : {}),
	});

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
		...(warnings.length > 0 ? { plausibilityWarnings: warnings } : {}),
	};
}

/**
 * Writes the finished run to its job row, and a complete ranking to the
 * ranking cache too, then returns it.
 */
async function saveRanking(deps: Deps, setup: RunSetup, rankingBase: Omit<Ranking, 'complete'>, aborted: boolean): Promise<Ranking | PartialRanking> {
	const { contentHash, job } = setup;
	if (aborted) {
		// No ranking-cache row for a partial run; this branch is the only
		// thing that enforces it (see `Ranking.complete`). Per-sim rows already
		// landed via `cacheSimResult`, so a re-run still resumes cheaply.
		const partial: PartialRanking = { ...rankingBase, complete: false };
		await deps.store.job.update(job.id, {
			status: 'done',
			result: partial,
		});
		return partial;
	}

	const ranking: Ranking = { ...rankingBase, complete: true };
	await deps.store.put(rankingCacheKey(contentHash), ranking);
	await deps.store.job.update(job.id, {
		status: 'done',
		result: ranking,
	});
	return ranking;
}
