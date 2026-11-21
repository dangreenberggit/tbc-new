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
import { orderCandidatesByEp } from './candidate-order';
import { capProfileFor, type HitCapBudget, hitCapBudgetFrom, perSpellHitTalentTaken, targetsAtCapLevel, usesSpellHitBudget } from './cap-profile';
import { gearHitRating } from './caps';
import { compose } from './compose';
import { canonicalJson, ENGINE_VERSION, type HashedGearItem } from './content-hash';
import { CUTOFF, type Cutoff, meetsCutoff } from './cutoff';
import { buildStandingAssumptions, notesFromMetaRepair, type RunNote } from './disclosure';
import { applyRepairedGems, candidateSwapPreRepair, candidateSwapWithRepairs, type ChainBuild, chainSwapsWithRepairs } from './gear-swap';
import { gemsForPhase } from './gems';
import {
	CandidateHitReadFailed,
	type CopyLayout,
	hitPercentOf,
	hitPercentOrSimFailed,
	isRepairFailure,
	type LayoutRequest,
	type LayoutResult,
	MISSED_HIT_TOLERANCE,
	repairErrorOr,
	requestOf,
	type RequestsPerCopyLayout,
} from './hit-budget';
import { getItem } from './items';
import { isKaelTempLegendary } from './kael-temp';
import { equipmentFromLoggedGear, socketedItemsFromLoggedGear } from './logged-gear';
import { type GemRecolor, inactiveMeta, MetaRepairError, REPAIR_SEARCH_WORK_LIMIT, repairMetaGems, type SocketedItem } from './meta-repair';
import { choosePartners, estimateCombinedDelta, PARTNER_RULE, type PartnerPiece, partnerPool } from './partner-choice';
import { plausibilityWarnings } from './plausibility';
import {
	filterPoolByPhase,
	mainHandLeavesOffHandFree,
	offHandBlockedEntries,
	oneHandBlockedEntries,
	type PoolEntry,
	type SimSlotName,
	simSlotsForPoolSlot,
} from './pool';
import { promisePool } from './promise-pool';
import { DEFAULT_ITERATIONS, DEFAULT_SEED_BASE, defaultSeedsFor, presetIdFor, raceFromSkeleton, resolveFight, talentsStringFromRequest } from './rank-setup';
import {
	type AddedPiecesContext,
	type BonusGearSims,
	type BrokenSetValue,
	type CrossingCheck,
	type Deps,
	type PartialRanking,
	type Progress,
	type RankedItem,
	RankError,
	type Ranking,
	type RankInput,
	type ResolvedFight,
	type SetBonusOffSims,
	type SetBonusValue,
	type SetContext,
	type WornSetCountEntry,
} from './rank-types';
import {
	breakSplitSkipNote,
	type CandidateSkip,
	candidateSkipNote,
	hitCapFullWeightNote,
	hitCapPerSpellTalentNote,
	hitCapUnknownNote,
	metaPreferenceNotes,
	offHandBlockedNotes,
	oneHandBlockedNotes,
	SET_BONUS_SKIP_REASONS,
	setBonusCountsSkipNote,
	setBonusSkipNote,
	setScreenSkipNote,
	type SkipReason,
	uniqueNotes,
	wornSetSkipNote,
} from './run-notes';
import { assertUsableSeeds, DegenerateSeedsError, isReplicable, PAIRED_REPLICATE_TOP_N, pairedReplicateSe, usesPairedReplication } from './se';
import {
	type PlayerStatsObservation,
	type RaidSimRequest,
	simCacheKey,
	type SimObservation,
	type SimRunner,
	type SimRunOpts,
	type SpellDamageBySchool,
	stableStringify,
} from './seams/sim-runner';
import { setBreakNote } from './set-bonus';
import {
	applyCopies,
	applySetLessCopies,
	type BuildFailure,
	clearsSameGearNoise,
	errorText,
	isBuildFailure,
	isSimFailure,
	measureSameGearBonus,
	measureWornSetCounts,
	type SimFailure,
} from './set-less-copies';
import { runSetScreenOn, type SetScreen, type SetScreenInput } from './set-screen';
import {
	bonusKey,
	type BrokenSetBonus,
	brokenSetBonuses,
	combineSe,
	computeBonusDps,
	type CountsAsBreak,
	type DpsSample,
	type InflationTerm,
	isBonusImplemented,
	netInflation,
	nextImplementedThreshold,
	type OwnDelta,
	type PlacedItem,
	selectAddedPieces,
	type SelfSetConfound,
	SET_THRESHOLDS,
	setCounts,
	setNameOf,
	type SetThreshold,
} from './set-value';
import { cacheSimResult, rankingCacheKey, readCachedSim, readStats, runSimAt, stopGuardedDeps, StopRefusedSim } from './sim-calls';
import { SIM_ORDER, type SimItemSpec } from './slots';
import type { Race } from './types';
import { setCreditUnmeasured, setPotentialIncrements } from './view';
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

type BestSwap = {
	deltaDps: number;
	stdev: number;
	request: RaidSimRequest;
	slotChoice?: SimSlotName;
	slotIndex: number;
	setBonusNote?: string;
	repairRecolors: readonly GemRecolor[];
	/** Worn items the winning attempt took off beyond the swap itself. */
	removed: readonly { slotIndex: number; itemId: number }[];
	candidateGems: readonly number[];
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
	/**
	 * How repair priced hit where the ranking cannot show it: no cap used
	 * (a full-weight spec, or a target not at level 73), or a per-spell hit
	 * talent the cap leaves out.
	 */
	const hitCapNotes: RunNote[] = [];
	/**
	 * One stats read of `request`: its hit percent and the `HitCapBudget` it
	 * gives. A spell-hit budget also needs a sim result's spell damage by
	 * school.
	 */
	const readHitCap = async (request: RaidSimRequest, slot: number, spellDamageBySchool?: SpellDamageBySchool) => {
		const { observed, hitPercent } = await hitPercentOrSimFailed(readStats(deps.sim, request, deps.signal), slot);
		return {
			hitPercent,
			budget: hitCapBudgetFrom(capProfile, request, observed.pseudoStats, spellDamageBySchool),
		};
	};

	const iterations = input.iterations ?? DEFAULT_ITERATIONS;
	const seeds = input.seeds ?? defaultSeedsFor(iterations);
	try {
		assertUsableSeeds(seeds, iterations);
	} catch (err) {
		if (err instanceof DegenerateSeedsError) {
			throw new RankError('internal', err.message);
		}
		throw err;
	}
	const seed = seeds[0] ?? DEFAULT_SEED_BASE;
	const runOpts = { seed, iterations };

	const preRepairSocketed = socketedItemsFromLoggedGear(logged);
	let socketed: SocketedItem[] = preRepairSocketed;
	let metaAdjusted = false;
	let metaRecolors: GemRecolor[] = [];
	// Reassigned once, after the baseline's stats read, so every later repair
	// site gets the hit budget.
	let gems = gemContext(deps.phaseGems ?? gemsForPhase(input.maxPhase), deps.epWeights, input.spec);
	// The worn repair runs before the baseline exists, so its hit budget comes
	// from its own read of the un-repaired gear, relative to the items the
	// repair is given, as `repairMetaGems` expects. A spell-hit budget first
	// sims that gear for the spells it casts; that sim failing fails the run. A
	// read Stop ended is no failure: the candidate loop returns a partial
	// ranking, which is never cached.
	let wornHitBudget: HitCapBudget | undefined;
	if (hitPercentStat !== undefined && inactiveMeta(preRepairSocketed)) {
		const preRequest = composeFor(equipmentFromLoggedGear(logged));
		let spellDamage: SpellDamageBySchool | undefined;
		if (usesSpellHitBudget(capProfile) && targetsAtCapLevel(preRequest)) {
			try {
				spellDamage = (await deps.sim.run(preRequest, runOpts)).spellDamageBySchool;
			} catch (err) {
				throw new RankError('sim-failed', errorText(err));
			}
		}
		try {
			wornHitBudget = (await readHitCap(preRequest, hitPercentStat, spellDamage)).budget;
		} catch (err) {
			if (!(err instanceof StopRefusedSim)) throw err;
		}
	}
	try {
		const minimized = repairMetaGems({
			items: preRepairSocketed,
			epWeights: deps.epWeights,
			allowedGems: gems.fillGems,
			...(wornHitBudget ? { hitBudget: wornHitBudget } : {}),
		});
		socketed = minimized.items;
		metaAdjusted = minimized.metaAdjusted;
		metaRecolors = minimized.recolors;
	} catch (err) {
		if (err instanceof MetaRepairError) {
			throw new RankError('meta-unsolvable', err.message);
		}
		throw err;
	}

	const equipment = applyRepairedGems(equipmentFromLoggedGear(logged), socketed);

	const request = composeFor(equipment);

	const guardedDeps = stopGuardedDeps(deps);

	onProgress?.({ stage: 'building-pool' });
	const equippedIds = new Set(equipment.map(s => s.id).filter((id): id is number => !!id));
	const wornMainHandId = equipment[SIM_ORDER.indexOf('mainhand')]?.id;
	const mainHandIsOneHanded = mainHandLeavesOffHandFree(wornMainHandId);
	const phaseEligible = filterPoolByPhase(deps.pool ?? [], input.maxPhase).filter(e => !isKaelTempLegendary(e.itemId));
	/**
	 * Off-hand-only items that cannot sit beside the worn two-hander without a
	 * two-item swap, which `attemptEligibility` rejects. They leave before
	 * ordering, not at that guard: the EP order would price them against an
	 * empty off hand, they would use up `candidateCap` places, and a Stop would
	 * bring them back as unsimmed placeholders. One note counts them.
	 */
	const blockedOffHand = offHandBlockedEntries(phaseEligible, input.spec, wornMainHandId);
	// One-handed weapons beside the worn two-hander: priced alone, each would
	// leave the off hand empty (`oneHandBlockedEntries`). They leave here for
	// the same reasons as the off-hand items, with their own line.
	const blockedOneHand = oneHandBlockedEntries(phaseEligible, input.spec, wornMainHandId);
	const eligible =
		blockedOffHand.length + blockedOneHand.length === 0
			? phaseEligible
			: phaseEligible.filter(e => !blockedOffHand.includes(e) && !blockedOneHand.includes(e));
	// Ordering runs before any sim, from raw item data only, so it cannot fail on
	// a candidate the sim itself would later reject. This order also decides
	// which N the cap keeps.
	const ordered = orderCandidatesByEp(eligible, equipment, deps.itemEp, input.spec);

	const simVersion = await deps.sim.version();

	// Hashed on every eligible candidate, not the post-cap set; `candidateCap`
	// is its own hashed field. Hashed here rather than at entry because the
	// logged gear, the largest input to every delta, is known only after
	// readGear, and this is still before the expensive sim loop.
	const contentHash = canonicalJson({
		character: {
			region: input.character.region.toLowerCase(),
			realm: input.character.realm.toLowerCase(),
			name: input.character.name.toLowerCase(),
		},
		spec: input.spec,
		maxPhase: input.maxPhase,
		race,
		fight,
		gear: [...(logged.items as readonly HashedGearItem[])]
			.map(item => ({
				id: item.id,
				slot: item.slot,
				enchant: item.enchant ?? 0,
				gems: [...(item.gems ?? [])],
			}))
			.sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : a.id - b.id)),
		candidates: ordered
			.map(e => ({ itemId: e.itemId, slot: e.slot }))
			.sort((a, b) => (a.itemId !== b.itemId ? a.itemId - b.itemId : a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0)),
		gemPaletteIds: gems.phaseGems.map(g => g.id).sort((a, b) => a - b),
		epWeights: deps.epWeights,
		presetId: presetIdFor(input.spec),
		skeleton: deps.raidSimSkeleton,
		iterations,
		seeds: [...seeds],
		simVersion,
		engineVersion: ENGINE_VERSION,
		// No cap hashes the same as an explicit cap of every eligible candidate.
		candidateCap: input.candidateCap ?? ordered.length,
		// Fixed values that describe nothing the engine still does, kept because
		// they are part of every cache key already written: dropping them would
		// rehash every stored ranking and re-sim it. Delete only alongside an
		// ENGINE_VERSION bump.
		fullPool: true,
		screenIterations: null,
		promoteTopK: null,
		// Only when set, so a run without it keeps every key already written,
		// and a ranking without the screen's readings is never served to a run
		// that asked for them.
		...(deps.setScreenMode !== undefined ? { setScreen: deps.setScreenMode } : {}),
		// Only when set, so a full-weight spec keeps its key and a run that reads
		// hit is never served a ranking repaired at full weight. The value names
		// which repairs the budget reaches, so changing that reach changes the key.
		...(hitPercentStat !== undefined ? { metaRepairHitCap: 'worn-and-candidates' } : {}),
		// The repair rule, on every run, so no ranking cached under greedy repair
		// or another work limit is served.
		metaRepair: `exact-credit-per-version;limit=${REPAIR_SEARCH_WORK_LIMIT}`,
	});

	const cached = await deps.store.get<Ranking>(rankingCacheKey(contentHash));
	if (cached) {
		onProgress?.({ stage: 'ranking' });
		return cached;
	}

	let simsDone = 0;
	let totalSimsForProgress = 0;
	/** The baseline's sim hit rating, once the budget is set. */
	let baselineSimHit: number | undefined;

	const job = await deps.store.job.create({ contentHash, input });
	await deps.store.job.update(job.id, { status: 'running' });

	try {
		return await rankAfterJobCreated();
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

	async function rankAfterJobCreated(): Promise<Ranking | PartialRanking> {
		// Only `deps.sim.run` belongs inside this catch. A store read or write
		// that fails is an `internal` fault, and labeling it `sim-failed` sends
		// an operator to the wrong subsystem.
		let observation = await readCachedSim(deps, request, simVersion, runOpts);
		if (!observation) {
			try {
				observation = await deps.sim.run(request, runOpts);
			} catch (err) {
				throw new RankError('sim-failed', err instanceof Error ? err.message : String(err));
			}
			await cacheSimResult(deps, request, simVersion, runOpts, observation);
		}
		simsDone = 1;

		// One stats read of the baseline gives the repair hit budget every later
		// swap starts from, so it runs before the first candidate. A read Stop
		// ended is no failure: the candidate loop returns a partial ranking.
		if (hitPercentStat !== undefined) {
			try {
				const { hitPercent, budget } = await readHitCap(request, hitPercentStat, observation.spellDamageBySchool);
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
				let candObs = await readCachedSim(deps, candReq, simVersion, runOpts);
				if (!candObs) {
					try {
						candObs = await deps.sim.run(candReq, runOpts);
					} catch (err) {
						candidateSkips.push({
							kind: 'sim',
							itemId: entry.itemId,
							name: entry.name,
							slot: slotName,
							reason: err instanceof Error ? err.message : String(err),
						});
						continue;
					}
					await cacheSimResult(deps, candReq, simVersion, runOpts, candObs);
				}
				const deltaDps = candObs.dps - baselineDps;
				const note = setBreakNote(equipment, slotIndex, entry.itemId);
				if (!best || deltaDps > best.deltaDps) {
					const next: BestSwap = {
						deltaDps,
						stdev: candObs.stdev,
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

			simsDone += 1;
			onProgress?.({ stage: 'simming', done: simsDone, total: totalSims });

			if (!best) return;

			ownDeltasByItemId.set(entry.itemId, {
				itemId: entry.itemId,
				slotIndex: best.slotIndex,
				deltaDps: best.deltaDps,
				se: best.stdev / Math.sqrt(iterations),
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
				se: best.stdev / Math.sqrt(iterations),
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
		totalSimsForProgress = totalSims;
		onProgress?.({ stage: 'simming', done: simsDone, total: totalSims });

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
					{ dps: baselineDps, se: observation.stdev / Math.sqrt(iterations) },
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
				setBonusResult.brokenSetValues,
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
						brokenSetValues: setBonusResult.brokenSetValues,
						firstSlotIndexByItemId: setBonusResult.firstSlotIndexByItemId,
						countsAsBreak,
						baseline: {
							dps: baselineDps,
							se: observation.stdev / Math.sqrt(iterations),
						},
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
				replicated = await replicateTopItems(ranked, winningRequests);
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
		ranked: RankedItem[],
		winningRequests: ReadonlyMap<number, RaidSimRequest>,
	): Promise<Array<{ item: RankedItem; deltas: number[] }>> {
		const top = usesPairedReplication(seeds) ? ranked.filter(isReplicable).slice(0, PAIRED_REPLICATE_TOP_N) : [];
		// The total sent so far budgeted re-sims for up to top-N rows; only now is
		// the number of rows known, so the total is restated as the sims done
		// plus the sims this function will run.
		totalSimsForProgress = simsDone + (top.length === 0 ? 0 : (seeds.length - 1) * (1 + top.length));
		onProgress?.({
			stage: 'simming',
			done: simsDone,
			total: totalSimsForProgress,
		});
		if (top.length === 0) return [];
		const baselineBySeed = new Map<number, number>();
		for (const s of seeds) {
			baselineBySeed.set(s, (await simFor(request, s)).dps);
			bumpProgress(s);
		}

		const replicated: Array<{ item: RankedItem; deltas: number[] }> = [];
		for (const item of top) {
			const candReq = winningRequests.get(item.itemId);
			if (!candReq) {
				throw new RankError('internal', `no recorded request for ranked item ${item.itemId} (${item.name}); ` + `paired replication cannot re-sim it`);
			}
			const deltas: number[] = [];
			for (const s of seeds) {
				const obs = await simFor(candReq, s);
				deltas.push(obs.dps - baselineBySeed.get(s)!);
				bumpProgress(s);
			}
			replicated.push({ item, deltas });
		}
		return replicated;
	}

	function bumpProgress(seedForRun: number): void {
		if (seedForRun === seeds[0]) return;
		simsDone += 1;
		onProgress?.({
			stage: 'simming',
			done: simsDone,
			total: totalSimsForProgress,
		});
	}

	async function simFor(req: RaidSimRequest, seedForRun: number): Promise<SimObservation> {
		const opts = { seed: seedForRun, iterations };
		const cached = await readCachedSim(deps, req, simVersion, opts);
		if (cached) return cached;
		let obs: SimObservation;
		try {
			obs = await guardedDeps.sim.run(req, opts);
		} catch (err) {
			if (err instanceof StopRefusedSim) throw err;
			throw new RankError('sim-failed', err instanceof Error ? err.message : String(err));
		}
		await cacheSimResult(deps, req, simVersion, opts, obs);
		return obs;
	}
}

async function buildSetBonuses(
	deps: Deps,
	candidates: readonly PoolEntry[],
	equipment: readonly SimItemSpec[],
	gems: GemContext,
	race: Race,
	input: RankInput,
	/**
	 * `rankUpgrades`'s own compose helper, passed in rather than rebuilt here
	 * so the two cannot drift. Every composed request must carry the database
	 * its own equipment needs.
	 */
	composeFor: (equipment: readonly SimItemSpec[]) => RaidSimRequest,
	ownDeltasByItemId: ReadonlyMap<number, OwnDelta>,
	baseline: DpsSample,
	simVersion: string,
	runOpts: SimRunOpts,
	setBonusNotes: RunNote[],
	setCheckNotes: RunNote[],
	/**
	 * When set, measure every worn set's bonuses on the player's gear, charge
	 * only the counted ones as losses, and check each reachable bonus against
	 * noise.
	 */
	measureSetBonuses: boolean,
	/** The ranking's cutoff, for the same-gear check on measured bonuses. */
	cutoff: Cutoff,
	/**
	 * The baseline sim's per-iteration stdev (`Ranking.baseline.stdev`), for
	 * the "on" screen's noise estimate.
	 */
	baselineStdev: number,
	/** Every set-phase request with repaired gems comes from it. */
	requestsPerLayout: RequestsPerCopyLayout,
): Promise<{
	bonuses: SetBonusValue[];
	brokenSetValues: BrokenSetValue[];
	/** The worn sets' DPS at each piece count. Stored name: "ladder" is the list of counts. */
	wornSetLadder: WornSetCountEntry[];
	crossingChecks: CrossingCheck[];
	/**
	 * The first SIM_ORDER slot each item fits; nothing is compared. For
	 * `applySetContext` to find each row's losses.
	 */
	firstSlotIndexByItemId: Map<number, number>;
	/**
	 * No bonus in reach, or the set screen dropped them. Their rows still get
	 * a `setContext`.
	 */
	setIdsNotValued: number[];
	setScreen?: SetScreen;
}> {
	const bonusNotMeasured = (setName: string, threshold: SetThreshold, reason: SkipReason) =>
		setBonusNotes.push(setBonusSkipNote({ setName, threshold, reason }));

	// The set sims' store-cached run; the caller decides what a failed sim
	// costs.
	const cachedSampleRun =
		(what: string) =>
		async (request: RaidSimRequest): Promise<DpsSample> => {
			let obs = await readCachedSim(deps, request, simVersion, runOpts);
			if (!obs) {
				try {
					obs = await deps.sim.run(request, runOpts);
				} catch (err) {
					// After Stop the guard refused the sim, which is no sim failure,
					// and the caller drops this run's set figures.
					if (!deps.signal?.aborted) {
						console.warn(`[upgrades] ${what} not measured: the sim failed`, err);
					}
					throw err;
				}
				await cacheSimResult(deps, request, simVersion, runOpts, obs);
			}
			return { dps: obs.dps, se: obs.stdev / Math.sqrt(runOpts.iterations) };
		};

	// The value of every bonus each worn set has, on the player's own gear,
	// before any reachable bonus is simmed, so every loss below reads a
	// measured value instead of a table. It runs even when no set piece is a
	// candidate, because `classifyDeadSlots` (in `plausibilityWarnings`) reads
	// it too.
	const wornSetLadder = measureSetBonuses
		? await measureWornSets(
				equipment,
				composeFor,
				cachedSampleRun,
				cutoff,
				setCheckNotes,
				deps.sim.activeSetBonuses ? request => deps.sim.activeSetBonuses!(request) : undefined,
			)
		: [];
	const countsAsBreak: CountsAsBreak = measureSetBonuses ? countsAsBreakFrom(wornSetLadder) : isBonusImplemented;
	const brokenSetValues: BrokenSetValue[] = wornSetLadder
		.filter(e => e.counted)
		.sort((a, b) => (a.setId !== b.setId ? a.setId - b.setId : b.count - a.count))
		.map(e => ({
			setId: e.setId,
			setName: e.setName,
			threshold: e.count,
			...(e.dps !== undefined ? { dps: e.dps } : {}),
			...(e.se !== undefined ? { se: e.se } : {}),
			...(e.unmeasured ? { unmeasured: e.unmeasured } : {}),
		}));

	const setIdsWithCandidates = new Set<number>();
	for (const entry of candidates) {
		const setId = getItem(entry.itemId)?.setId;
		if (setId != null) setIdsWithCandidates.add(setId);
	}

	const wornCounts = setCounts(equipment);
	const slotIndexForPoolEntry = (entry: PoolEntry): number | undefined => {
		for (const slotName of simSlotsForPoolSlot(entry.slot, input.spec, entry.itemId)) {
			const idx = SIM_ORDER.indexOf(slotName);
			if (idx >= 0) return idx;
		}
		return undefined;
	};

	const selectFor = (setId: number, threshold: SetThreshold) =>
		selectAddedPieces(setId, threshold, equipment, candidates, [...ownDeltasByItemId.values()], slotIndexForPoolEntry);
	// Every count from one above the worn count up to the most pieces the pool
	// can fill, each with the pieces added to reach it.
	const addedByCount = (setId: number, piecesWorn: number) => {
		const out: Array<{ count: SetThreshold; pieces: PlacedItem[] }> = [];
		for (let t = Math.max(2, piecesWorn + 1); ; t++) {
			const selection = selectFor(setId, t);
			if (!selection.ok) break;
			out.push({ count: t, pieces: selection.addedPieces });
		}
		return out;
	};
	// With `measureSetBonuses`: the counts at which each set has a bonus,
	// as the sim lists them, so no count without a bonus is simmed
	// (Thunderheart Harness at 5).
	const bonusCounts = measureSetBonuses
		? await setBonusCountsInReach(
				deps.sim,
				setIdsWithCandidates,
				setId => {
					const byCount = addedByCount(setId, wornCounts.get(setId) ?? 0);
					return byCount[byCount.length - 1]?.pieces;
				},
				equipment,
				gems,
				composeFor,
				(setId, reason) =>
					setCheckNotes.push(
						setBonusCountsSkipNote({
							setName: setNameOf(
								equipment,
								setId,
								candidates.map(entry => entry.itemId),
							),
							reason,
						}),
					),
			)
		: new Map<number, ReadonlySet<number>>();
	// With `measureSetBonuses`: the counts in reach at which the set has a
	// bonus. The same-gear check below decides which are worth something here.
	const reachableCounts = (setId: number, piecesWorn: number): SetThreshold[] => {
		const known = bonusCounts.get(setId);
		return addedByCount(setId, piecesWorn)
			.map(entry => entry.count)
			.filter(t => !known || known.has(t));
	};

	// The screen runs after the worn-set values and before the loop over
	// reachable bonuses.
	const screenInput: SetScreenInput | undefined =
		measureSetBonuses && deps.setScreenMode === 'on'
			? {
					sets: [...setIdsWithCandidates]
						.sort((a, b) => a - b)
						.map(setId => {
							const worn = wornCounts.get(setId) ?? 0;
							const reachable = reachableCounts(setId, worn);
							return {
								setId,
								worn,
								reach: reachable[reachable.length - 1] ?? worn,
							};
						}),
					gearAt: (setId, threshold) => {
						const selection = selectFor(setId, threshold);
						if (!selection.ok) return undefined;
						// The same swaps as the loop below, so the screen sims the gear
						// that loop would build for this count.
						const pieces = selection.addedPieces;
						let base: ChainBuild;
						try {
							base = chainSwapsWithRepairs(equipment, pieces, gems);
						} catch (err) {
							if (!(err instanceof MetaRepairError)) throw err;
							return undefined;
						}
						return {
							request: composeFor(base.equipment),
							added: pieces,
							// Each copy layout gets its own gem repair; one whose repair
							// fails is not measured, as in the loop below.
							requestsFor: async copiesList =>
								(await requestsPerLayout(g => chainSwapsWithRepairs(equipment, pieces, g), base, copiesList)).map(entry =>
									isRepairFailure(entry) ? undefined : requestOf(entry),
								),
						};
					},
					runSimAt: (request, opts) => runSimAt(deps, request, simVersion, opts),
					seed: runOpts.seed,
					...(deps.signal ? { signal: deps.signal } : {}),
					onSimFailed: (setId, error) =>
						setCheckNotes.push(
							setScreenSkipNote({
								setName: setNameOf(
									equipment,
									setId,
									candidates.map(entry => entry.itemId),
								),
								error,
							}),
						),
					onRequestNotBuilt: (setId, error) =>
						setCheckNotes.push(
							setScreenSkipNote({
								setName: setNameOf(
									equipment,
									setId,
									candidates.map(entry => entry.itemId),
								),
								error,
								notBuilt: true,
							}),
						),
				}
			: undefined;
	// With `measureSetBonuses`: whether one more piece of a worn set reaches
	// a bonus, measured on the gear a row makes. One check per worn set with a
	// candidate in a slot the set does not fill, on that set's best such
	// candidate's own swap, so `crossesThreshold` reads a measurement rather
	// than the fixed table in `isBonusImplemented`.
	const crossingChecks: CrossingCheck[] = [];
	if (measureSetBonuses) {
		for (const setId of [...setIdsWithCandidates].sort((a, b) => a - b)) {
			const worn = wornCounts.get(setId) ?? 0;
			if (worn < 1) continue;
			// One more piece reaches no bonus the sim lists.
			if (bonusCounts.get(setId)?.has(worn + 1) === false) continue;
			const wornSlots = new Set(equipment.flatMap((spec, i) => (spec.id && getItem(spec.id)?.setId === setId ? [i] : [])));
			let best: OwnDelta | undefined;
			for (const entry of candidates) {
				if (getItem(entry.itemId)?.setId !== setId) continue;
				const ownDelta = ownDeltasByItemId.get(entry.itemId);
				if (!ownDelta || wornSlots.has(ownDelta.slotIndex)) continue;
				if (!best || ownDelta.deltaDps > best.deltaDps || (ownDelta.deltaDps === best.deltaDps && ownDelta.itemId < best.itemId)) {
					best = ownDelta;
				}
			}
			if (!best) continue;
			const crossing = [{ slotIndex: best.slotIndex, itemId: best.itemId }];
			let swapped: ChainBuild | undefined;
			try {
				swapped = chainSwapsWithRepairs(equipment, crossing, gems);
			} catch (err) {
				if (!(err instanceof MetaRepairError)) throw err;
			}
			const crossingBuild = swapped;
			const crossingLabel = setNameOf(equipment, setId);
			// A copy's failed gem repair leaves this check unmeasured with no line,
			// as a failed repair of the swap itself does above.
			let layoutRepairFailed = false;
			const nextPieceResult = crossingBuild
				? await measureSameGearBonus(
						cachedSampleRun(`${crossingLabel} ${worn + 1}pc crossing check`),
						composeFor(crossingBuild.equipment),
						crossingBuild.equipment.flatMap((spec, i) => (spec.id && getItem(spec.id)?.setId === setId ? [i] : [])),
						worn,
						// "On" and "off" are compared as a pair, so they come from
						// one call.
						async copiesList => {
							const entries = repairErrorOr(
								await requestsPerLayout(g => chainSwapsWithRepairs(equipment, crossing, g), crossingBuild, copiesList),
							);
							if (!(entries instanceof MetaRepairError)) {
								return entries.map(requestOf);
							}
							layoutRepairFailed = true;
							// Never read: the check's result is dropped below.
							return copiesList.map(() => ({ buildError: errorText(entries) }));
						},
					)
				: undefined;
			const measured = layoutRepairFailed ? undefined : nextPieceResult;
			if (isSimFailure(measured)) {
				bonusNotMeasured(crossingLabel, worn + 1, SET_BONUS_SKIP_REASONS.simFailed(measured.simError));
			}
			if (isBuildFailure(measured)) {
				bonusNotMeasured(crossingLabel, worn + 1, SET_BONUS_SKIP_REASONS.notBuilt(measured.buildError));
			}
			const value = isSimFailure(measured) || isBuildFailure(measured) ? undefined : measured;
			crossingChecks.push({
				setId,
				count: worn + 1,
				itemId: best.itemId,
				...(value ? { dps: value.dps, se: value.se } : {}),
				cleared: value !== undefined && clearsSameGearNoise(value.dps, value.se, cutoff),
			});
		}
	}

	// The "on" screen estimates the added pieces' gain at each count with
	// `estimateCombinedDelta`, which adds no term for the set's own bonuses.
	// The estimate treats the row like any other added piece, so which piece is
	// the row does not matter. But each own delta of a set worn at w was simmed
	// with w + 1 pieces, so when w + 1 is a bonus count every own delta holds
	// that bonus once. The pair counts it already, so the crossing check's
	// value, which is that bonus, is taken out once per added piece (ticket
	// 886). A crossing check that ran without a value leaves the estimate
	// unset, and the screen keeps the set.
	const screenBrokenBonusDpsByKey = new Map(brokenSetValues.map(v => [bonusKey(v), v.dps] as const));
	const estimatedDeltaAt = (setId: number, threshold: number): number | undefined => {
		const selection = selectFor(setId, threshold);
		if (!selection.ok) return undefined;
		const crossing = crossingChecks.find(c => c.setId === setId && c.count === selection.piecesWorn + 1);
		if (crossing && crossing.dps === undefined) return undefined;
		const crossedPerPiece = crossing?.dps ?? 0;
		const pieces: PartnerPiece[] = [];
		for (const piece of selection.addedPieces) {
			const ownDelta = ownDeltasByItemId.get(piece.itemId)?.deltaDps;
			if (ownDelta === undefined) return undefined;
			pieces.push({
				itemId: piece.itemId,
				slotIndex: piece.slotIndex,
				ownDeltaDps: ownDelta,
			});
		}
		const [row, ...rest] = pieces;
		if (!row) return undefined;
		const estimate = estimateCombinedDelta(
			{
				row,
				brokenBy: swaps => brokenSetBonuses(equipment, swaps, setId, countsAsBreak),
				breakDps: (s, c) => screenBrokenBonusDpsByKey.get(`${s}:${c}`),
			},
			rest,
		);
		return estimate === undefined ? undefined : estimate - pieces.length * crossedPerPiece;
	};
	const setScreen: SetScreen | undefined = screenInput ? await runSetScreenOn({ ...screenInput, estimatedDeltaAt, baselineStdev }) : undefined;
	const screenedOut = new Set(setScreen ? setScreen.sets.filter(s => !s.kept).map(s => s.setId) : []);

	if (setIdsWithCandidates.size === 0) {
		return {
			bonuses: [],
			brokenSetValues,
			wornSetLadder,
			crossingChecks: [],
			firstSlotIndexByItemId: new Map(),
			setIdsNotValued: [],
			...(setScreen ? { setScreen } : {}),
		};
	}

	const results: SetBonusValue[] = [];
	const setIdsNotValued: number[] = [];
	for (const setId of setIdsWithCandidates) {
		const piecesWorn = wornCounts.get(setId) ?? 0;
		const label = setNameOf(
			equipment,
			setId,
			candidates.map(entry => entry.itemId),
		);
		let twoPcBonusDps: number | undefined;
		let twoPieceUnmeasurableAtThisWornCount = false;
		// With `measureSetBonuses`: a 4pc's value subtracts the 2pc's, so it
		// stays unset when the 2pc's sims were tried and failed.
		let twoPieceFailed = false;

		const thresholds = measureSetBonuses ? reachableCounts(setId, piecesWorn) : SET_THRESHOLDS.filter(t => t > piecesWorn);
		// No bonus in reach, or the set screen dropped the set: no bonus sims at
		// all. The set goes in `setIdsNotValued`, so its rows keep their own losses
		// and `crossesThreshold` in `setContext`, but it gets no `setBonuses`
		// entry, since none of its counts is a bonus the ranking measured.
		if ((measureSetBonuses && thresholds.length === 0) || screenedOut.has(setId)) {
			setIdsNotValued.push(setId);
			continue;
		}

		for (const threshold of thresholds) {
			if (!measureSetBonuses && !isBonusImplemented(setId, threshold)) {
				results.push({
					setId,
					setName: label,
					threshold,
					piecesWorn,
					packageItemIds: [],
					packageDeltaDps: 0,
					unmeasured: 'not-implemented-in-sim',
				});
				continue;
			}

			const selection = selectFor(setId, threshold);
			if (!selection.ok) {
				results.push({
					setId,
					setName: label,
					threshold,
					piecesWorn,
					packageItemIds: [],
					packageDeltaDps: 0,
					unmeasured: 'insufficient-pieces',
				});
				continue;
			}

			const addedPieces = selection.addedPieces;
			if (addedPieces.length === 1) {
				if (threshold === 2) twoPieceUnmeasurableAtThisWornCount = true;
				results.push({
					setId,
					setName: label,
					threshold,
					piecesWorn,
					packageItemIds: addedPieces.map(p => p.itemId),
					packageDeltaDps: 0,
					unmeasured: 'unmeasurable-at-this-worn-count',
				});
				continue;
			}
			/** A failed gem repair on this gear or any copy of it skips this bonus. */
			const skipRepairFailed = (err: MetaRepairError) => {
				console.warn(`[upgrades] ${label} ${threshold}pc bonus's added pieces not measured: gem repair failed`, err);
				bonusNotMeasured(label, threshold, SET_BONUS_SKIP_REASONS.metaOff(err.message));
				results.push({
					setId,
					setName: label,
					threshold,
					piecesWorn,
					packageItemIds: addedPieces.map(p => p.itemId),
					packageDeltaDps: 0,
					unmeasured: 'repair-failed',
				});
				if (threshold === 2) twoPieceFailed = true;
			};
			let gearBuild: ChainBuild;
			try {
				gearBuild = chainSwapsWithRepairs(equipment, addedPieces, gems);
			} catch (err) {
				if (!(err instanceof MetaRepairError)) throw err;
				skipRepairFailed(err);
				continue;
			}
			const builtGear = gearBuild;
			const rebuildGear = (g: GemContext) => chainSwapsWithRepairs(equipment, addedPieces, g);
			// The added pieces' sim and the same-gear check's two sims, bonus on
			// and bonus off (`measureSameGearBonus`), must wear the same gems, so
			// all three come from one `requestsPerLayout` call when the check runs.
			// `plainLayout` keeps the request without copies, or why it could not
			// be built.
			const plainLayout: { entry?: LayoutRequest | BuildFailure } = {};
			// A copy's failed gem repair skips this bonus with the repair's error, as
			// on the gear without copies; an undefined entry alone would show a
			// failed sim, and none ran.
			let layoutRepairError: MetaRepairError | undefined;
			const addedRequestsFor = async (copiesList: readonly CopyLayout[]) => {
				const entries = repairErrorOr(await requestsPerLayout(rebuildGear, builtGear, [{}, ...copiesList]));
				if (entries instanceof MetaRepairError) {
					layoutRepairError ??= entries;
					// Never read: the caller checks `layoutRepairError` first.
					const failed = { buildError: errorText(entries) };
					return copiesList.map(() => failed);
				}
				plainLayout.entry = entries[0];
				return entries.slice(1).map(requestOf);
			};

			// With `measureSetBonuses`, the same-gear check runs before the added
			// pieces' sim, so a count with no bonus here costs only the check's two
			// sims.
			let sameGear: DpsSample | undefined;
			if (measureSetBonuses) {
				const measured = await measureSameGearBonus(
					cachedSampleRun(`${label} ${threshold}pc same-gear bonus`),
					composeFor(builtGear.equipment),
					builtGear.equipment.flatMap((spec, i) => (spec.id && getItem(spec.id)?.setId === setId ? [i] : [])),
					threshold - 1,
					addedRequestsFor,
				);
				if (layoutRepairError) {
					skipRepairFailed(layoutRepairError);
					continue;
				}
				if (!measured || isSimFailure(measured) || isBuildFailure(measured)) {
					bonusNotMeasured(
						label,
						threshold,
						!measured
							? SET_BONUS_SKIP_REASONS.measuringSimsNotBuilt
							: isSimFailure(measured)
								? SET_BONUS_SKIP_REASONS.simFailed(measured.simError)
								: SET_BONUS_SKIP_REASONS.notBuilt(measured.buildError),
					);
					results.push({
						setId,
						setName: label,
						threshold,
						piecesWorn,
						packageItemIds: addedPieces.map(p => p.itemId),
						packageDeltaDps: 0,
						unmeasured: 'sim-failed',
					});
					if (threshold === 2) twoPieceFailed = true;
					continue;
				}
				sameGear = measured;
				if (!clearsSameGearNoise(sameGear.dps, sameGear.se, cutoff)) {
					results.push({
						setId,
						setName: label,
						threshold,
						piecesWorn,
						packageItemIds: addedPieces.map(p => p.itemId),
						packageDeltaDps: 0,
						sameGearDps: sameGear.dps,
						sameGearSe: sameGear.se,
						belowNoise: true,
					});
					continue;
				}
			}
			const sameGearFields = sameGear ? { sameGearDps: sameGear.dps, sameGearSe: sameGear.se } : {};
			const addedPiecesNotMeasured = (reason: SkipReason) => {
				bonusNotMeasured(label, threshold, reason);
				results.push({
					setId,
					setName: label,
					threshold,
					piecesWorn,
					packageItemIds: addedPieces.map(p => p.itemId),
					packageDeltaDps: 0,
					...sameGearFields,
					unmeasured: 'sim-failed',
				});
				if (threshold === 2) twoPieceFailed = true;
			};

			if (!plainLayout.entry) {
				const entries = repairErrorOr(await requestsPerLayout(rebuildGear, builtGear, [{}]));
				if (entries instanceof MetaRepairError) {
					skipRepairFailed(entries);
					continue;
				}
				[plainLayout.entry] = entries;
			}
			const gearEntry = plainLayout.entry!;
			if (isBuildFailure(gearEntry)) {
				addedPiecesNotMeasured(SET_BONUS_SKIP_REASONS.notBuilt(gearEntry.buildError));
				continue;
			}
			const gearRequest = gearEntry.request;
			// The gem changes to list: the repair swaps of the gear this sim wore,
			// outside the added pieces' own slots.
			const addedSlots = new Set(addedPieces.map(p => p.slotIndex));
			const gearRepairRecolors = gearEntry.recolors.filter(s => !addedSlots.has(s.itemIndex));
			let gearObs = await readCachedSim(deps, gearRequest, simVersion, runOpts);
			if (!gearObs) {
				try {
					gearObs = await deps.sim.run(gearRequest, runOpts);
				} catch (err) {
					// No warning for a sim the Stop guard refused.
					if (!deps.signal?.aborted) {
						console.warn(`[upgrades] ${label} ${threshold}pc bonus's added pieces not measured: the sim failed`, err);
					}
					addedPiecesNotMeasured(SET_BONUS_SKIP_REASONS.simFailed(errorText(err)));
					continue;
				}
				await cacheSimResult(deps, gearRequest, simVersion, runOpts, gearObs);
			}

			const addedPieceSamples = addedPieces.map(p => {
				const ownDelta = ownDeltasByItemId.get(p.itemId);
				return {
					deltaDps: ownDelta?.deltaDps ?? 0,
					se: ownDelta?.se ?? 0,
				};
			});
			const addedPiecesSample: DpsSample = {
				dps: gearObs.dps,
				se: gearObs.stdev / Math.sqrt(runOpts.iterations),
			};
			const bonusValue = computeBonusDps({
				baseline,
				addedPiecesSample,
				addedPieceSamples,
				...(threshold === 4 && twoPcBonusDps !== undefined ? { twoPcBonusDps } : {}),
			});
			if (threshold === 2) twoPcBonusDps = bonusValue.bonusDps;

			const breaks = brokenSetBonuses(equipment, addedPieces, setId, countsAsBreak);
			let selfConfound: SelfSetConfound | undefined = threshold === 4 && twoPieceUnmeasurableAtThisWornCount ? { threshold: 2 } : undefined;
			if (selfConfound) {
				// At worn 1 the 2pc takes one added piece, so it is never measured on
				// its own, and each piece's own gain includes it: the raw 4pc value is
				// short by the 2pc once per piece after the first. Two of the pieces
				// simmed together reach only the 2pc, so the 2pc is their own gains
				// minus the pair's gain. A lost bonus of another worn set would bias
				// that, so the pieces must lose none alone or as a pair: two pieces
				// that each keep worn Malorne 3 at 2 take it to 1 together. With no
				// such pair `bonusDpsNet` stays unset.
				const breakFree = addedPieces.filter(
					p => brokenSetBonuses(equipment, [p], setId, countsAsBreak).length === 0 && ownDeltasByItemId.has(p.itemId),
				);
				const pair = breakFree
					.flatMap((a, i) => breakFree.slice(i + 1).map(b => [a, b]))
					.find(p => brokenSetBonuses(equipment, p, setId, countsAsBreak).length === 0);
				const pairTwoPiece =
					pair !== undefined
						? await measurePairTwoPiece(
								`${label} ${threshold}pc`,
								deps,
								pair,
								equipment,
								gems,
								composeFor,
								ownDeltasByItemId,
								baseline,
								simVersion,
								runOpts,
								requestsPerLayout,
								reason => bonusNotMeasured(label, 2, reason),
							)
						: undefined;
				if (pairTwoPiece) {
					const extra = addedPieces.length - 1;
					bonusValue.bonusDps += extra * pairTwoPiece.dps;
					bonusValue.se = Math.sqrt(bonusValue.se ** 2 + (extra * pairTwoPiece.se) ** 2);
					selfConfound = { threshold: 2, dps: pairTwoPiece.dps };
				}
			}
			const missingTwoPiece = measureSetBonuses && threshold === 4 && twoPieceFailed;
			results.push({
				setId,
				setName: label,
				threshold,
				piecesWorn,
				packageItemIds: addedPieces.map(p => p.itemId),
				packageDeltaDps: bonusValue.packageDeltaDps,
				...(missingTwoPiece ? {} : { bonusDps: bonusValue.bonusDps, se: bonusValue.se }),
				...sameGearFields,
				...(breaks.length > 0 ? { breaks } : {}),
				...(selfConfound ? { selfConfound } : {}),
				...(gearRepairRecolors.length > 0
					? {
							gemSubstitutions: gearRepairRecolors.map(s => ({
								itemId: s.itemId,
								itemIndex: s.itemIndex,
								socketIndex: s.socketIndex,
								from: s.from,
								to: s.to,
							})),
						}
					: {}),
			});
		}
	}

	/** The first SIM_ORDER slot each item fits; nothing is compared. */
	const firstSlotIndexByItemId = new Map<number, number>();
	for (const entry of candidates) {
		const idx = slotIndexForPoolEntry(entry);
		if (idx === undefined) continue;
		if (!firstSlotIndexByItemId.has(entry.itemId)) {
			firstSlotIndexByItemId.set(entry.itemId, idx);
		}
	}

	// Correct `bonusDps` for the worn bonuses its added pieces lose, using their
	// measured values: `bonusDpsNet = bonusDps − netInflation(terms)`. Each
	// entry's own `breaks` keep this right when the 2pc and 4pc pick different
	// slots. The terms come from the union of this entry's, the 2pc entry's and every
	// added piece's own losses. While the 2pc's pieces are a prefix of the
	// 4pc's, that union is this entry's own `breaks`; the union keeps the
	// formula whole if `selectAddedPieces` changes.
	const brokenBonusDpsByKey = new Map<string, number | undefined>();
	for (const v of brokenSetValues) brokenBonusDpsByKey.set(bonusKey(v), v.dps);
	const memberOwnBreaks = (bonus: SetBonusValue): BrokenSetBonus[] =>
		bonus.packageItemIds.flatMap(itemId => {
			const slotIndex = firstSlotIndexByItemId.get(itemId);
			const memberSetId = getItem(itemId)?.setId;
			if (slotIndex === undefined || memberSetId == null) return [];
			return brokenSetBonuses(equipment, [{ itemId, slotIndex }], memberSetId, countsAsBreak);
		});
	for (const b of results) {
		if (b.bonusDps === undefined) continue;
		// A worn-1 4pc whose 2pc the pair sim did not measure is still short by
		// the 2pc once per piece after the first. Crediting it would rank rows on
		// a wrong figure, so the net stays unset and the row shows as not counted.
		if (b.selfConfound !== undefined && b.selfConfound.dps === undefined) {
			continue;
		}
		// The 2pc's terms apply only when the 4pc subtracted a measured 2pc value.
		const twoPiece =
			b.threshold === 4
				? results.find(r => r.setId === b.setId && r.threshold === 2 && r.unmeasured === undefined && r.bonusDps !== undefined)
				: undefined;
		const breaksToCorrect = new Map<string, BrokenSetBonus>();
		for (const brk of [...(b.breaks ?? []), ...(twoPiece?.breaks ?? []), ...memberOwnBreaks(b), ...(twoPiece ? memberOwnBreaks(twoPiece) : [])]) {
			breaksToCorrect.set(bonusKey(brk), brk);
		}
		const brokenByAllPieces = new Set((b.breaks ?? []).map(bonusKey));
		const brokenByAllTwoPcPieces = new Set((twoPiece?.breaks ?? []).map(bonusKey));
		const terms: InflationTerm[] = [];
		let allMeasured = true;
		for (const [key, brk] of breaksToCorrect) {
			const brokenBonusDps = brokenBonusDpsByKey.get(key);
			if (brokenBonusDps === undefined) {
				allMeasured = false;
				break;
			}
			terms.push({
				piecesBreakingAlone: countMembersBreaking(b, brk, equipment, firstSlotIndexByItemId, countsAsBreak),
				twoPcPiecesBreakingAlone: twoPiece ? countMembersBreaking(twoPiece, brk, equipment, firstSlotIndexByItemId, countsAsBreak) : 0,
				allPiecesBreak: brokenByAllPieces.has(key) ? 1 : 0,
				allTwoPcPiecesBreak: brokenByAllTwoPcPieces.has(key) ? 1 : 0,
				brokenBonusDps,
			});
		}
		if (allMeasured) b.bonusDpsNet = b.bonusDps - netInflation(terms);
	}

	return {
		bonuses: results,
		brokenSetValues,
		wornSetLadder,
		crossingChecks,
		firstSlotIndexByItemId,
		setIdsNotValued,
		...(setScreen ? { setScreen } : {}),
	};
}

/**
 * With `measureSetBonuses`, values each set row's future bonuses by sim.
 * For each bonus above noise, `choosePartners` picks the other set pieces,
 * and the current gear plus the row plus those pieces (swapped in slot order,
 * with the usual gem repairs) is simmed once per distinct gear; its
 * `bonusGearDps` is that sim minus the baseline. A failed choice, repair or
 * sim leaves the row unmeasured and never fails the ranking. Then the
 * bonus-off sims run for the bonuses the popover shows.
 */
async function measureBonusGear(args: {
	deps: Deps;
	ranked: RankedItem[];
	setBonuses: readonly SetBonusValue[];
	equipment: readonly SimItemSpec[];
	gems: GemContext;
	composeFor: (equipment: readonly SimItemSpec[]) => RaidSimRequest;
	ownDeltasByItemId: ReadonlyMap<number, OwnDelta>;
	brokenSetValues: readonly BrokenSetValue[];
	firstSlotIndexByItemId: ReadonlyMap<number, number>;
	countsAsBreak: CountsAsBreak;
	baseline: DpsSample;
	simVersion: string;
	runOpts: SimRunOpts;
	cutoff: Cutoff;
	/** Every request here comes from it. */
	requestsPerLayout: RequestsPerCopyLayout;
	/** A line, with the sim's error, for each bonus whose partner or bonus-off sim failed. */
	bonusNotes: RunNote[];
}): Promise<{
	bonusGearSims: BonusGearSims;
	bonusOffSims: SetBonusOffSims;
}> {
	const { deps, equipment, gems, composeFor, countsAsBreak, baseline, runOpts } = args;
	const brokenBonusDpsByKey = new Map<string, number | undefined>();
	for (const v of args.brokenSetValues) {
		brokenBonusDpsByKey.set(bonusKey(v), v.dps);
	}
	const nameOf = new Map(args.ranked.map(r => [r.itemId, r.name]));
	type SimCounter = { simmed: number; fromStore: number };
	const bonusGearCounter: SimCounter = { simmed: 0, fromStore: 0 };
	const bonusGearFailure = '[upgrades] set bonus gear not measured: the sim failed';

	const runCounted = async (request: RaidSimRequest, counter: SimCounter, failure: string): Promise<{ deltaDps: number; se: number } | SimFailure> => {
		let obs = await readCachedSim(deps, request, args.simVersion, runOpts);
		if (obs) {
			counter.fromStore += 1;
		} else {
			try {
				obs = await deps.sim.run(request, runOpts);
			} catch (err) {
				// No warning for a sim the Stop guard refused.
				if (!deps.signal?.aborted) console.warn(failure, err);
				return { simError: errorText(err) };
			}
			counter.simmed += 1;
			await cacheSimResult(deps, request, args.simVersion, runOpts, obs);
		}
		const se = obs.stdev / Math.sqrt(runOpts.iterations);
		return {
			deltaDps: obs.dps - baseline.dps,
			se: Math.sqrt(se ** 2 + baseline.se ** 2),
		};
	};

	/** A bonus some rows could not measure, and why. */
	const skipOnSomeRows = (setName: string, threshold: SetThreshold, reason: SkipReason) =>
		args.bonusNotes.push(setBonusSkipNote({ setName, threshold, reason, onSomeRows: true }));

	const inSlotOrder = (swaps: readonly PlacedItem[]) => [...swaps].sort((a, b) => a.slotIndex - b.slotIndex);
	/** The row-and-partners gear, or the error of its failed gem repair. */
	const bonusGearChain = (swaps: readonly PlacedItem[]): ChainBuild | MetaRepairError => {
		try {
			return chainSwapsWithRepairs(equipment, inSlotOrder(swaps), gems);
		} catch (err) {
			if (!(err instanceof MetaRepairError)) throw err;
			return err;
		}
	};
	/** The row-and-partners gear, or undefined when a gem repair fails. */
	const bonusGearBuild = (swaps: readonly PlacedItem[]): ChainBuild | undefined => {
		const chain = bonusGearChain(swaps);
		return chain instanceof MetaRepairError ? undefined : chain;
	};
	const bonusGearRebuild = (swaps: readonly PlacedItem[]) => (g: GemContext) => chainSwapsWithRepairs(equipment, inSlotOrder(swaps), g);

	/**
	 * With its own gem repair, or why it could not be built: a failed gem repair
	 * or a request build error.
	 */
	const bonusGearRequest = async (swaps: readonly PlacedItem[]): Promise<RaidSimRequest | SkipReason> => {
		const build = bonusGearChain(swaps);
		if (build instanceof MetaRepairError) {
			return SET_BONUS_SKIP_REASONS.metaOff(build.message);
		}
		const entry = (await args.requestsPerLayout(bonusGearRebuild(swaps), build, [{}]))[0]!;
		if (isRepairFailure(entry)) {
			return SET_BONUS_SKIP_REASONS.metaOff(entry.repairError.message);
		}
		return isBuildFailure(entry) ? SET_BONUS_SKIP_REASONS.rowsNotBuilt(entry.buildError) : entry.request;
	};
	const isSkipReason = (value: RaidSimRequest | SkipReason): value is SkipReason => 'because' in value;

	type FutureBonus = NonNullable<SetContext['futureBonuses']>[number];
	const requests = new Map<string, RaidSimRequest>();
	const pending: Array<{ future: FutureBonus; key: string; setName: string }> = [];
	const rowSwapOf = new Map<RankedItem, PlacedItem>();
	const partnersOf = new Map<FutureBonus, PlacedItem[]>();

	for (const item of args.ranked) {
		const ctx = item.setContext;
		if (!ctx) continue;
		const ownDelta = args.ownDeltasByItemId.get(item.itemId);
		if (!ownDelta) continue;
		ctx.singleDeltaDps = ownDelta.deltaDps;
		const eligible = (ctx.futureBonuses ?? []).filter(
			f => !f.belowNoise && f.sameGearDps !== undefined && clearsSameGearNoise(f.sameGearDps, f.sameGearSe ?? 0, args.cutoff),
		);
		if (eligible.length === 0) continue;

		const setId = ctx.setId;
		const wornSetSlots = new Set(equipment.flatMap((spec, i) => (spec.id && getItem(spec.id)?.setId === setId ? [i] : [])));
		const pieces: PartnerPiece[] = [];
		for (const [itemId, slotIndex] of args.firstSlotIndexByItemId) {
			if (itemId === item.itemId || getItem(itemId)?.setId !== setId) continue;
			const delta = args.ownDeltasByItemId.get(itemId);
			if (!delta) continue;
			pieces.push({ itemId, slotIndex, ownDeltaDps: delta.deltaDps });
		}
		const pool = partnerPool({
			pieces,
			wornSetSlots,
			rowSlotIndex: ownDelta.slotIndex,
		});
		const rowSwap: PlacedItem = {
			itemId: item.itemId,
			slotIndex: ownDelta.slotIndex,
		};
		rowSwapOf.set(item, rowSwap);
		const brokenBy = (swaps: readonly PlacedItem[]) => brokenSetBonuses(equipment, swaps, setId, countsAsBreak);

		for (const f of eligible) {
			// A partner combination whose sim fails is skipped, and the chosen
			// combination's gear is simmed below, so a failure counts for the row
			// only when no combination is chosen.
			let partnerSimFailure: SkipReason | undefined;
			const choice = await choosePartners({
				row: {
					itemId: item.itemId,
					slotIndex: ownDelta.slotIndex,
					ownDeltaDps: ownDelta.deltaDps,
				},
				setId,
				threshold: f.threshold,
				needed: f.threshold - ctx.piecesAfterSwap,
				pool,
				brokenBy,
				breakDps: (s, c) => brokenBonusDpsByKey.get(`${s}:${c}`),
				simGear: async partners => {
					const request = await bonusGearRequest([rowSwap, ...partners]);
					if (isSkipReason(request)) {
						partnerSimFailure ??= request;
						return undefined;
					}
					const delta = await runCounted(request, bonusGearCounter, bonusGearFailure);
					if (!isSimFailure(delta)) return delta;
					partnerSimFailure ??= SET_BONUS_SKIP_REASONS.rowSimsFailed(delta.simError);
					return undefined;
				},
			});
			// Here a future bonus's `pieces` and `breaks` come from the partner
			// choice, so the `pathToThreshold` ones are dropped first.
			delete f.pieces;
			delete f.breaks;
			if (choice === undefined) {
				if (partnerSimFailure !== undefined) {
					skipOnSomeRows(ctx.setName, f.threshold, partnerSimFailure);
				}
				continue;
			}
			if ('unmeasured' in choice) {
				f.partnerUnmeasured = choice.unmeasured;
				continue;
			}
			const slotOf = new Map<number, number>();
			for (const p of pool) {
				slotOf.set(p.itemId, p.slotIndex);
			}
			const partners: PlacedItem[] = choice.itemIds.map(itemId => ({ itemId, slotIndex: slotOf.get(itemId)! })).sort((a, b) => a.slotIndex - b.slotIndex);
			partnersOf.set(f, partners);
			f.partnerRule = PARTNER_RULE;
			f.pieces = partners.map(p => ({
				itemId: p.itemId,
				name: nameOf.get(p.itemId) ?? String(p.itemId),
			}));
			// Every counted worn bonus this gear loses against the current gear,
			// the row's own loss included, because the popover line is a total
			// against the current gear.
			const broken = brokenBy([rowSwap, ...partners]);
			if (broken.length > 0) {
				f.breaks = broken.map(brk => {
					const dps = brokenBonusDpsByKey.get(bonusKey(brk));
					return {
						setId: brk.setId,
						setName: brk.setName,
						threshold: brk.threshold,
						...(dps !== undefined ? { dps } : {}),
					};
				});
			}
			const request = await bonusGearRequest([rowSwap, ...partners]);
			if (isSkipReason(request)) {
				skipOnSomeRows(ctx.setName, f.threshold, request);
				continue;
			}
			const key = simCacheKey(request, args.simVersion, runOpts);
			requests.set(key, request);
			pending.push({ future: f, key, setName: ctx.setName });
		}
	}

	// Identical gears are simmed once. Each task handles its own sim failure,
	// so one failed sim leaves only its own future bonuses unmeasured.
	const deltas = new Map<string, { deltaDps: number; se: number }>();
	const bonusGearErrors = new Map<string, string>();
	const keys = [...requests.keys()];
	await promisePool(
		keys.map(key => async () => {
			const delta = await runCounted(requests.get(key)!, bonusGearCounter, bonusGearFailure);
			if (isSimFailure(delta)) bonusGearErrors.set(key, delta.simError);
			else deltas.set(key, delta);
		}),
		deps.concurrency ?? 1,
	);
	for (const { future, key, setName } of pending) {
		const simError = bonusGearErrors.get(key);
		if (simError !== undefined) {
			skipOnSomeRows(setName, future.threshold, SET_BONUS_SKIP_REASONS.rowSimsFailed(simError));
		}
		const delta = deltas.get(key);
		if (!delta) continue;
		future.bonusGearDps = delta.deltaDps;
		future.bonusGearSe = delta.se;
	}

	// The bonus-off sims run for exactly the bonuses the popover shows, so this
	// uses the view's own list of them (`setPotentialIncrements`).
	const offCounter: SimCounter = { simmed: 0, fromStore: 0 };
	const offRequests = new Map<string, { request: RaidSimRequest; plain: RaidSimRequest }>();
	const offPending: Array<{
		future: FutureBonus;
		key: string;
		broken: Array<{ setId: number; threshold: SetThreshold }>;
	}> = [];
	let skippedIncrements = 0;
	const setIdAt = (gear: readonly SimItemSpec[], slot: number): number | undefined => {
		const id = gear[slot]?.id;
		return (id ? getItem(id)?.setId : undefined) ?? undefined;
	};
	const countOf = (gear: readonly SimItemSpec[], setId: number) => gear.filter((_, slot) => setIdAt(gear, slot) === setId).length;

	/** Queues one shown bonus's bonus-off request; false when none can be built. */
	const queueBonusOff = async (
		future: FutureBonus,
		prevSwaps: readonly PlacedItem[],
		swaps: readonly PlacedItem[],
		broken: Array<{ setId: number; threshold: SetThreshold }>,
		firstIncrement: boolean,
	): Promise<boolean> => {
		const beforeBuild = bonusGearBuild(prevSwaps);
		const before = beforeBuild?.equipment;
		const after = bonusGearBuild(swaps)?.equipment;
		if (!beforeBuild || !before || !after) return false;
		const brokenSets = new Set(broken.map(b => b.setId));
		const prevIds = new Set(prevSwaps.map(p => p.itemId));
		const replaced = [...new Set(swaps.filter(p => !prevIds.has(p.itemId)).map(p => p.slotIndex))]
			.filter(slot => {
				const setId = setIdAt(before, slot);
				return setId !== undefined && brokenSets.has(setId);
			})
			.sort((a, b) => a - b);
		if (replaced.length === 0) return false;
		// Copying the replaced pieces must leave each lost set at its count after
		// this bonus's swaps; otherwise (a two-hander's off-hand, a repair) the
		// bonus-off gear is not the gear before minus exactly these bonuses.
		for (const setId of brokenSets) {
			const copied = replaced.filter(slot => setIdAt(before, slot) === setId).length;
			if (countOf(before, setId) - copied !== countOf(after, setId)) {
				return false;
			}
		}
		// `plain` must be the request simmed for the gear before and the bonus-off
		// request its pair, so both come from one call. For later bonuses entry 0
		// is the previous bonus's own request (the gear build is deterministic and
		// its read is cached).
		const beforeAndOffEntries = repairErrorOr(await args.requestsPerLayout(bonusGearRebuild(prevSwaps), beforeBuild, [{}, { setLess: replaced }]));
		// As when the gear before or after fails its repair above: the split is
		// skipped, with no line, since no call failed.
		if (beforeAndOffEntries instanceof MetaRepairError) {
			console.warn(
				'[upgrades] increment not split into breaks and pieces: the gem repair of the gear before or the bonus-off gear failed',
				beforeAndOffEntries,
			);
			return false;
		}
		const [plainEntry, offEntry] = beforeAndOffEntries;
		if (!plainEntry || !offEntry || isBuildFailure(plainEntry) || isBuildFailure(offEntry)) {
			const error = [plainEntry, offEntry].find(isBuildFailure)?.buildError;
			console.warn('[upgrades] increment not split into breaks and pieces: its request could not be built', error);
			if (error !== undefined) {
				for (const b of broken) {
					args.bonusNotes.push(
						breakSplitSkipNote({
							setName: setNameOf(equipment, b.setId),
							threshold: b.threshold,
							error,
							notBuilt: true,
						}),
					);
				}
			}
			return false;
		}
		const plain = plainEntry.request;
		const request = offEntry.request;
		// For the first bonus the gear before is the row's own swap, built here on
		// the run's hit budget. If entry 0 was repaired again for set-bonus hit
		// that budget misses, it differs from that build, so the split is skipped
		// rather than paired with gear gemmed another way. The candidate loop repairs
		// on the row's own stats read, so it may have simmed entry 0; this check
		// does not look for that sim.
		if (firstIncrement && stableStringify(plain) !== stableStringify(composeFor(before))) {
			return false;
		}
		const key = simCacheKey(request, args.simVersion, runOpts);
		if (!offRequests.has(key)) offRequests.set(key, { request, plain });
		offPending.push({ future, key, broken });
		return true;
	};

	for (const item of args.ranked) {
		const ctx = item.setContext;
		const rowSwap = rowSwapOf.get(item);
		if (!ctx?.usesBonusGear || !rowSwap || setCreditUnmeasured(ctx)) continue;
		const increments = setPotentialIncrements(ctx, args.cutoff);
		if (!increments) continue;
		let prevSwaps: PlacedItem[] | undefined = [rowSwap];
		let firstIncrement = true;
		for (const increment of increments) {
			const f = (ctx.futureBonuses ?? []).find(x => x.threshold === increment.threshold);
			const partners = f ? partnersOf.get(f) : undefined;
			const swaps = partners ? [rowSwap, ...partners] : undefined;
			if (increment.broken.length > 0) {
				const broken = increment.broken.map(b => ({
					setId: b.setId,
					threshold: b.threshold as SetThreshold,
				}));
				const queued =
					f !== undefined && swaps !== undefined && prevSwaps !== undefined && (await queueBonusOff(f, prevSwaps, swaps, broken, firstIncrement));
				if (!queued) skippedIncrements += 1;
			}
			prevSwaps = swaps;
			firstIncrement = false;
		}
	}

	// The popover's loss line is the bonus-off sim minus the sim of the gear
	// before without copies (the previous bonus's gear, or the row's own swap).
	// Only a gear-before sim this run already holds makes that a paired
	// difference, so a request whose gear-before sim is missing is not simmed.
	const paired = new Set<string>();
	for (const [key, { plain }] of offRequests) {
		if (await readCachedSim(deps, plain, args.simVersion, runOpts)) {
			paired.add(key);
		}
	}
	const offDeltas = new Map<string, { deltaDps: number; se: number }>();
	const offErrors = new Map<string, string>();
	let failedGears = 0;
	await promisePool(
		[...paired].map(key => async () => {
			const delta = await runCounted(offRequests.get(key)!.request, offCounter, '[upgrades] increment not split into breaks and pieces: the sim failed');
			if (isSimFailure(delta)) {
				offErrors.set(key, delta.simError);
				failedGears += 1;
			} else offDeltas.set(key, delta);
		}),
		deps.concurrency ?? 1,
	);
	for (const { future, key, broken } of offPending) {
		if (!paired.has(key)) {
			skippedIncrements += 1;
			continue;
		}
		const simError = offErrors.get(key);
		if (simError !== undefined) {
			for (const b of broken) {
				args.bonusNotes.push(
					breakSplitSkipNote({
						setName: setNameOf(equipment, b.setId),
						threshold: b.threshold,
						error: simError,
					}),
				);
			}
		}
		const delta = offDeltas.get(key);
		if (!delta) continue;
		future.bonusOffDps = delta.deltaDps;
		future.bonusOffSe = delta.se;
		future.bonusOff = broken;
	}

	return {
		bonusGearSims: {
			partnerRule: PARTNER_RULE,
			gears: keys.length,
			simmed: bonusGearCounter.simmed,
			fromStore: bonusGearCounter.fromStore,
		},
		bonusOffSims: {
			gears: offRequests.size,
			simmed: offCounter.simmed,
			fromStore: offCounter.fromStore,
			failedGears,
			skippedIncrements,
			beforeInStore: paired.size,
		},
	};
}

/** The highest-count measured entry with added pieces, for `commitBreaks`. */
function topMeasuredBonus(bonusesForSet: readonly SetBonusValue[]): SetBonusValue | undefined {
	// A `belowNoise` entry lists added pieces but never simmed them.
	return [...bonusesForSet]
		.filter(b => b.unmeasured === undefined && !b.belowNoise && b.packageItemIds.length > 0)
		.sort((a, b) => b.threshold - a.threshold)[0];
}

/**
 * The worn bonuses lost by the top entry's added pieces with `itemId` in its
 * own slot (the entry's piece in that slot, if any, is dropped): a row's
 * `commitBreaks` before its own losses are taken out.
 */
function topBonusBreaksWithRow(
	itemId: number,
	setId: number,
	slotIndex: number,
	topBonus: SetBonusValue,
	firstSlotIndexByItemId: ReadonlyMap<number, number>,
	equipment: readonly SimItemSpec[],
	countsAsBreak: CountsAsBreak,
): BrokenSetBonus[] {
	const substituted: PlacedItem[] = topBonus.packageItemIds
		.map(pieceItemId => ({
			itemId: pieceItemId,
			slotIndex: firstSlotIndexByItemId.get(pieceItemId),
		}))
		.filter((p): p is PlacedItem => p.slotIndex !== undefined && p.slotIndex !== slotIndex);
	substituted.push({ itemId, slotIndex });
	return brokenSetBonuses(equipment, substituted, setId, countsAsBreak);
}

/**
 * One sim of two set pieces that lose no worn bonus, added together at worn
 * 1: the 2pc's value is their own gains minus the pair's gain. Undefined when
 * the gem repair or the sim fails; the caller then leaves the 4pc's
 * `bonusDpsNet` unset. Why goes to `onNotMeasured` with the error, except for
 * a sim Stop refused.
 */
async function measurePairTwoPiece(
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

/**
 * The pieces a player adds to reach `bonus`'s threshold with this candidate as
 * one of them: all of `bonus`'s added pieces if the candidate is one, else the
 * candidate plus the best of them outside its slot, one fewer than `bonus`
 * adds, ranked as `selectAddedPieces` ranks them (own gain, then lowest id).
 */
function pathToThreshold(
	itemId: number,
	slotIndex: number,
	bonus: SetBonusValue,
	firstSlotIndexByItemId: ReadonlyMap<number, number>,
	ownDeltasByItemId: ReadonlyMap<number, OwnDelta>,
): PlacedItem[] {
	const members = bonus.packageItemIds
		.map(pieceItemId => ({
			itemId: pieceItemId,
			slotIndex: firstSlotIndexByItemId.get(pieceItemId),
		}))
		.filter((p): p is PlacedItem => p.slotIndex !== undefined);
	if (bonus.packageItemIds.includes(itemId)) return members;
	const deltaOf = (id: number) => ownDeltasByItemId.get(id)?.deltaDps ?? -Infinity;
	const rest = members
		.filter(p => p.slotIndex !== slotIndex)
		.sort((a, b) => (deltaOf(b.itemId) !== deltaOf(a.itemId) ? deltaOf(b.itemId) - deltaOf(a.itemId) : a.itemId - b.itemId))
		.slice(0, bonus.packageItemIds.length - 1);
	return [...rest, { itemId, slotIndex }];
}

/**
 * How many of `bonus`'s added pieces lose the worn bonus `target` by their own
 * swap, for `netInflation`.
 */
function countMembersBreaking(
	bonus: SetBonusValue,
	target: Pick<BrokenSetBonus, 'setId' | 'threshold'>,
	equipment: readonly SimItemSpec[],
	firstSlotIndexByItemId: ReadonlyMap<number, number>,
	countsAsBreak: CountsAsBreak,
): number {
	let k = 0;
	for (const itemId of bonus.packageItemIds) {
		const slotIndex = firstSlotIndexByItemId.get(itemId);
		if (slotIndex === undefined) continue;
		const memberSetId = getItem(itemId)?.setId;
		if (memberSetId == null) continue;
		const breaks = brokenSetBonuses(equipment, [{ itemId, slotIndex }], memberSetId, countsAsBreak);
		if (breaks.some(brk => brk.setId === target.setId && brk.threshold === target.threshold)) {
			k += 1;
		}
	}
	return k;
}

/**
 * The value of each piece count of every set worn at 2 or more pieces
 * (`measureWornSetCounts`), in set-id order. A count is `counted` when its
 * value is above noise. A count whose sim failed is `counted` only when the
 * sim's list of the set's bonuses (`readBonuses`) has it, so no count without
 * a bonus becomes a loss. When that list fails too, no failed count is
 * counted, and the lines say what was not measured. A runner with no list
 * gives no such line, so there a failed count is counted.
 */
async function measureWornSets(
	equipment: readonly SimItemSpec[],
	composeFor: (equipment: readonly SimItemSpec[]) => RaidSimRequest,
	cachedSampleRun: (what: string) => (request: RaidSimRequest) => Promise<DpsSample>,
	cutoff: Cutoff,
	notes: RunNote[],
	readBonuses?: (request: RaidSimRequest) => Promise<readonly string[]>,
): Promise<WornSetCountEntry[]> {
	const worn = [...setCounts(equipment)]
		.filter(([, count]) => count >= 2)
		.map(([setId]) => setId)
		.sort((a, b) => a - b);
	if (worn.length === 0) return [];
	const request = composeFor(equipment);
	const entries: WornSetCountEntry[] = [];
	for (const setId of worn) {
		const setName = setNameOf(equipment, setId);
		const slots = equipment.flatMap((spec, i) => (spec.id && getItem(spec.id)?.setId === setId ? [i] : []));
		const countValues = await measureWornSetCounts(cachedSampleRun(`${setName} worn-set counts`), request, slots, (error, notBuilt) =>
			notes.push(
				wornSetSkipNote({
					setName,
					error,
					...(notBuilt ? { notBuilt } : {}),
				}),
			),
		);
		const bonusCounts =
			readBonuses && countValues.some(countValue => countValue.unmeasured !== undefined)
				? await wornSetBonusCounts(readBonuses, request, slots, setName, notes)
				: undefined;
		for (const countValue of countValues) {
			const counted =
				countValue.unmeasured !== undefined
					? (bonusCounts?.has(countValue.count) ?? true)
					: countValue.dps !== undefined && clearsSameGearNoise(countValue.dps, countValue.se ?? 0, cutoff);
			entries.push({ setId, setName, ...countValue, counted });
		}
	}
	return entries;
}

/**
 * The counts at which a worn set has a bonus, as the sim lists them: the
 * bonuses active on the worn gear that go when the set's pieces are sent as
 * set-less copies. Empty when a read fails, with a line that gives its error;
 * undefined when Stop refused the read.
 */
async function wornSetBonusCounts(
	readBonuses: (request: RaidSimRequest) => Promise<readonly string[]>,
	request: RaidSimRequest,
	slots: readonly number[],
	setName: string,
	notes: RunNote[],
): Promise<ReadonlySet<number> | undefined> {
	let setLess: RaidSimRequest;
	try {
		setLess = applySetLessCopies(request, slots);
	} catch (err) {
		console.warn(`[upgrades] ${setName}: its bonus counts were not read`, err);
		notes.push(
			setBonusCountsSkipNote({
				setName,
				reason: SET_BONUS_SKIP_REASONS.bonusListNotBuilt(errorText(err)),
			}),
		);
		return new Set();
	}
	try {
		const worn = await readBonuses(request);
		const left = new Set(await readBonuses(setLess));
		const counts = new Set<number>();
		for (const name of worn) {
			if (left.has(name)) continue;
			const match = / \((\d+)pc\)$/.exec(name);
			if (match) counts.add(Number(match[1]));
		}
		return counts;
	} catch (err) {
		if (err instanceof StopRefusedSim) return undefined;
		console.warn(`[upgrades] ${setName}: its bonus counts were not read`, err);
		notes.push(
			setBonusCountsSkipNote({
				setName,
				reason: SET_BONUS_SKIP_REASONS.bonusListFailed(errorText(err)),
			}),
		);
		return new Set();
	}
}

/** With `measureSetBonuses`, a swap loses only counts `wornSetLadder` counted. */
function countsAsBreakFrom(wornSetCounts: readonly WornSetCountEntry[]): CountsAsBreak {
	const counted = new Set(wornSetCounts.filter(e => e.counted).map(e => `${e.setId}:${e.count}`));
	return (setId, count) => counted.has(`${setId}:${count}`);
}

/**
 * The smallest entry count above `after` whose bonus was above noise on its
 * own gear, or null. An entry has `sameGearDps` without `belowNoise` exactly
 * when it was.
 */
function nextClearedThreshold(bonusesForSet: readonly SetBonusValue[], after: number): SetThreshold | null {
	const counts = bonusesForSet.filter(b => b.threshold > after && b.sameGearDps !== undefined && !b.belowNoise).map(b => b.threshold);
	return counts.length > 0 ? Math.min(...counts) : null;
}

export function bonusesWithItem(itemId: number, bonusesForSet: readonly SetBonusValue[]): AddedPiecesContext[] | undefined {
	// A `belowNoise` entry's pieces were never simmed, so its `packageDeltaDps`
	// of 0 is not a measurement.
	const measured = bonusesForSet.filter(b => b.unmeasured === undefined && !b.belowNoise);
	if (!measured.some(b => b.packageItemIds.includes(itemId))) {
		return undefined;
	}
	return measured
		.slice()
		.sort((a, b) => a.threshold - b.threshold)
		.map(b => ({
			threshold: b.threshold,
			deltaDps: b.packageDeltaDps,
			itemIds: b.packageItemIds,
			piecesNeeded: b.packageItemIds.length,
		}));
}

function applySetContext(
	ranked: RankedItem[],
	setBonuses: readonly SetBonusValue[],
	equipment: readonly SimItemSpec[],
	brokenSetValues: readonly BrokenSetValue[] = [],
	firstSlotIndexByItemId: ReadonlyMap<number, number> = new Map(),
	ownDeltasByItemId: ReadonlyMap<number, OwnDelta> = new Map(),
	countsAsBreak: CountsAsBreak = isBonusImplemented,
	/**
	 * Present exactly with `measureSetBonuses`: the `crossingChecks`, so the
	 * reached and next counts read measurements instead of the
	 * `isBonusImplemented` table, and every entry above the swap's count
	 * becomes a future bonus.
	 */
	measured?: { crossingChecks: readonly CrossingCheck[] },
	setIdsNotValued: readonly number[] = [],
): void {
	const wornCounts = setCounts(equipment);
	const bonusesBySet = new Map<number, SetBonusValue[]>();
	for (const b of setBonuses) {
		const list = bonusesBySet.get(b.setId) ?? [];
		list.push(b);
		bonusesBySet.set(b.setId, list);
	}
	for (const setId of setIdsNotValued) {
		if (!bonusesBySet.has(setId)) bonusesBySet.set(setId, []);
	}
	const brokenBonusDpsByKey = new Map<string, number | undefined>();
	for (const v of brokenSetValues) brokenBonusDpsByKey.set(bonusKey(v), v.dps);
	const brokenBonusDps = (brk: BrokenSetBonus): number | undefined => brokenBonusDpsByKey.get(bonusKey(brk));
	const rankedById = new Map(ranked.map(r => [r.itemId, r]));

	for (const item of ranked) {
		const setId = getItem(item.itemId)?.setId;
		if (setId == null) continue;
		const bonusesForSet = bonusesBySet.get(setId);
		if (!bonusesForSet) continue;

		const piecesWornBefore = wornCounts.get(setId) ?? 0;
		const piecesAfterSwap = item.owned ? piecesWornBefore : piecesWornBefore + 1;
		// With `measureSetBonuses`, one more piece reaches a bonus only when
		// that count's `crossingChecks` entry cleared, and the next bonus is the
		// next count above noise. No table is read.
		const crossingCleared = measured?.crossingChecks.some(g => g.setId === setId && g.count === piecesWornBefore + 1 && g.cleared) ?? false;
		const nextThresholdBeforeSwap = measured
			? crossingCleared
				? piecesWornBefore + 1
				: nextClearedThreshold(bonusesForSet, piecesWornBefore)
			: nextImplementedThreshold(setId, piecesWornBefore);
		const crossesThreshold = measured
			? !item.owned && piecesAfterSwap === piecesWornBefore + 1 && crossingCleared
			: nextThresholdBeforeSwap !== null && piecesAfterSwap >= nextThresholdBeforeSwap;
		const nextThreshold = measured ? nextClearedThreshold(bonusesForSet, piecesAfterSwap) : nextImplementedThreshold(setId, piecesAfterSwap);

		const setContext: SetContext = {
			setId,
			setName: bonusesForSet[0]?.setName ?? setNameOf(equipment, setId, [item.itemId]),
			piecesWornBefore,
			piecesAfterSwap,
			nextThreshold,
			crossesThreshold,
			...(measured ? { usesBonusGear: true as const } : {}),
		};

		const slotIndex = firstSlotIndexByItemId.get(item.itemId);

		// singleBreaks: worn bonuses this piece loses by itself, already inside
		// deltaDps; dps is their measured value when there is one.
		if (slotIndex !== undefined) {
			const ownBreaks = brokenSetBonuses(equipment, [{ itemId: item.itemId, slotIndex }], setId, countsAsBreak);
			if (ownBreaks.length > 0) {
				setContext.singleBreaks = ownBreaks.map(brk => {
					const dps = brokenBonusDps(brk);
					return {
						setId: brk.setId,
						setName: brk.setName,
						threshold: brk.threshold,
						...(dps !== undefined ? { dps } : {}),
					};
				});
			}
		}

		// futureBonuses: every implemented threshold above the post-swap count,
		// with its net value (dps absent when unmeasured). Only for a swap that
		// adds a set piece: a worn row's swap changes nothing, so a future bonus
		// would rank "keep what you wear" on value the swap cannot bring.
		const advancesPieceCount = piecesAfterSwap > piecesWornBefore;
		// The view never adds a `belowNoise` bonus (`canBeCredited`), but it is
		// listed so the row can say the count was tried.
		const futureThresholds = measured
			? bonusesForSet
					.filter(b => advancesPieceCount && b.threshold > piecesAfterSwap && (b.packageItemIds.length > 0 || b.belowNoise === true))
					.map(b => b.threshold)
					.sort((a, b) => a - b)
			: [...SET_THRESHOLDS].filter(t => advancesPieceCount && t > piecesAfterSwap && isBonusImplemented(setId, t));
		const ownBreakKeys = new Set((setContext.singleBreaks ?? []).map(bonusKey));
		const withDps = (brk: BrokenSetBonus) => {
			const dps = brokenBonusDps(brk);
			return {
				setId: brk.setId,
				setName: brk.setName,
				threshold: brk.threshold,
				...(dps !== undefined ? { dps } : {}),
			};
		};
		// A path piece's swap gain, read before replication rewrites the top
		// rows' `deltaDps`, so a row among measured added pieces sums to their
		// gain. The worn bonuses it loses alone are added back because the path
		// charges each loss once; the 2pc it reaches alone at worn 1 is taken out
		// because the row's own gain already holds it. Undefined when any input
		// was unmeasured.
		const pathPieceGain = (p: PlacedItem): number | undefined => {
			const ownDelta = ownDeltasByItemId.get(p.itemId)?.deltaDps;
			if (ownDelta === undefined) return undefined;
			let gain = ownDelta;
			for (const brk of brokenSetBonuses(equipment, [p], setId, countsAsBreak)) {
				const dps = brokenBonusDps(brk);
				if (dps === undefined) return undefined;
				gain += dps;
			}
			const countAfterPieceSwap = rankedById.get(p.itemId)?.owned ? piecesWornBefore : piecesWornBefore + 1;
			if (nextThresholdBeforeSwap !== null && countAfterPieceSwap >= nextThresholdBeforeSwap) {
				const crossed = bonusesForSet.find(b => b.selfConfound?.threshold === nextThresholdBeforeSwap)?.selfConfound?.dps;
				if (crossed === undefined) return undefined;
				gain -= crossed;
			}
			return gain;
		};
		const futureBonuses = futureThresholds.map(t => {
			const bonus = bonusesForSet.find(b => b.threshold === t);
			const net = bonus?.bonusDpsNet;
			// No path through a `belowNoise` entry: its pieces were never simmed.
			const path =
				bonus && bonus.unmeasured === undefined && !bonus.belowNoise && bonus.packageItemIds.length > 0 && slotIndex !== undefined
					? pathToThreshold(item.itemId, slotIndex, bonus, firstSlotIndexByItemId, ownDeltasByItemId)
					: undefined;
			// The worn bonuses this path loses beyond the row's own loss. Ones a
			// lower future bonus already lists stay; the view charges each once.
			const pathBreaks = path ? brokenSetBonuses(equipment, path, setId, countsAsBreak).filter(brk => !ownBreakKeys.has(bonusKey(brk))) : [];
			// The path's other pieces. Ones a lower future bonus already lists stay;
			// the view counts each once.
			const pieces = path
				?.filter(p => p.itemId !== item.itemId)
				.map(p => {
					const dps = pathPieceGain(p);
					return {
						itemId: p.itemId,
						name: rankedById.get(p.itemId)?.name ?? String(p.itemId),
						...(dps !== undefined ? { dps } : {}),
					};
				});
			// Pieces the player still needs from their current worn count to
			// activate this threshold, counting this candidate as one of them (at
			// worn 1 the 4pc needs 3 more).
			return {
				threshold: t,
				piecesNeeded: t - piecesWornBefore,
				...(net !== undefined ? { dps: net } : {}),
				...(bonus?.sameGearDps !== undefined && bonus.sameGearSe !== undefined ? { sameGearDps: bonus.sameGearDps, sameGearSe: bonus.sameGearSe } : {}),
				...(bonus?.belowNoise ? { belowNoise: true as const } : {}),
				...(pathBreaks.length > 0 ? { breaks: pathBreaks.map(withDps) } : {}),
				...(pieces ? { pieces } : {}),
			};
		});
		if (futureBonuses.length > 0) setContext.futureBonuses = futureBonuses;

		// commitBreaks: the worn bonuses lost by the top entry's added pieces with
		// this item in its slot, beyond the row's own loss. commitPackageDeltaDps:
		// those pieces' sim gain, shown only.
		const topBonus = topMeasuredBonus(bonusesForSet);
		if (topBonus && slotIndex !== undefined) {
			const topBonusBreaks = topBonusBreaksWithRow(item.itemId, setId, slotIndex, topBonus, firstSlotIndexByItemId, equipment, countsAsBreak);
			const topBonusBreaksBeyondRow = topBonusBreaks.filter(brk => !ownBreakKeys.has(bonusKey(brk)));
			if (topBonusBreaksBeyondRow.length > 0) {
				setContext.commitBreaks = topBonusBreaksBeyondRow.map(withDps);
			}
			setContext.commitPackageDeltaDps = topBonus.packageDeltaDps;
		}

		const bonuses = bonusesWithItem(item.itemId, bonusesForSet);
		if (bonuses) setContext.packages = bonuses;
		item.setContext = setContext;
	}
}

/**
 * For each set, the piece counts above the worn count at which the sim has a
 * bonus, up to the most pieces the pool can fill (`mostAddedPieces` gives
 * those pieces). They are the bonuses the sim lists as active
 * (`<set> (<n>pc)`) with those pieces added, less those active on the current
 * gear, so no set name has to match one the tab keeps.
 *
 * When those pieces fail gem repair or a read fails, the set gets no counts:
 * no reachable bonus or `crossingChecks` entry is simmed for it, a console
 * warning names the set, and `onNotRead` gets the reason. When Stop refuses a
 * read the set gets no counts and no warning, and `rankUpgrades` drops the
 * whole set phase. A runner that cannot read bonuses gives an empty map, and
 * every count is then tried.
 */
async function setBonusCountsInReach(
	sim: SimRunner,
	setIds: ReadonlySet<number>,
	mostAddedPieces: (setId: number) => PlacedItem[] | undefined,
	equipment: readonly SimItemSpec[],
	gems: GemContext,
	composeFor: (equipment: readonly SimItemSpec[]) => RaidSimRequest,
	onNotRead: (setId: number, reason: SkipReason) => void,
): Promise<Map<number, ReadonlySet<number>>> {
	const out = new Map<number, ReadonlySet<number>>();
	if (!sim.activeSetBonuses) return out;
	const read = (eq: readonly SimItemSpec[]) => sim.activeSetBonuses!(composeFor(eq));
	let wornNames: ReadonlySet<string> | undefined;
	for (const setId of [...setIds].sort((a, b) => a - b)) {
		const top = mostAddedPieces(setId);
		if (!top) continue;
		let build: ChainBuild;
		try {
			build = chainSwapsWithRepairs(equipment, top, gems);
		} catch (err) {
			if (!(err instanceof MetaRepairError)) throw err;
			console.warn(`[upgrades] set ${setId}: its bonus counts were not read, the added pieces' gem repair failed`, err);
			onNotRead(setId, SET_BONUS_SKIP_REASONS.metaOff(err.message));
			out.set(setId, new Set());
			continue;
		}
		try {
			wornNames ??= new Set(await read(equipment));
			const counts = new Set<number>();
			for (const name of await read(build.equipment)) {
				if (wornNames.has(name)) continue;
				const match = / \((\d+)pc\)$/.exec(name);
				if (match) counts.add(Number(match[1]));
			}
			out.set(setId, counts);
		} catch (err) {
			// A read the Stop guard refused is no failure to report.
			if (!(err instanceof StopRefusedSim)) {
				console.warn(`[upgrades] set ${setId}: its bonus counts were not read`, err);
				onNotRead(setId, SET_BONUS_SKIP_REASONS.bonusListFailed(errorText(err)));
			}
			out.set(setId, new Set());
		}
	}
	return out;
}

/** What the set phase gives when it does not run, or when Stop drops it. */
function emptySetPhase(): Awaited<ReturnType<typeof buildSetBonuses>> {
	return {
		bonuses: [],
		brokenSetValues: [],
		wornSetLadder: [],
		crossingChecks: [],
		firstSlotIndexByItemId: new Map(),
		setIdsNotValued: [],
	};
}
