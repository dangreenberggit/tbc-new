/**
 * rankUpgrades: the engine's entry point, RankInput → Ranking.
 *
 * No spec-mismatch check: the gear source reads the page's gear under the
 * page's selected spec, so it always matches `input.spec`, and
 * `LoggedGear.className`/`specIdHint` go unused. The content hash is the
 * canonical-JSON string itself, not a digest, like `simCacheKey` in
 * seams/sim-runner.ts.
 */

import { type GemContext, gemContext, metaSocketUnpriced } from './candidate-gems';
import { capProfileFor, perSpellHitTalentTaken } from './cap-profile';
import { gearHitRating } from './caps';
import { compose } from './compose';
import { CUTOFF, meetsCutoff } from './cutoff';
import { buildStandingAssumptions, notesFromMetaRepair, type RunNote } from './disclosure';
import { applyRepairedGems, candidateSwapPreRepair, candidateSwapWithRepairs, type ChainBuild } from './gear-swap';
import { gemsForPhase } from './gems';
import {
	CandidateHitReadFailed,
	hitPercentOf,
	hitPercentOrSimFailed,
	type LayoutResult,
	MISSED_HIT_TOLERANCE,
	readHitCap,
	type RequestsPerCopyLayout,
} from './hit-budget';
import { equipmentFromLoggedGear } from './logged-gear';
import { type GemRecolor, inactiveMeta, MetaRepairError } from './meta-repair';
import { plausibilityWarnings } from './plausibility';
import { type PoolEntry, type SimSlotName, simSlotsForPoolSlot } from './pool';
import { promisePool } from './promise-pool';
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
	talentsStringFromRequest,
} from './rank-setup';
import { type Deps, type PartialRanking, type Progress, type RankedItem, RankError, type Ranking, type RankInput, type ResolvedFight } from './rank-types';
import {
	type CandidateSkip,
	candidateSkipNote,
	hitCapFullWeightNote,
	hitCapPerSpellTalentNote,
	hitCapUnknownNote,
	metaPreferenceNotes,
	offHandBlockedNotes,
	oneHandBlockedNotes,
	uniqueNotes,
} from './run-notes';
import { isReplicable, PAIRED_REPLICATE_TOP_N, pairedReplicateSe, usesPairedReplication } from './se';
import { type PlayerStatsObservation, type RaidSimRequest, type SimObservation, stableStringify } from './seams/sim-runner';
import type { Job } from './seams/store';
import { setBreakNote } from './set-bonus';
import { measureBonusGear } from './set-bonus-gear';
import { applySetContext } from './set-context';
import { applyCopies, type BuildFailure, errorText, isBuildFailure } from './set-less-copies';
import { buildSetBonuses, emptySetPhase } from './set-phase';
import { type CountsAsBreak, type OwnDelta, sampleOf, setCounts } from './set-value';
import { countsAsBreakFrom } from './set-worn-ladder';
import { rankingCacheKey, readStats, simOrFailure, stopGuardedDeps, StopRefusedSim } from './sim-calls';
import { SIM_ORDER, type SimItemSpec } from './slots';
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

type BestSwap = {
	deltaDps: number;
	se: number;
	request: RaidSimRequest;
	slotChoice?: SimSlotName;
	slotIndex: number;
	setBonusNote?: string;
	repairRecolors: readonly GemRecolor[];
	/** Worn items the winning attempt took off beyond the swap itself. */
	removed: readonly { slotIndex: number; itemId: number }[];
	candidateGems: readonly number[];
};

/**
 * The sim counts the progress events report. One object per run, so the
 * candidate loop, `replicateTopItems` and `bumpProgress` add to the same
 * counts.
 */
type SimCounts = { done: number; total: number };

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
	const {
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
	} = ctx;
	const { resolved, contentHash, job, metaAdjusted, metaRecolors } = setup;
	const { equippedIds, mainHandIsOneHanded, blockedOffHand, blockedOneHand, ordered } = setup.pool;
	// Reassigned once, after the baseline's stats read, so every later repair
	// site gets the hit budget.
	let gems = setup.gems;
	const simCounts: SimCounts = { done: 0, total: 0 };
	/** The baseline's sim hit rating, once the budget is set. */
	let baselineSimHit: number | undefined;
	/**
	 * How repair priced hit where the ranking cannot show it: no cap used
	 * (a full-weight spec, or a target not at level 73), or a per-spell hit
	 * talent the cap leaves out.
	 */
	const hitCapNotes: RunNote[] = [];

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
	const statsReadsByRequest = new Map<string, Promise<PlayerStatsObservation>>();
	let perGearHitBudgetsOff = false;
	const requestsPerLayout: RequestsPerCopyLayout = async (rebuild, base, copiesList) => {
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
				const missed = hitPercent * capProfile.ratingPerPercent - baselineSimHit - (buildHit - hitBudget.baselineGearHit);
				if (Math.abs(missed) < MISSED_HIT_TOLERANCE) {
					out.push({ request, recolors: base.recolors });
					continue;
				}
				let rebuilt: ChainBuild;
				try {
					rebuilt = rebuild({
						...gems,
						repairHitBudget: {
							...hitBudget,
							baselineRemaining: hitBudget.baselineRemaining - missed,
						},
					});
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
	const candidateRepairGems = async (slotIndex: number, itemId: number): Promise<GemContext> => {
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
		const missed = hitPercent * capProfile.ratingPerPercent - baselineSimHit - (gearHitRating(pre.swapped, hitBudget.stat) - hitBudget.baselineGearHit);
		if (Math.abs(missed) < MISSED_HIT_TOLERANCE) return gems;
		return {
			...gems,
			repairHitBudget: {
				...hitBudget,
				baselineRemaining: hitBudget.baselineRemaining - missed,
			},
		};
	};

	const baselineDps = observation.dps;
	const ranked: RankedItem[] = [];
	const winningRequests = new Map<number, RaidSimRequest>();
	const candidateSkips: CandidateSkip[] = [];
	const ownDeltasByItemId = new Map<number, OwnDelta>();

	/**
	 * Which `(item, slot)` attempts may be priced. It returns why an attempt
	 * may not, because an unmappable slot is a bug the loop throws on, while
	 * a skipped attempt is simply not priced.
	 */
	const attemptEligibility = (entry: PoolEntry, slotName: SimSlotName): { kind: 'ok'; slotIndex: number } | { kind: 'skip' } | { kind: 'unmapped' } => {
		// A one-hander goes in the off hand only beside a one-handed main hand.
		// `simSlotsForPoolSlot` checks only the candidate's hand type, so without
		// this a one-hander would be simmed beside a worn two-hander, a pairing
		// the game cannot equip; displacing the two-hander would price a two-item
		// swap under a one-item row. `oneHandBlockedEntries` already holds these
		// out before ordering; this stays as a backstop.
		if (slotName === 'offhand' && !mainHandIsOneHanded) return { kind: 'skip' };
		const slotIndex = SIM_ORDER.indexOf(slotName);
		if (slotIndex < 0) return { kind: 'unmapped' };
		// A worn item is priced only in the slot it is worn in. A paired slot
		// keeps the better of its two placements, so a second placement would
		// turn the worn item's "you already wear this" row into "wear a second
		// copy": legal for a non-unique ring or trinket, but nothing in the row
		// would say so. `paneRows` in `model/results_view.ts` relies on this to
		// keep worn rows out of the below-cutoff group.
		const wornAt = equipment.findIndex(spec => spec.id === entry.itemId);
		if (wornAt >= 0 && wornAt !== slotIndex) return { kind: 'skip' };
		return { kind: 'ok', slotIndex };
	};

	/**
	 * The slot a Stop placeholder names. A simmed weapon, ring or trinket row
	 * names its best swap's slot; when only one placement passes
	 * `attemptEligibility`, that slot is known without a sim, so the
	 * placeholder names it too and files in the same pane. With two legal
	 * placements only the sim could choose, so it stays unset.
	 */
	const placeholderSlotChoice = (entry: PoolEntry): SimSlotName | undefined => {
		const slotNames = simSlotsForPoolSlot(entry.slot, input.spec, entry.itemId);
		if (slotNames.length < 2 && entry.slot !== 'weapon') return undefined;
		const legal = slotNames.filter(slotName => attemptEligibility(entry, slotName).kind === 'ok');
		return legal.length === 1 ? legal[0] : undefined;
	};

	/**
	 * One candidate's slot-attempt loop, run as a `promisePool` task. Its
	 * writes to the shared collections are safe because JS interleaves only
	 * at `await`. Output never depends on finish order: `ranked` is sorted by
	 * `deltaDps` after the pool drains and `candidateSkips` by item id, so any
	 * `concurrency` gives byte-identical output.
	 */
	async function runCandidate(entry: PoolEntry): Promise<void> {
		const worn = equippedIds.has(entry.itemId);
		const slotNames = simSlotsForPoolSlot(entry.slot, input.spec, entry.itemId);
		let best: BestSwap | null = null;

		for (let s = 0; s < slotNames.length; s++) {
			const slotName = slotNames[s]!;
			const eligibility = attemptEligibility(entry, slotName);
			if (eligibility.kind === 'unmapped') {
				throw new Error(`slot mapping bug: ${entry.slot} -> ${slotName} is not in SIM_ORDER ` + `(item ${entry.itemId} ${entry.name})`);
			}
			if (eligibility.kind === 'skip') continue;
			const { slotIndex } = eligibility;
			let swapped: SimItemSpec[];
			let repairRecolors: readonly GemRecolor[];
			let removed: readonly { slotIndex: number; itemId: number }[];
			let repairGems: GemContext;
			try {
				repairGems = await candidateRepairGems(slotIndex, entry.itemId);
			} catch (err) {
				// Stop refused the read: the row is left to the Stop placeholder.
				if (err instanceof StopRefusedSim) return;
				if (!(err instanceof CandidateHitReadFailed)) throw err;
				candidateSkips.push({
					kind: 'sim',
					itemId: entry.itemId,
					name: entry.name,
					slot: slotName,
					reason: err.message,
				});
				continue;
			}
			try {
				const outcome = candidateSwapWithRepairs(equipment, slotIndex, entry.itemId, repairGems);
				swapped = outcome.equipment;
				repairRecolors = outcome.recolors;
				removed = outcome.removed;
			} catch (err) {
				if (!(err instanceof MetaRepairError)) throw err;
				candidateSkips.push({
					kind: 'repair',
					itemId: entry.itemId,
					name: entry.name,
					slot: slotName,
					reason: err.message,
				});
				continue;
			}
			const candReq = composeFor(swapped);
			const candOutcome = await simOrFailure(deps, candReq, simVersion, runOpts);
			if ('simError' in candOutcome) {
				const err = candOutcome.simError;
				candidateSkips.push({
					kind: 'sim',
					itemId: entry.itemId,
					name: entry.name,
					slot: slotName,
					reason: err instanceof Error ? err.message : String(err),
				});
				continue;
			}
			const candObs = candOutcome.observation;
			const deltaDps = candObs.dps - baselineDps;
			const note = setBreakNote(equipment, slotIndex, entry.itemId);
			if (!best || deltaDps > best.deltaDps) {
				const next: BestSwap = {
					deltaDps,
					se: sampleOf(candObs, iterations).se,
					request: candReq,
					slotIndex,
					repairRecolors,
					removed,
					candidateGems: swapped[slotIndex]?.gems ?? [],
				};
				// Every weapon row names its hand: `"weapon"` alone cannot say
				// whether a non-dual-wield spec's row is a main-hand or an off-hand
				// item, and readers that fall back to the slot's first placement
				// would label a shield "Main Hand".
				if (slotNames.length > 1 || entry.slot === 'weapon') {
					next.slotChoice = slotName;
				}
				if (note) next.setBonusNote = note;
				best = next;
			}
		}

		simCounts.done += 1;
		onProgress?.({ stage: 'simming', done: simCounts.done, total: totalSims });

		if (!best) return;

		ownDeltasByItemId.set(entry.itemId, {
			itemId: entry.itemId,
			slotIndex: best.slotIndex,
			deltaDps: best.deltaDps,
			se: best.se,
		});

		const deltaPct = baselineDps === 0 ? 0 : (best.deltaDps / baselineDps) * 100;
		const belowCutoff = !meetsCutoff(best.deltaDps, cutoff);
		const item: RankedItem = {
			rank: null,
			itemId: entry.itemId,
			name: entry.name,
			slot: entry.slot,
			source: entry.source,
			deltaDps: best.deltaDps,
			deltaPct,
			se: best.se,
			seMethod: 'independent',
			bisTags: entry.bisTags ?? [],
			...(entry.curatedSets ? { curatedSets: entry.curatedSets } : {}),
			...(entry.bisSets ? { bisSets: entry.bisSets } : {}),
			belowCutoff,
		};
		if (entry.sources) item.sources = entry.sources;
		if (best.slotChoice) item.slotChoice = best.slotChoice;
		if (best.setBonusNote) item.setBonusNote = best.setBonusNote;
		if (best.repairRecolors.length > 0) {
			item.gemSubstitutions = best.repairRecolors.map(s => ({
				itemId: s.itemId,
				socketIndex: s.socketIndex,
				from: s.from,
				to: s.to,
			}));
		}
		if (best.removed.length > 0) {
			item.removedItems = best.removed.map(r => ({
				itemId: r.itemId,
				slot: SIM_ORDER[r.slotIndex] as SimSlotName,
			}));
		}
		if (worn) item.owned = true;
		if (metaSocketUnpriced(entry.itemId, best.candidateGems, gems.spec)) {
			item.emptyMetaSocket = true;
		}
		ranked.push(item);
		winningRequests.set(entry.itemId, best.request);
		onProgress?.({ kind: 'row', row: item });
	}

	// Every eligible candidate gets a full-iteration sim; the cap keeps the
	// first N items of the EP order the player does not wear, plus every worn
	// row. Worn rows are kept anyway and the list leaves them out, so one
	// counted against N would leave the list a row short.
	const candidateCap = input.candidateCap ?? ordered.length;
	const keptNotWorn = new Set(ordered.filter(e => !equippedIds.has(e.itemId)).slice(0, candidateCap));
	const simCandidates = ordered.filter(e => keptNotWorn.has(e) || equippedIds.has(e.itemId));

	// Counted here, after the cap decides the full-iteration set. An upper
	// bound until `replicateTopItems` restates it with the rows it re-sims.
	const replicaSims = usesPairedReplication(seeds) ? (seeds.length - 1) * (1 + Math.min(PAIRED_REPLICATE_TOP_N, simCandidates.length)) : 0;
	const totalSims = 1 + simCandidates.length + replicaSims;
	simCounts.total = totalSims;
	onProgress?.({ stage: 'simming', done: simCounts.done, total: totalSims });

	// Stop: candidates not yet dispatched when `signal` aborts never start;
	// sims already in flight run to the end.
	const signal = deps.signal;

	const dispatchedCandidates = signal?.aborted ? [] : simCandidates;
	const tasks = dispatchedCandidates.map(entry => () => runCandidate(entry));
	const concurrency = deps.concurrency ?? 1;
	let aborted = signal?.aborted ?? false;
	if (tasks.length > 0) {
		if (signal !== undefined) {
			// Checked as each task starts, so nothing in flight is torn down.
			await promisePool(
				tasks.map(task => async () => {
					if (signal.aborted) {
						aborted = true;
						return;
					}
					await task();
				}),
				concurrency,
			);
		} else {
			await promisePool(tasks, concurrency);
		}
	}
	// Re-read after the pool drains: an abort raised while the last task was
	// in flight skips nothing, so the loop above never sets the flag, yet the
	// run must still stop before replication and the set-bonus sims.
	if (signal?.aborted) aborted = true;
	// A skipped candidate (failed repair or sim) is already disclosed in
	// `substitutions`, and never reaches `ownDeltasByItemId`, so
	// filtering on that map alone would re-add it as a Stop placeholder.
	const skippedIds = new Set(candidateSkips.map(s => s.itemId));
	const unsimmedCandidates = aborted ? simCandidates.filter(c => !ownDeltasByItemId.has(c.itemId) && !skippedIds.has(c.itemId)) : [];
	for (const entry of unsimmedCandidates) {
		const slotChoice = placeholderSlotChoice(entry);
		// A row Stop never reached: placeholder numbers keep it a RankedItem,
		// and `simmed: false` keeps the zeroed deltaDps out of cutoff
		// classification and tie groups.
		ranked.push({
			rank: null,
			itemId: entry.itemId,
			name: entry.name,
			slot: entry.slot,
			...(slotChoice ? { slotChoice } : {}),
			source: entry.source,
			deltaDps: 0,
			deltaPct: 0,
			se: 0,
			seMethod: 'independent',
			simmed: false,
			bisTags: entry.bisTags ?? [],
			...(entry.curatedSets ? { curatedSets: entry.curatedSets } : {}),
			...(entry.bisSets ? { bisSets: entry.bisSets } : {}),
			belowCutoff: false,
			...(entry.sources ? { sources: entry.sources } : {}),
			...(equippedIds.has(entry.itemId) ? { owned: true } : {}),
		});
	}
	// Deterministic regardless of completion order, so `substitutions`
	// below reads the same on every run at every `concurrency`.
	candidateSkips.sort((a, b) => a.itemId - b.itemId);

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
