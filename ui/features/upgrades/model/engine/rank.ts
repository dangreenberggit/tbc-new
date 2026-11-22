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
import { CUTOFF, meetsCutoff } from './cutoff';
import { buildStandingAssumptions, notesFromMetaRepair, type RunNote } from './disclosure';
import { applyRepairedGems } from './gear-swap';
import { gemsForPhase } from './gems';
import { makeRequestsPerLayout, readBaselineHitBudget } from './hit-budget';
import { equipmentFromLoggedGear } from './logged-gear';
import type { GemRecolor } from './meta-repair';
import { plausibilityWarnings } from './plausibility';
import { runCandidates, type SimCounts } from './rank-candidates';
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
import { isReplicable, PAIRED_REPLICATE_TOP_N, pairedReplicateSe, usesPairedReplication } from './se';
import type { RaidSimRequest, SimObservation } from './seams/sim-runner';
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
	const { input, deps, guardedDeps, onProgress, cutoff, race, composeFor, iterations, seeds, runOpts, simVersion, equipment, request } = ctx;
	const { resolved, contentHash, job, metaAdjusted, metaRecolors } = setup;
	const { blockedOffHand, blockedOneHand } = setup.pool;
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
	const { gems, hitCapNotes } = baselineHitBudget;
	// One instance per run, built after the read: its read memo and its Stop
	// latch are shared by every set-phase call.
	const requestsPerLayout = makeRequestsPerLayout(ctx, baselineHitBudget);

	const baselineDps = observation.dps;
	const candidates = await runCandidates(ctx, setup.pool, baselineHitBudget, baselineDps, simCounts);
	const { ranked, winningRequests, candidateSkips, ownDeltasByItemId, simCandidates } = candidates;
	let { aborted } = candidates;
	const signal = deps.signal;

	// A line for every set bonus the set phase could not measure, and for
	// every set screen or worn-set value sim that failed, most with the sim's
	// error.
	const setBonusNotes: RunNote[] = [];
	const setCheckNotes: RunNote[] = [];

	// The set-bonus sims and paired replication only refine the ranking, so
	// once Stop fires neither runs: what already simmed stands and the
	// unsimmed rows stay unsimmed.
	let setBonusResult = aborted
		? emptySetPhase()
		: await buildSetBonuses(
				guardedDeps,
				simCandidates,
				equipment,
				gems,
				race,
				input,
				composeFor,
				ownDeltasByItemId,
				sampleOf(observation, iterations),
				simVersion,
				runOpts,
				setBonusNotes,
				setCheckNotes,
				deps.measureSetBonuses ?? false,
				cutoff,
				observation.stdev,
				requestsPerLayout,
			);
	if (signal?.aborted) aborted = true;
	// With `measureSetBonuses`, a swap loses a worn bonus only at a count
	// `wornSetLadder` counted, and no table is read. An aborted run has none,
	// so it charges no loss.
	let countsAsBreak: CountsAsBreak | undefined = deps.measureSetBonuses ? countsAsBreakFrom(setBonusResult.wornSetLadder) : undefined;
	let setBonuses = setBonusResult.bonuses;
	// With `measureSetBonuses`, a set row's future bonuses are valued by
	// one sim of the row plus its partner pieces.
	const simBonusGear = (deps.measureSetBonuses ?? false) && !aborted;
	const hasSetContext = setBonuses.length > 0 || setBonusResult.setIdsNotValued.length > 0;
	if (hasSetContext) {
		applySetContext(
			ranked,
			setBonuses,
			equipment,
			setBonusResult.brokenBonusDpsByKey,
			setBonusResult.firstSlotIndexByItemId,
			ownDeltasByItemId,
			countsAsBreak,
			simBonusGear ? { crossingChecks: setBonusResult.crossingChecks } : undefined,
			setBonusResult.setIdsNotValued,
		);
	}
	// After the future bonuses are filled in and before replication rewrites
	// the top rows' `deltaDps`: one sim per distinct gear of a row plus its
	// partner pieces.
	let bonusGearResult =
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
	if (signal?.aborted) aborted = true;
	onProgress?.({ stage: 'ranking' });
	// Sorted here so replication can pick the top of the list, and again
	// below, because replication rewrites `deltaDps`. Unsimmed rows sort last.
	// The tiebreak matches view.ts's compareRows (bisTags richness, then
	// itemId), so stamped rank and rendered order agree inside exact ties,
	// unless set potential is on and compareRows adds rankableSetPotential.
	const bySimmedThenDelta = (a: RankedItem, b: RankedItem): number => {
		if (a.simmed === false && b.simmed !== false) return 1;
		if (b.simmed === false && a.simmed !== false) return -1;
		if (a.deltaDps !== b.deltaDps) return b.deltaDps - a.deltaDps;
		const richness = b.bisTags.length - a.bisTags.length;
		if (richness !== 0) return richness;
		return a.itemId - b.itemId;
	};
	ranked.sort(bySimmedThenDelta);
	let replicated: Array<{ item: RankedItem; deltas: number[] }> = [];
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
		// A Stop after the candidate loop returns what a Stop during its last
		// sim returns. Worn-set values cut short would charge losses at counts
		// never measured, so no partial set figure is kept.
		setBonusResult = emptySetPhase();
		countsAsBreak = deps.measureSetBonuses ? countsAsBreakFrom(setBonusResult.wornSetLadder) : undefined;
		setBonuses = setBonusResult.bonuses;
		bonusGearResult = undefined;
		setBonusNotes.length = 0;
		setCheckNotes.length = 0;
		for (const item of ranked) delete item.setContext;
	}
	if (!aborted) {
		for (const { item, deltas } of replicated) {
			item.se = pairedReplicateSe(deltas);
			item.seMethod = 'paired-replicate';
			item.deltaDps = deltas.reduce((sum, d) => sum + d, 0) / deltas.length;
			item.deltaPct = baselineDps === 0 ? 0 : (item.deltaDps / baselineDps) * 100;
			item.belowCutoff = !meetsCutoff(item.deltaDps, cutoff);
		}
	}
	ranked.sort(bySimmedThenDelta);

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

	const rankingBase = {
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

/**
 * The top rows' paired deltas, one per seed. It writes nothing to the rows,
 * so a Stop part-way through leaves them as the candidate loop left them.
 */
async function replicateTopItems(
	ctx: RunContext,
	simCounts: SimCounts,
	ranked: RankedItem[],
	winningRequests: ReadonlyMap<number, RaidSimRequest>,
): Promise<Array<{ item: RankedItem; deltas: number[] }>> {
	const { seeds, onProgress, request } = ctx;
	const top = usesPairedReplication(seeds) ? ranked.filter(isReplicable).slice(0, PAIRED_REPLICATE_TOP_N) : [];
	// The total sent so far budgeted re-sims for up to top-N rows; only now is
	// the number of rows known, so the total is restated as the sims done
	// plus the sims this function will run.
	simCounts.total = simCounts.done + (top.length === 0 ? 0 : (seeds.length - 1) * (1 + top.length));
	onProgress?.({
		stage: 'simming',
		done: simCounts.done,
		total: simCounts.total,
	});
	if (top.length === 0) return [];
	const baselineBySeed = new Map<number, number>();
	for (const s of seeds) {
		baselineBySeed.set(s, (await simFor(ctx, request, s)).dps);
		bumpProgress(ctx, simCounts, s);
	}

	const replicated: Array<{ item: RankedItem; deltas: number[] }> = [];
	for (const item of top) {
		const candReq = winningRequests.get(item.itemId);
		if (!candReq) {
			throw new RankError('internal', `no recorded request for ranked item ${item.itemId} (${item.name}); ` + `paired replication cannot re-sim it`);
		}
		const deltas: number[] = [];
		for (const s of seeds) {
			const obs = await simFor(ctx, candReq, s);
			deltas.push(obs.dps - baselineBySeed.get(s)!);
			bumpProgress(ctx, simCounts, s);
		}
		replicated.push({ item, deltas });
	}
	return replicated;
}

/**
 * Counts one replication sim. A first-seed sim is not counted: the baseline
 * and the candidate loop already ran it with that seed.
 */
function bumpProgress(ctx: RunContext, simCounts: SimCounts, seedForRun: number): void {
	if (seedForRun === ctx.seeds[0]) return;
	simCounts.done += 1;
	ctx.onProgress?.({
		stage: 'simming',
		done: simCounts.done,
		total: simCounts.total,
	});
}

/**
 * One replication sim at `seedForRun`, through the Stop guard. A refused
 * sim rethrows `StopRefusedSim`; any other failure fails the run.
 */
async function simFor(ctx: RunContext, req: RaidSimRequest, seedForRun: number): Promise<SimObservation> {
	const opts = { seed: seedForRun, iterations: ctx.iterations };
	// The store goes through `guardedDeps` too: `stopGuardedDeps` keeps
	// `deps`'s own store, and only the sim is guarded.
	const outcome = await simOrFailure(ctx.guardedDeps, req, ctx.simVersion, opts);
	if ('simError' in outcome) {
		const err = outcome.simError;
		if (err instanceof StopRefusedSim) throw err;
		throw new RankError('sim-failed', err instanceof Error ? err.message : String(err));
	}
	return outcome.observation;
}
