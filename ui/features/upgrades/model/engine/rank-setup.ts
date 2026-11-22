/**
 * What a run settles before its baseline sim: iterations and seeds, the fight, the worn
 * gear's meta repair, the candidates it may price and the ranking's cache key, plus the race
 * and talents read from the page's request. `RunContext` holds the inputs every later step
 * reads.
 */

import type { GemContext } from './candidate-gems';
import { orderCandidatesByEp } from './candidate-order';
import { type CapProfile, type HitCapBudget, targetsAtCapLevel, usesSpellHitBudget } from './cap-profile';
import { canonicalJson, ENGINE_VERSION, type HashedGearItem } from './content-hash';
import type { Cutoff } from './cutoff';
import { readHitCap } from './hit-budget';
import { isKaelTempLegendary } from './kael-temp';
import { equipmentFromLoggedGear, socketedItemsFromLoggedGear } from './logged-gear';
import { type GemRecolor, inactiveMeta, MetaRepairError, REPAIR_SEARCH_WORK_LIMIT, repairMetaGems, type SocketedItem } from './meta-repair';
import { filterPoolByPhase, mainHandLeavesOffHandFree, offHandBlockedEntries, oneHandBlockedEntries, type PoolEntry } from './pool';
import { type Deps, type Progress, RankError, type RankInput, type ResolvedFight } from './rank-types';
import { assertUsableSeeds, DEFAULT_SEED_COUNT, DegenerateSeedsError, replicateSeeds } from './se';
import type { FightSummary, LoggedGear } from './seams/gear-source';
import type { RaidSimRequest, SimRunOpts, SpellDamageBySchool } from './seams/sim-runner';
import { errorText } from './set-less-copies';
import { StopRefusedSim } from './sim-calls';
import { SIM_ORDER, type SimItemSpec } from './slots';
import type { FightRef, Race, SpecId } from './types';

/**
 * Used when a caller passes no count; the tab always passes its own
 * (`TAB_DEFAULT_ITERATIONS`). Flat, not adaptive. The count is part of every
 * ranking cache key.
 */
export const DEFAULT_ITERATIONS = 5000;

/**
 * First of the default seeds, which are distinct because
 * `usesPairedReplication` (`se.ts`) needs more than one, and spaced by the
 * iteration count: the sim seeds iteration `i` from `RandomSeed + i`
 * (`reseedRands` in `sim/core/sim.go`), so seeds closer than the iteration
 * count share most of their random streams and their SE comes out far too
 * small.
 */
export const DEFAULT_SEED_BASE = 11;

/**
 * Derived from the run's resolved iteration count, not `DEFAULT_ITERATIONS`:
 * a caller passing `iterations: 10000` would otherwise get seeds 5,000 apart,
 * which overlap and fail `assertUsableSeeds`.
 */
export function defaultSeedsFor(iterations: number): number[] {
	return replicateSeeds(DEFAULT_SEED_BASE, DEFAULT_SEED_COUNT, iterations);
}

/**
 * Per-spec preset id, disclosed in `Assumptions.presetId`. A stable label, not
 * a file path: the skeleton is the page's own current settings.
 */
const PRESET_ID_BY_SPEC: Record<SpecId, string> = {
	ret: 'ret/current-page-settings',
	feral: 'feral/current-page-settings',
	balance: 'balance/current-page-settings',
	hunter: 'hunter/current-page-settings',
	mage: 'mage/current-page-settings',
	shadow: 'shadow/current-page-settings',
	rogue: 'rogue/current-page-settings',
	ele: 'ele/current-page-settings',
	enh: 'enh/current-page-settings',
	warlock: 'warlock/current-page-settings',
	warrior: 'warrior/current-page-settings',
};

export function presetIdFor(spec: SpecId): string {
	return PRESET_ID_BY_SPEC[spec];
}

export function resolveFight(fights: readonly FightSummary[], requested?: FightRef): ResolvedFight | undefined {
	if (requested) {
		const match = fights.find(f => f.reportCode === requested.reportCode && f.fightId === requested.fightId);
		return match
			? summaryToResolved(match)
			: {
					...requested,
					route: 'report-events',
				};
	}
	const ranked = fights.find(f => f.route === 'ranked');
	const chosen = ranked ?? fights[0];
	return chosen ? summaryToResolved(chosen) : undefined;
}

function summaryToResolved(f: FightSummary): ResolvedFight {
	return {
		reportCode: f.reportCode,
		fightId: f.fightId,
		...(f.encounterName ? { encounterName: f.encounterName } : {}),
		...(f.killedAt ? { killedAt: f.killedAt } : {}),
		route: f.route,
		confidence: f.confidence,
		...(f.salvationUptime === undefined ? {} : { salvationUptime: f.salvationUptime }),
	};
}

export function raceFromSkeleton(skeleton: RaidSimRequest): Race {
	const raw = (
		skeleton as {
			raid?: { parties?: Array<{ players?: Array<{ race?: string }> }> };
		}
	).raid?.parties?.[0]?.players?.[0]?.race;
	if (raw && isRace(raw)) return raw;
	return 'RaceHuman';
}

export function talentsStringFromRequest(request: RaidSimRequest): string | undefined {
	const raw = (
		request as {
			raid?: {
				parties?: Array<{ players?: Array<{ talentsString?: string }> }>;
			};
		}
	).raid?.parties?.[0]?.players?.[0]?.talentsString;
	return typeof raw === 'string' ? raw : undefined;
}

function isRace(value: string): value is Race {
	return (
		value === 'RaceHuman' ||
		value === 'RaceDwarf' ||
		value === 'RaceNightElf' ||
		value === 'RaceGnome' ||
		value === 'RaceDraenei' ||
		value === 'RaceOrc' ||
		value === 'RaceUndead' ||
		value === 'RaceTauren' ||
		value === 'RaceTroll' ||
		value === 'RaceBloodElf'
	);
}

/**
 * The run's inputs that no step changes once the cache check has passed.
 * Values that do change stay out: `gems` gains the hit budget after the
 * baseline's stats read, and the sim counts and the note arrays grow as the
 * run goes.
 */
export type RunContext = {
	readonly input: RankInput;
	/** The baseline and the candidate loop run through this. */
	readonly deps: Deps;
	/** The set phase and replication run through this: `deps` with the Stop guard on its sim. */
	readonly guardedDeps: Deps;
	readonly onProgress: ((p: Progress) => void) | undefined;
	readonly cutoff: Cutoff;
	readonly race: Race;
	/** A request for any gear, each with its own database. */
	readonly composeFor: (equipment: readonly SimItemSpec[]) => RaidSimRequest;
	readonly capProfile: CapProfile;
	/** Set when the gem repair values hit only up to the hit cap. */
	readonly hitPercentStat: number | undefined;
	readonly iterations: number;
	readonly seeds: number[];
	/** The first seed's sim options. */
	readonly runOpts: SimRunOpts;
	readonly simVersion: string;
	/** The worn gear after the worn meta repair. */
	readonly equipment: SimItemSpec[];
	/** The baseline request, `composeFor(equipment)`. */
	readonly request: RaidSimRequest;
};

/**
 * The run's iteration count, its seeds, and the options its first-seed sims
 * run with. Seeds that cannot give a usable SE fail the run.
 */
export function resolveSeeds(input: RankInput): { iterations: number; seeds: number[]; runOpts: SimRunOpts } {
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
	return { iterations, seeds, runOpts };
}

/**
 * The worn gear's gems after the meta repair, which recolors gems to switch
 * an inactive meta back on. With a hit cap, the repair values hit only up to
 * it, read from the un-repaired gear.
 */
export async function repairWornMeta({
	deps,
	logged,
	capProfile,
	hitPercentStat,
	composeFor,
	runOpts,
	gems,
}: {
	deps: Deps;
	logged: LoggedGear;
	capProfile: CapProfile;
	hitPercentStat: number | undefined;
	composeFor: (equipment: readonly SimItemSpec[]) => RaidSimRequest;
	runOpts: SimRunOpts;
	gems: GemContext;
}): Promise<{ socketed: SocketedItem[]; metaAdjusted: boolean; metaRecolors: GemRecolor[] }> {
	const preRepairSocketed = socketedItemsFromLoggedGear(logged);
	let socketed: SocketedItem[] = preRepairSocketed;
	let metaAdjusted = false;
	let metaRecolors: GemRecolor[] = [];
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
			wornHitBudget = (await readHitCap(deps, capProfile, preRequest, hitPercentStat, spellDamage)).budget;
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
	return { socketed, metaAdjusted, metaRecolors };
}

/**
 * The candidates a run may price, in EP order, with the facts about the
 * worn gear that the candidate loop reads and the two blocked lists the
 * notes count.
 */
export type EligibleCandidates = {
	equippedIds: Set<number>;
	mainHandIsOneHanded: boolean;
	blockedOffHand: PoolEntry[];
	blockedOneHand: PoolEntry[];
	ordered: PoolEntry[];
};

/** The pool narrowed to the candidates this run may price, ordered by EP. */
export function eligibleCandidates(input: RankInput, deps: Deps, equipment: readonly SimItemSpec[]): EligibleCandidates {
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
	return { equippedIds, mainHandIsOneHanded, blockedOffHand, blockedOneHand, ordered };
}

/**
 * The ranking cache key's content, as canonical JSON. Its fields, their
 * order and the frozen ones are part of every key already written.
 */
export function rankingContentHash({
	input,
	race,
	fight,
	logged,
	ordered,
	gems,
	deps,
	iterations,
	seeds,
	simVersion,
	hitPercentStat,
}: {
	input: RankInput;
	race: Race;
	fight: FightRef;
	logged: LoggedGear;
	ordered: readonly PoolEntry[];
	gems: GemContext;
	deps: Deps;
	iterations: number;
	seeds: readonly number[];
	simVersion: string;
	hitPercentStat: number | undefined;
}): string {
	return canonicalJson({
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
}
