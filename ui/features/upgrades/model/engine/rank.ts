/**
 * rankUpgrades: the engine's entry point, RankInput → Ranking.
 *
 * No spec-mismatch check: the gear source reads the page's gear under the
 * page's selected spec, so it always matches `input.spec`, and
 * `LoggedGear.className`/`specIdHint` go unused. The content hash is the
 * canonical-JSON string itself, not a digest, like `simCacheKey` in
 * seams/sim-runner.ts.
 */

import { HandType } from '@generated/proto/common';

import { fillEmptyCandidateGems, type FillEmptyOpts, type GemContext, gemContext, metaSocketUnpriced, missingMetaPreferenceNote } from './candidate-gems';
import { type ItemEp, orderCandidatesByEp } from './candidate-order';
import { capProfileFor, type HitCapBudget, hitCapBudgetFrom, perSpellHitTalentTaken, targetsAtCapLevel, usesSpellHitBudget } from './cap-profile';
import { gearHitRating } from './caps';
import { compose } from './compose';
import { canonicalJson, ENGINE_VERSION, type HashedGearItem } from './content-hash';
import { CUTOFF, type Cutoff, meetsCutoff } from './cutoff';
import { type Assumptions, buildStandingAssumptions, notesFromMetaRepair, type RunNote } from './disclosure';
import { enchantAppliesToItem } from './enchants';
import { findMetaGemId, type GemEntry, gemsForPhase, getGem } from './gems';
import { getItem } from './items';
import { isKaelTempLegendary } from './kael-temp';
import { equipmentFromLoggedGear, socketedItemsFromLoggedGear } from './logged-gear';
import { type GemRecolor, inactiveMeta, MetaRepairError, REPAIR_SEARCH_WORK_LIMIT, repairMetaGems, type SocketedItem } from './meta-repair';
import { migrateGemsToItem } from './migrate-gems';
import { choosePartners, estimateCombinedDelta, PARTNER_RULE, type PartnerAudit, type PartnerPiece, partnerPool, type PartnerRule } from './partner-choice';
import { type PlausibilityWarning, plausibilityWarnings } from './plausibility';
import {
	filterPoolByPhase,
	type ItemSource,
	mainHandLeavesOffHandFree,
	offHandBlockedEntries,
	oneHandBlockedEntries,
	type PoolEntry,
	type SimSlotName,
	simSlotsForPoolSlot,
} from './pool';
import { promisePool } from './promise-pool';
import {
	assertUsableSeeds,
	DEFAULT_SEED_COUNT,
	DegenerateSeedsError,
	isReplicable,
	PAIRED_REPLICATE_TOP_N,
	pairedReplicateSe,
	replicateSeeds,
	usesPairedReplication,
} from './se';
import type { FightSummary, GearSource } from './seams/gear-source';
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
import type { Store } from './seams/store';
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
import { recordSetScreen, runSetScreenOn, type SetScreen, type SetScreenInput, type SetScreenMode } from './set-screen';
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
	type UnmeasuredReason,
} from './set-value';
import { SIM_ORDER, type SimItemSpec } from './slots';
import type { CharacterRef, ContentPhase, DetectedSpecId, FightRef, Race, SpecId } from './types';
import { setCreditUnmeasured, setPotentialIncrements } from './view';

export type RankInput = {
	character: CharacterRef;
	spec: SpecId;
	maxPhase: ContentPhase;
	fight?: FightRef;
	race?: Race;
	iterations?: number;
	seeds?: number[];
	/**
	 * Keeps the first N candidates of the EP ordering that the player does not
	 * wear, plus every worn row. `undefined` means no cap, and hashes the
	 * same as a cap equal to the eligible set's size.
	 */
	candidateCap?: number;
};

export type Deps = {
	gear: GearSource;
	sim: SimRunner;
	store: Store;
	clock: () => Date;
	raidSimSkeleton: RaidSimRequest;
	epWeights: Readonly<Record<string, number>> | readonly number[];
	/**
	 * The candidate order's item score per sim slot. The tab passes wowsims'
	 * own weapon-aware score (`model/item_ep.ts`). Required, with no default:
	 * stats times `epWeights` gives a weapon no credit for its weapon damage.
	 */
	itemEp: ItemEp;
	phaseGems?: readonly GemEntry[];
	pool?: readonly PoolEntry[];
	/**
	 * Per-request item rows for the sim's database: plain data, no I/O. The
	 * browser's WASM sim is built without `with_db` and a candidate is never
	 * worn, so the skeleton's database never describes it. CLI callers omit it
	 * (`wowsimcli` is built `with_db`), and requests keep the skeleton's database.
	 */
	simDatabaseFor?: (equipment: readonly SimItemSpec[]) => Readonly<Record<string, unknown>> | undefined;
	/**
	 * How many candidate sims may be in flight at once. It changes how fast a
	 * run goes, never what it returns, so it stays out of the content hash.
	 * Defaults to 1 (serial).
	 */
	concurrency?: number;
	/**
	 * Sims every worn set's bonuses on the player's gear and each bonus a row
	 * could reach, and counts a loss only above noise. The tab passes it.
	 * Absent, none of those sims run.
	 */
	measureSetBonuses?: boolean;
	/**
	 * The rule that picks the other set pieces a set row is simmed with
	 * (`partner-choice.ts`). Absent means `PARTNER_RULE`. The tab never sets
	 * it; tests set it to score the rules against each other. Hashed only when
	 * set, so a ranking cached under one rule is never served for another.
	 */
	partnerRule?: PartnerRule;
	/**
	 * The set screen (`set-screen.ts`), run only with `measureSetBonuses`.
	 * "on" values the bonuses rows could reach only for the sets the screen
	 * keeps; the tab passes it. "record" runs the screen's sims and filters
	 * nothing; the tab never sets it, only tests do. Both write
	 * `Ranking.setScreen`. Absent means "off". Hashed only when set.
	 */
	setScreenMode?: SetScreenMode;
	/**
	 * Stop signal. On abort, in-flight per-candidate sims finish, no further
	 * sim is sent, and the run returns a `PartialRanking` (`complete: false`).
	 * A Stop during the set phase or paired replication returns the same
	 * `PartialRanking` as a Stop during the last candidate sim.
	 */
	signal?: AbortSignal;
};

export type Progress =
	| { stage: 'resolving' }
	| { stage: 'reading-gear' }
	| { stage: 'composing' }
	| { stage: 'building-pool' }
	/**
	 * `total` counts sims (baseline, candidates, paired replicas). The first
	 * total is an upper bound: it counts replicas for up to `PAIRED_REPLICATE_TOP_N`
	 * rows before the run knows how many rows clear the cutoff. The first
	 * `simming` after `ranking` repeats `done` with the exact total, and the run
	 * ends on `done === total`.
	 */
	| { stage: 'simming'; done: number; total: number }
	/**
	 * One candidate's row finished, fired as each sim finishes so a caller can
	 * fill rows before the "ranking" stage. No `stage` field, because it is
	 * sent alongside the "simming" stage, not in place of it.
	 */
	| { kind: 'row'; row: RankedItem }
	| { stage: 'ranking' };

export type RankErrorKind =
	| 'character-not-found'
	| 'no-qualifying-fight'
	| 'gear-unreadable'
	| 'meta-unsolvable'
	| 'sim-failed'
	| 'wcl-budget-exhausted'
	| 'not-implemented'
	| 'internal';

export class RankError extends Error {
	readonly kind: RankErrorKind;

	constructor(kind: RankErrorKind, message: string) {
		super(message);
		this.name = 'RankError';
		this.kind = kind;
	}
}

export type RankedItem = {
	rank: number | null;
	itemId: number;
	name: string;
	slot: PoolEntry['slot'];
	slotChoice?: SimSlotName;
	source: ItemSource;
	sources?: ItemSource[];
	deltaDps: number;
	deltaPct: number;
	se: number;
	seMethod: 'independent' | 'paired-replicate';
	bisTags: Array<'BiS' | 'Alt' | 'Realistic'>;
	curatedSets?: string[];
	bisSets?: string[];
	setBonusNote?: string;
	/** Gems the run put in place of the worn ones. */
	gemSubstitutions?: Array<{
		itemId: number;
		socketIndex: number;
		from: number;
		to: number;
	}>;
	removedItems?: Array<{ itemId: number; slot: SimSlotName }>;
	emptyMetaSocket?: boolean;
	/** The player wears this item now. The stored name says "owned". */
	owned?: boolean;
	/**
	 * `false` only on a row Stop left unsimmed; absent otherwise, never
	 * `true`. Such a row's `deltaDps`/`se`/etc. are placeholders, excluded from
	 * cutoff classification and tie groups.
	 */
	simmed?: false;
	belowCutoff: boolean;
	setContext?: SetContext;
};

/**
 * What one set piece's row does to set bonuses. `singleBreaks`, the worn
 * bonuses this swap loses, are already in `deltaDps`. `futureBonuses`, the
 * bonuses more pieces would reach, are what the view adds with set potential
 * on. A lost bonus's `dps` is its measured value; absent means unmeasured,
 * and the row then shows the bonus with no value added.
 *
 * A future bonus's `breaks` and `pieces` come from the pieces this row needs
 * to reach it (`pathToThreshold`): the worn bonuses they lose beyond the
 * row's own, and the other pieces with their own gains, since reaching the
 * bonus means wearing them. `pieces` is present exactly when there is such a
 * path. Only these losses are charged: a Malorne chest row must not pay for
 * the Thunderheart 2pc that only the Malorne 4pc's hands piece breaks. With
 * `usesBonusGear`, `measureBonusGear` replaces both for each bonus above noise.
 * `commitBreaks` (losses of `topMeasuredBonus`) are shown, never charged.
 */
export type SetContext = {
	setId: number;
	setName: string;
	piecesWornBefore: number;
	piecesAfterSwap: number;
	nextThreshold: SetThreshold | null;
	crossesThreshold: boolean;
	/**
	 * Set on every row of a ranking made with `measureSetBonuses`, which values
	 * each future bonus by one sim of the row plus its partner pieces
	 * (`bonusGearDps`). It says how the ranking was made, not that every such
	 * sim succeeded: a bonus can still be unmeasured or within the noise. View
	 * helpers that see only this context read it to use that sim instead of
	 * summing `pieces`.
	 */
	usesBonusGear?: true;
	/**
	 * The row's own swap gain, taken before paired replication rewrites
	 * `deltaDps`. A future bonus's value is its `bonusGearDps` minus this.
	 * The stored name says "single"; code calls this the own delta.
	 */
	singleDeltaDps?: number;
	/** The worn bonuses the row's own swap loses. The stored name says "single"; code calls these the own breaks. */
	singleBreaks?: Array<{
		setId: number;
		setName: string;
		threshold: SetThreshold;
		dps?: number;
	}>;
	futureBonuses?: Array<{
		threshold: SetThreshold;
		piecesNeeded: number;
		dps?: number;
		/** The entry's `sameGearDps` and `sameGearSe`, copied. */
		sameGearDps?: number;
		sameGearSe?: number;
		/** Not above noise on its own gear, so no other sim ran for it. */
		belowNoise?: true;
		/**
		 * The bonus gear is the current gear plus this row plus its partner pieces:
		 * the gear that reaches this bonus. These are its sim minus the sim of the
		 * current gear, and that difference's standard error.
		 * Present only with `usesBonusGear`, for a bonus above noise, when the
		 * partner choice and the sim succeeded.
		 */
		bonusGearDps?: number;
		bonusGearSe?: number;
		/**
		 * The sim of the gear before this bonus with the worn bonuses it newly
		 * loses turned off (their pieces sent as set-less copies), minus the
		 * current gear's sim; its standard error; and the bonuses turned off. The
		 * popover uses it to show those losses on their own line. Present only
		 * with `usesBonusGear`, for a shown bonus that newly loses a worn bonus,
		 * when that gear without copies was in the store and the sim succeeded.
		 */
		bonusOffDps?: number;
		bonusOffSe?: number;
		bonusOff?: Array<{ setId: number; threshold: SetThreshold }>;
		/** The partner choice needed a worn bonus whose value is unmeasured. */
		partnerUnmeasured?: 'break-unmeasured';
		/** The rule that chose `pieces`, with `usesBonusGear`. */
		partnerRule?: PartnerRule;
		breaks?: Array<{
			setId: number;
			setName: string;
			threshold: SetThreshold;
			dps?: number;
		}>;
		pieces?: Array<{ itemId: number; name: string; dps?: number }>;
	}>;
	/** The worn bonuses the top bonus's added pieces break, beyond the row's own. */
	commitBreaks?: Array<{
		setId: number;
		setName: string;
		threshold: SetThreshold;
		dps?: number;
	}>;
	/** The top bonus's added pieces' sim gain, shown only. Stored name: "package" means a bonus's added pieces. */
	commitPackageDeltaDps?: number;
	/** The set's measured bonuses, when this item is among their added pieces. Stored name: "package" means a bonus's added pieces. */
	packages?: AddedPiecesContext[];
};

export type AddedPiecesContext = {
	threshold: SetThreshold;
	deltaDps: number;
	itemIds: number[];
	piecesNeeded: number;
};

/**
 * The measured value of one worn set bonus a swap can lose: that count's
 * `wornSetLadder` entry, for a count above noise or not measured. `dps` is
 * absent with `unmeasured` when a sim failed. Only `sim-failed` is produced;
 * the other members keep saved rankings readable.
 */
export type BrokenSetValue = {
	setId: number;
	setName: string;
	threshold: SetThreshold;
	dps?: number;
	se?: number;
	unmeasured?: 'no-neutral-candidates' | 'sim-failed' | 'repair-failed' | 'dependent-unmeasured';
};

/**
 * The value of one piece count of one worn set on the player's own gear
 * (`measureWornSetCounts`), and whether it is `counted` as a bonus a swap can
 * lose: a value above noise, or a failed sim at a count that may hold a
 * bonus (`measureWornSets`). Counts with no bonus read about 0.
 */
export type WornSetCountEntry = {
	setId: number;
	setName: string;
	count: number;
	dps?: number;
	se?: number;
	unmeasured?: 'sim-failed';
	counted: boolean;
};

/** Whether one more piece of a worn set reaches a bonus: the bonus at that count, measured on one candidate's own swap, and whether it clears the noise check. */
export type CrossingCheck = {
	setId: number;
	/** One more than the worn count: the count a one-item swap reaches. */
	count: number;
	/** The candidate whose swap the bonus was measured on. */
	itemId: number;
	dps?: number;
	se?: number;
	cleared: boolean;
};

export type BonusGearSims = {
	partnerRule: PartnerRule;
	/** Distinct gears simmed, across every row and future bonus. */
	gears: number;
	simmed: number;
	fromStore: number;
};

/**
 * The bonus-off sims (see `bonusOffDps`), one per distinct request. `gears`
 * counts the requests and `failedGears` those whose sim failed.
 * `beforeInStore` counts requests whose gear before, without copies, was in
 * the store; the rest are never simmed, since their loss would not be a
 * paired difference. `skippedIncrements` counts shown bonuses that newly lose a
 * worn bonus but got no value: no request could be built, or that gear was
 * not in the store.
 */
export type SetBonusOffSims = {
	gears: number;
	simmed: number;
	fromStore: number;
	failedGears: number;
	skippedIncrements: number;
	beforeInStore: number;
};

export type PartnerAuditEntry = {
	itemId: number;
	setId: number;
	threshold: number;
	audit: PartnerAudit;
};

export type SetBonusValue = {
	setId: number;
	setName: string;
	threshold: SetThreshold;
	piecesWorn: number;
	/** Stored name: "package" means this bonus's added pieces. */
	packageItemIds: number[];
	/** Stored name: "package" means this bonus's added pieces. */
	packageDeltaDps: number;
	/**
	 * The bonus's value before correcting for lost worn bonuses: the added
	 * pieces' sim gain minus each piece's own swap gain, and minus the 2pc's
	 * value for a 4pc. At worn 1 each piece's own gain includes the 2pc, so a
	 * 4pc adds it back once per piece after the first (`selfConfound`).
	 */
	bonusDps?: number;
	/**
	 * `bonusDps` corrected for the worn bonuses the added pieces lose
	 * (`netInflation`), using their measured values; set potential and the sort
	 * use it. Absent when a needed value is unmeasured, or when a worn-1 4pc's
	 * `selfConfound` has no `dps` (no usable pair, or its sim or gem repair
	 * failed). Absent, the row shows the bonus with no value added.
	 */
	bonusDpsNet?: number;
	se?: number;
	/**
	 * The bonus measured on its added pieces' own gear (`measureSameGearBonus`):
	 * that gear simmed with the bonus on and off, by sending enough pieces as
	 * copies to leave `threshold − 1`. It decides whether the bonus is above
	 * noise. Present only with `deps.measureSetBonuses`; absent when a sim
	 * failed. `sameGearSe` is the two sims' combined standard error.
	 */
	sameGearDps?: number;
	sameGearSe?: number;
	/**
	 * `sameGearDps` is not above noise, so this count is no bonus here and no
	 * other sim ran for it: `packageDeltaDps` is 0 and `bonusDps` is absent.
	 */
	belowNoise?: true;
	unmeasured?: UnmeasuredReason;
	breaks?: BrokenSetBonus[];
	selfConfound?: SelfSetConfound;
	gemSubstitutions?: Array<{
		itemId: number;
		itemIndex: number;
		socketIndex: number;
		from: number;
		to: number;
	}>;
};

export type ResolvedFight = {
	reportCode: string;
	fightId: number;
	encounterName?: string;
	killedAt?: string;
	route: FightSummary['route'];
	confidence?: number;
	salvationUptime?: number;
};

export type Ranking = {
	/** The run's inputs as canonical JSON (not a digest); the ranking's cache key. */
	contentHash: string;
	cutoff: Cutoff;
	fight: ResolvedFight;
	baseline: { dps: number; stdev: number; metaAdjusted: boolean };
	assumptions: Assumptions;
	/** The run's notes (RunNote); the stored name says "substitutions". */
	substitutions: RunNote[];
	items: RankedItem[];
	setBonuses?: SetBonusValue[];
	/**
	 * The measured value of each worn set bonus a swap can lose: one per
	 * `counted` entry of `wornSetLadder`. Present only with
	 * `deps.measureSetBonuses`.
	 */
	brokenSetValues?: BrokenSetValue[];
	/**
	 * The value of every piece count from 2 to the worn count of every worn
	 * set, counted or not. Present only with `deps.measureSetBonuses` and a
	 * set worn at 2+. Stored name: "ladder" is the list of counts.
	 */
	wornSetLadder?: WornSetCountEntry[];
	/**
	 * One check per worn set with a pool piece in a slot the set does not fill:
	 * the bonus at one piece more than worn, measured on that set's best such
	 * candidate's own swap. A row reaches a bonus only when its count's check
	 * `cleared`. Present only with `measureSetBonuses`.
	 */
	crossingChecks?: CrossingCheck[];
	/**
	 * The sims of each set row plus its partner pieces: the partner rule, the
	 * number of distinct gears, and how many sims ran or came from the store.
	 * Its presence marks a ranking whose set rows are valued by those sims.
	 */
	bonusGearSims?: BonusGearSims;
	/**
	 * The bonus-off sims that put a shown bonus's worn-bonus losses on their
	 * own popover line. Present whenever `bonusGearSims` is.
	 */
	setBonusOffSims?: SetBonusOffSims;
	/**
	 * Every partner combination simmed for every future bonus above noise, written only
	 * under the "every-combination" rule, which tests set to score the rules
	 * that choose without a sim. Players never get it.
	 */
	partnerAudit?: PartnerAuditEntry[];
	/**
	 * The set screen's readings, written only when `deps.setScreenMode` is "record"
	 * or "on"; in "on" mode it also holds each set's verdict and reason. Only
	 * the set-bonus popover reads it, to say why a set was not measured; the
	 * set-bonus sims filter on the screen's own result, and record mode's
	 * readings are scored offline.
	 */
	setScreen?: SetScreen;
	plausibilityWarnings?: PlausibilityWarning[];
	/**
	 * `true` unless Stop cut this run short. The literal type keeps a
	 * `PartialRanking` out of `applyView`, but not out of the ranking cache
	 * (`Store.put<T>` is generic): only the `if (aborted)` branch that returns
	 * `partial` before the write does that.
	 */
	complete: true;
};

/**
 * What `rankUpgrades` returns when `Deps.signal` aborts mid-run. Rows Stop
 * never reached carry `simmed: false` and are excluded from `rank`/cutoff
 * classification and tie groups. Per-sim cache rows for the sims that
 * finished are still written, so a re-run resumes cheaply; the partial
 * ranking itself is never cached.
 */
export type PartialRanking = Omit<Ranking, 'complete'> & { complete: false };

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

/**
 * Used when a caller passes no count; the tab always passes its own
 * (`TAB_DEFAULT_ITERATIONS`). Flat, not adaptive. The count is part of every
 * ranking cache key.
 */
const DEFAULT_ITERATIONS = 5000;
/**
 * First of the default seeds, which are distinct because
 * `usesPairedReplication` (`se.ts`) needs more than one, and spaced by the
 * iteration count: the sim seeds iteration `i` from `RandomSeed + i`
 * (`reseedRands` in `sim/core/sim.go`), so seeds closer than the iteration
 * count share most of their random streams and their SE comes out far too
 * small.
 */
const DEFAULT_SEED_BASE = 11;

/**
 * Derived from the run's resolved iteration count, not `DEFAULT_ITERATIONS`:
 * a caller passing `iterations: 10000` would otherwise get seeds 5,000 apart,
 * which overlap and fail `assertUsableSeeds`.
 */
function defaultSeedsFor(iterations: number): number[] {
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

function presetIdFor(spec: SpecId): string {
	return PRESET_ID_BY_SPEC[spec];
}

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
		// Only when set, so a run without it keeps every key already written; a
		// run with it is never served a ranking another rule made.
		...(deps.partnerRule !== undefined ? { partnerRule: deps.partnerRule } : {}),
		// The same rule for the screen: a ranking without its readings is never
		// served to a run that asked for them.
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
			...(bonusGearResult?.partnerAudit ? { partnerAudit: bonusGearResult.partnerAudit } : {}),
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
	// reachable bonuses. Both modes get the same sets, added pieces and sim
	// options, so an "on" pair is the request "record" sims at that iteration
	// count.
	const screenMode = measureSetBonuses ? deps.setScreenMode : undefined;
	const screenInput: SetScreenInput | undefined =
		screenMode === 'record' || screenMode === 'on'
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
	// the row does not matter. But each own delta of a set worn at w reached
	// w + 1 pieces alone, so when there is a bonus at w + 1 every own delta
	// holds it once. The pair already counts it, and sets worn at another count
	// carry no such extra, so the crossing check's value is taken out once per
	// added piece (ticket 886). An unmeasured crossing leaves the estimate
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
				setId,
				threshold,
				needed: rest.length,
				pool: [],
				brokenBy: swaps => brokenSetBonuses(equipment, swaps, setId, countsAsBreak),
				breakDps: (s, c) => screenBrokenBonusDpsByKey.get(`${s}:${c}`),
			},
			rest,
			{ includeCombinationOnlyBreaks: true },
		);
		return estimate === undefined ? undefined : estimate - pieces.length * crossedPerPiece;
	};
	const setScreen: SetScreen | undefined = !screenInput
		? undefined
		: screenMode === 'record'
			? await recordSetScreen(screenInput)
			: await runSetScreenOn({ ...screenInput, estimatedDeltaAt, baselineStdev });
	const screenedOut = new Set(setScreen?.mode === 'on' ? setScreen.sets.filter(s => !s.kept).map(s => s.setId) : []);

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
				console.warn(`[upgrades] ${label} ${threshold}pc bonus package not measured: gem repair failed`, err);
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
						console.warn(`[upgrades] ${label} ${threshold}pc bonus package not measured: the sim failed`, err);
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
	partnerAudit?: PartnerAuditEntry[];
}> {
	const { deps, equipment, gems, composeFor, countsAsBreak, baseline, runOpts } = args;
	const rule = deps.partnerRule ?? PARTNER_RULE;
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
	const audits: PartnerAuditEntry[] = [];
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
			const entry = args.setBonuses.find(b => b.setId === setId && b.threshold === f.threshold);
			const pathSlot = args.firstSlotIndexByItemId.get(item.itemId);
			const pathPieces =
				entry && entry.packageItemIds.length > 0 && pathSlot !== undefined
					? pathToThreshold(item.itemId, pathSlot, entry, args.firstSlotIndexByItemId, args.ownDeltasByItemId).filter(p => p.itemId !== item.itemId)
					: undefined;
			// A partner combination whose sim fails is skipped, and the chosen
			// combination's gear is simmed below, so a failure counts for the row
			// only when no combination is chosen.
			let partnerSimFailure: SkipReason | undefined;
			const choice = await choosePartners(
				{
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
					...(pathPieces ? { pathPieces } : {}),
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
				},
				rule,
			);
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
			if (choice.audit) {
				audits.push({
					itemId: item.itemId,
					setId,
					threshold: f.threshold,
					audit: choice.audit,
				});
			}
			const slotOf = new Map<number, number>();
			for (const p of [...pool, ...(pathPieces ?? [])]) {
				slotOf.set(p.itemId, p.slotIndex);
			}
			const partners: PlacedItem[] = choice.itemIds.map(itemId => ({ itemId, slotIndex: slotOf.get(itemId)! })).sort((a, b) => a.slotIndex - b.slotIndex);
			partnersOf.set(f, partners);
			f.partnerRule = rule;
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
			partnerRule: rule,
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
		...(rule === 'every-combination' ? { partnerAudit: audits } : {}),
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

/** Namespaced so a ranking cannot collide with another stored value. */
function rankingCacheKey(contentHash: string): string {
	return `ranking:${contentHash}`;
}

async function readCachedSim(deps: Deps, req: RaidSimRequest, simVersion: string, opts: SimRunOpts): Promise<SimObservation | undefined> {
	return asInternal(() => deps.store.get<SimObservation>(simStoreKey(req, simVersion, opts)));
}

function simStoreKey(req: RaidSimRequest, simVersion: string, opts: SimRunOpts): string {
	return `sim:${simCacheKey(req, simVersion, opts)}`;
}

async function cacheSimResult(deps: Deps, req: RaidSimRequest, simVersion: string, opts: SimRunOpts, observation: SimObservation): Promise<void> {
	await asInternal(() => deps.store.put(simStoreKey(req, simVersion, opts), observation));
}

/**
 * A store-cached sim at explicit options, for sims whose seed, iteration count
 * or `saveAllValues` differ from the run's own (the set screen). The store key
 * holds every option (`simCacheKey`), so it never answers one question with
 * another's reading. Throws when the sim fails.
 */
async function runSimAt(deps: Deps, req: RaidSimRequest, simVersion: string, opts: SimRunOpts): Promise<{ observation: SimObservation; fromStore: boolean }> {
	const cached = await readCachedSim(deps, req, simVersion, opts);
	if (cached) return { observation: cached, fromStore: true };
	const observation = await deps.sim.run(req, opts);
	await cacheSimResult(deps, req, simVersion, opts, observation);
	return { observation, fromStore: false };
}

/**
 * A sim the guard below refused to start because the caller's Stop fired. Its
 * own class, so callers can tell it from a sim failure, which fails the
 * ranking.
 */
class StopRefusedSim extends Error {
	override readonly name = 'StopRefusedSim';

	constructor() {
		super('sim not started: Stop was pressed');
	}
}

/**
 * A candidate's own stats read failed. Its own class, so `runCandidate` can
 * report only the read as that candidate's failed sim and still fail the run
 * on a code error around it.
 */
class CandidateHitReadFailed extends Error {
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
function hitPercentOf(observed: PlayerStatsObservation, pseudoStat: number): number {
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
async function hitPercentOrSimFailed(
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
 * One stats read, raced against Stop. The listener goes on before the read
 * starts, so an abort fired while the read is being sent is not missed. No
 * timeout: a read that gets no answer means its worker cannot answer sims
 * either, and least-busy routing sends that worker a sim once every healthy
 * worker is busy, so a timeout would only move the hang to a later sim.
 */
async function readStats(sim: Deps['sim'], req: RaidSimRequest, signal: AbortSignal | undefined): Promise<PlayerStatsObservation> {
	if (signal?.aborted) throw new StopRefusedSim();
	const started = performance.now();
	if (!signal) {
		const observed = await sim.computeStats(req);
		logStatsRead(started);
		return observed;
	}
	let onAbort: (() => void) | undefined;
	const stopped = new Promise<never>((_, reject) => {
		onAbort = () => reject(new StopRefusedSim());
		signal.addEventListener('abort', onAbort, { once: true });
	});
	try {
		const read = sim.computeStats(req);
		// After Stop wins the race nobody awaits the read, so its late failure
		// must not become an unhandled rejection.
		read.catch(() => {});
		const observed = await Promise.race([read, stopped]);
		logStatsRead(started);
		return observed;
	} finally {
		signal.removeEventListener('abort', onAbort!);
	}
}

/**
 * Pre-formatted, so a forwarded console line keeps the number. It times
 * reads on either sim transport.
 */
function logStatsRead(started: number): void {
	console.debug(`[upgrades] stats read ${Math.round(performance.now() - started)} ms`);
}

/**
 * `deps` whose sim refuses to start once `deps.signal` has aborted, for the
 * set phase and replication. The candidate loop keeps the plain runner: it
 * turns a failed sim into a dropped row and has its own Stop check.
 */
function stopGuardedDeps(deps: Deps): Deps {
	const { signal, sim } = deps;
	if (!signal) return deps;
	return {
		...deps,
		sim: {
			version: () => sim.version(),
			run: async (req, opts) => {
				if (signal.aborted) throw new StopRefusedSim();
				return sim.run(req, opts);
			},
			computeStats: async req => {
				if (signal.aborted) throw new StopRefusedSim();
				return sim.computeStats(req);
			},
			...(sim.activeSetBonuses
				? {
						activeSetBonuses: async (req: RaidSimRequest) => {
							if (signal.aborted) throw new StopRefusedSim();
							return sim.activeSetBonuses!(req);
						},
					}
				: {}),
		},
	};
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
			console.warn(`[upgrades] set ${setId}: its bonus counts were not read, the package's gem repair failed`, err);
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

async function asInternal<T>(op: () => Promise<T>): Promise<T> {
	try {
		return await op();
	} catch (err) {
		throw new RankError('internal', err instanceof Error ? err.message : String(err));
	}
}

function raceFromSkeleton(skeleton: RaidSimRequest): Race {
	const raw = (
		skeleton as {
			raid?: { parties?: Array<{ players?: Array<{ race?: string }> }> };
		}
	).raid?.parties?.[0]?.players?.[0]?.race;
	if (raw && isRace(raw)) return raw;
	return 'RaceHuman';
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

export function equipmentForCandidateSwap(equipment: readonly SimItemSpec[], slotIndex: number, itemId: number, gems: GemContext): SimItemSpec[] {
	return candidateSwapWithRepairs(equipment, slotIndex, itemId, gems).equipment;
}

/**
 * The first half of `candidateSwapWithRepairs`: the gear after the swap and
 * its gem fill, before any meta repair. Exported so a test can read each
 * repair's input.
 */
export function candidateSwapPreRepair(
	equipment: readonly SimItemSpec[],
	slotIndex: number,
	itemId: number,
	gems: GemContext,
): {
	swapped: SimItemSpec[];
	socketed: SocketedItem[];
	removed: readonly { slotIndex: number; itemId: number }[];
} {
	// Cleared before the swap: `swapItemAt` computes `fillOptsForSwap` from the
	// array it is handed, so clearing afterwards would leave a unique gem on the
	// removed off-hand item in `usedUnique`, blocking the candidate's socket.
	const { equipment: cleared, removed } = clearOffHandForTwoHander(equipment, slotIndex, itemId);
	const swapped = swapItemAt(cleared, slotIndex, itemId, gems);
	const socketed: SocketedItem[] = swapped.map(spec => ({
		itemId: spec.id ?? 0,
		gems: [...spec.gems],
	}));
	return { swapped, socketed, removed };
}

export function candidateSwapWithRepairs(
	equipment: readonly SimItemSpec[],
	slotIndex: number,
	itemId: number,
	gems: GemContext,
): {
	equipment: SimItemSpec[];
	recolors: readonly GemRecolor[];
	repaired: boolean;
	removed: readonly { slotIndex: number; itemId: number }[];
} {
	const { swapped, socketed, removed } = candidateSwapPreRepair(equipment, slotIndex, itemId, gems);
	const hitBudget = gems.repairHitBudget;
	const minimized = repairMetaGems({
		items: socketed,
		epWeights: gems.weights,
		allowedGems: gems.fillGems,
		...(hitBudget
			? {
					hitBudget: {
						stat: hitBudget.stat,
						remaining: hitBudget.baselineRemaining - (gearHitRating(swapped, hitBudget.stat) - hitBudget.baselineGearHit),
						...(hitBudget.groups ? { groups: hitBudget.groups } : {}),
					},
				}
			: {}),
	});
	return {
		equipment: applyRepairedGems(swapped, minimized.items),
		recolors: minimized.recolors.filter(s => s.itemIndex !== slotIndex),
		// The swapped slot included, which `swaps` filters out.
		repaired: minimized.recolors.length > 0,
		removed,
	};
}

/**
 * The gear from one fixed series of `candidateSwapWithRepairs` calls, as
 * built: the set phase's added-pieces, partner and pair gears. `repaired` is
 * whether any call changed a socket; `swaps` is every call's repair swaps in
 * call order.
 */
type ChainBuild = {
	equipment: SimItemSpec[];
	repaired: boolean;
	recolors: GemRecolor[];
};

/** `{}` sends no copies. */
type CopyLayout = {
	setKept?: readonly number[];
	setLess?: readonly number[];
};

type LayoutRequest = {
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

type LayoutResult = LayoutRequest | BuildFailure | RepairFailure;

const isRepairFailure = (entry: LayoutResult | undefined): entry is RepairFailure => entry !== undefined && 'repairError' in entry;

/** The first failed repair, or every entry when none failed. */
const repairErrorOr = (entries: readonly LayoutResult[]): MetaRepairError | Array<LayoutRequest | BuildFailure> =>
	entries.find(isRepairFailure)?.repairError ?? entries.filter((entry): entry is LayoutRequest | BuildFailure => !isRepairFailure(entry));

/**
 * The requests for one set-phase gear, one per copy layout, each with gems
 * repaired on its own hit budget; both sims of a pair come from one call
 * (`rankUpgrades` defines it). `base` is the gear on the run's budget;
 * `rebuild` builds the same gear on another. An entry is a `BuildFailure`
 * when its request cannot be composed, and a `RepairFailure` when its rebuild
 * fails gem repair, unless Stop ends a later read in the same call.
 */
type RequestsPerCopyLayout = (rebuild: (gems: GemContext) => ChainBuild, base: ChainBuild, copiesList: readonly CopyLayout[]) => Promise<LayoutResult[]>;

const requestOf = (entry: LayoutRequest | BuildFailure): RaidSimRequest | BuildFailure => (isBuildFailure(entry) ? entry : entry.request);

/**
 * Missed hit below this many rating keeps a request on the run's budget. On
 * the measured gear, gem, item and enchant hit cancel inside `missed`, so
 * what is left is set-bonus hit, a whole number of rating (20 on Burning
 * Rage's 2pc); the tolerance only absorbs the percent round trip.
 */
const MISSED_HIT_TOLERANCE = 0.5;

function chainSwapsWithRepairs(equipment: readonly SimItemSpec[], pieces: readonly { slotIndex: number; itemId: number }[], gems: GemContext): ChainBuild {
	let gear: SimItemSpec[] = [...equipment];
	let repaired = false;
	const recolors: GemRecolor[] = [];
	for (const piece of pieces) {
		const outcome = candidateSwapWithRepairs(gear, piece.slotIndex, piece.itemId, gems);
		gear = outcome.equipment;
		repaired ||= outcome.repaired;
		recolors.push(...outcome.recolors);
	}
	return { equipment: gear, repaired, recolors };
}

/**
 * Takes the worn off-hand item off when a two-handed candidate goes in the
 * main hand, and names what it took. A two-hander beside an off-hand item is
 * gear the game cannot equip, so the row's sim runs without it and the row
 * discloses it in `RankedItem.removedItems`. The reverse case, a one-hander
 * offered beside a worn two-hander, is rejected in `attemptEligibility`,
 * because displacing the two-hander would be a hidden cost; here the build is
 * legal and the cost is stated. Every other case returns the input untouched.
 */
function clearOffHandForTwoHander(
	equipment: readonly SimItemSpec[],
	slotIndex: number,
	itemId: number,
): {
	equipment: readonly SimItemSpec[];
	removed: readonly { slotIndex: number; itemId: number }[];
} {
	if (slotIndex !== SIM_ORDER.indexOf('mainhand')) {
		return { equipment, removed: [] };
	}
	if (getItem(itemId)?.handType !== HandType.HandTypeTwoHand) {
		return { equipment, removed: [] };
	}
	const offHandIndex = SIM_ORDER.indexOf('offhand');
	const wornOffHandId = equipment[offHandIndex]?.id;
	if (!wornOffHandId) return { equipment, removed: [] };

	const cleared = equipment.map((spec, i) =>
		// The bare-slot value `equipmentFromLoggedGear` writes for an empty slot,
		// so a cleared off hand looks like one the player never filled.
		i === offHandIndex ? { gems: [] } : spec,
	);
	return {
		equipment: cleared,
		removed: [{ slotIndex: offHandIndex, itemId: wornOffHandId }],
	};
}

function swapItemAt(equipment: readonly SimItemSpec[], slotIndex: number, itemId: number, gemCtx: GemContext): SimItemSpec[] {
	return equipment.map((spec, i) => {
		if (i !== slotIndex) return spec;
		const sameItem = spec.id === itemId;
		const gems = sameItem
			? [...(spec.gems ?? [])]
			: fillEmptyCandidateGems(
					itemId,
					migrateGemsToItem(spec.gems ?? [], spec.id ?? 0, itemId),
					gemCtx.fillGems,
					gemCtx.weightRecord,
					fillOptsForSwap(equipment, slotIndex, gemCtx.spec),
				);
		const out: SimItemSpec = { id: itemId, gems };
		if (spec.enchant && enchantAppliesToItem(spec.enchant, itemId)) {
			out.enchant = spec.enchant;
		}
		return out;
	});
}

export function metaPreferenceNotes(spec: DetectedSpecId | undefined): RunNote[] {
	const note = missingMetaPreferenceNote(spec);
	return note ? [{ field: 'Meta gem for your spec', detail: note }] : [];
}

/**
 * One line for every one-handed weapon the worn two-hander kept out of the
 * run (`oneHandBlockedEntries`).
 */
export function oneHandBlockedNotes(count: number): RunNote[] {
	if (count === 0) return [];
	return [
		{
			field: 'One-handed weapons',
			detail:
				count === 1
					? '1 one-handed weapon was not ranked, because you wear a two-handed weapon.'
					: `${count} one-handed weapons were not ranked, because you wear a two-handed weapon.`,
		},
	];
}

/** One line for every off-hand item the worn two-hander kept out of the run. */
export function offHandBlockedNotes(count: number): RunNote[] {
	if (count === 0) return [];
	return [
		{
			field: 'Off-hand items',
			detail:
				count === 1
					? '1 off-hand item was not ranked, because you wear a two-handed weapon.'
					: `${count} off-hand items were not ranked, because you wear a two-handed weapon.`,
		},
	];
}

/** One item in one slot that the run could not price. */
export type CandidateSkip = {
	kind: 'sim' | 'repair';
	itemId: number;
	name: string;
	slot: SimSlotName;
	reason: string;
};

/**
 * A ring, trinket or one-hander is tried once per slot, so a failed try says
 * only "this slot" and carries the slot as data for the page to name: the
 * same item can still rank from its other slot.
 */
export function candidateSkipNote(skip: CandidateSkip): RunNote {
	// After the sentence, so for the console only: the page shows a line's
	// first line, and names the item and slot.
	const where = `item ${skip.itemId}, slot ${skip.slot}`;
	const line = { field: skip.name, slot: skip.slot };
	return skip.kind === 'sim'
		? {
				...line,
				detail: `This item was not ranked in this slot, because its sim failed.\n${where}`,
				error: skip.reason,
			}
		: {
				...line,
				// A gem repair that finds no recolor is no failed call (`metaOff`).
				detail: `This item was not ranked in this slot, because no gem swap could turn your meta gem on with it equipped.\n${where}: ${skip.reason}`,
			};
}

/**
 * Why a set bonus or a set was not measured: the end of the tab's sentence
 * and, when a call failed, its own error.
 */
export type SkipReason = { because: string; error?: string };

export const SET_BONUS_SKIP_REASONS = {
	simFailed: (error: string): SkipReason => ({
		because: 'its sim failed.',
		error,
	}),
	/** For a skip `onSomeRows`: the sims of those rows' gear failed. */
	rowSimsFailed: (error: string): SkipReason => ({
		because: 'their sim failed.',
		error,
	}),
	/**
	 * A gem repair that finds no recolor is no failed call, so its message follows
	 * the sentence, for the console: `error` holds only a failed call's error,
	 * which the run's error toast shows.
	 */
	metaOff: (repairMessage: string): SkipReason => ({
		because: `no gem swap could turn your meta gem on.\n${repairMessage}`,
	}),
	measuringSimsNotBuilt: {
		because: 'the sims that measure it could not be built.',
	} as SkipReason,
	notBuilt: (error: string): SkipReason => ({
		because: 'the sims that measure it could not be built.',
		error,
	}),
	/** For a skip `onSomeRows`: those rows' requests could not be built. */
	rowsNotBuilt: (error: string): SkipReason => ({
		because: 'their sims could not be built.',
		error,
	}),
	/** The request for the set's bonus list could not be built. */
	bonusListNotBuilt: (error: string): SkipReason => ({
		because: "the check that lists the set's bonuses could not be built.",
		error,
	}),
	/** The sim's list of a set's active bonuses failed. */
	bonusListFailed: (error: string): SkipReason => ({
		because: "the sim could not list the set's bonuses.",
		error,
	}),
} as const;

const withError = (line: { field: string; detail: string }, error: string | undefined): RunNote => (error === undefined ? line : { ...line, error });

/** One set bonus the set phase could not measure, for the run or `onSomeRows` only. */
export type SetBonusSkip = {
	setName: string;
	threshold: SetThreshold;
	reason: SkipReason;
	onSomeRows?: true;
};

export function setBonusSkipNote(skip: SetBonusSkip): RunNote {
	return withError(
		{
			field: `${skip.setName} ${skip.threshold}-piece set bonus`,
			detail: `The ${skip.setName} ${skip.threshold}-piece set bonus was not measured${skip.onSomeRows ? ' on some rows' : ''}, because ${skip.reason.because}`,
		},
		skip.reason.error,
	);
}

/**
 * A set whose bonus counts were not read. No count above the worn one is tried
 * for it, so its bonuses in reach get no figure; its worn bonuses are measured
 * separately, on the player's own gear (`wornSetLadder`).
 */
export function setBonusCountsSkipNote(skip: { setName: string; reason: SkipReason }): RunNote {
	return withError(
		{
			field: `${skip.setName} set`,
			detail: `The ${skip.setName} set bonuses were not all measured, because ${skip.reason.because}`,
		},
		skip.reason.error,
	);
}

/**
 * A shown bonus's bonus-off sim that failed or could not be built. The bonus
 * is still shown as one line; only its worn-bonus loss is not split out.
 */
export function breakSplitSkipNote(skip: {
	setName: string;
	threshold: SetThreshold;
	error: string;
	/** The bonus-off request could not be built, so no sim ran. */
	notBuilt?: true;
}): RunNote {
	return {
		field: `${skip.setName} ${skip.threshold}-piece set bonus`,
		detail: `On some rows, the cost of breaking the ${skip.setName} ${skip.threshold}-piece set bonus was not measured apart from the pieces that break it, because their sim ${skip.notBuilt ? 'could not be built' : 'failed'}.`,
		error: skip.error,
	};
}

/**
 * A set screen sim that failed. The screen only decides whether a set's
 * bonuses are measured at all, and a set it could not read is kept.
 */
export type SetScreenSkip = {
	setName: string;
	error: string;
	/** The check's request could not be built, so no sim ran. */
	notBuilt?: true;
};

export function setScreenSkipNote(skip: SetScreenSkip): RunNote {
	return {
		field: `${skip.setName} set`,
		detail: `The ${skip.setName} set was kept without the quick check that can skip it, because the check's sim ${skip.notBuilt ? 'could not be built' : 'failed'}.`,
		error: skip.error,
	};
}

/**
 * A worn-set value sim that failed. The line names the set and no count:
 * those sims do not know which counts hold a bonus, and a sim's piece count
 * (1 for the first) is not a count the player wears.
 */
export function wornSetSkipNote(skip: {
	setName: string;
	error: string;
	/** The sim's request could not be built, so no sim ran. */
	notBuilt?: true;
}): RunNote {
	return {
		field: `${skip.setName} set`,
		detail: `The value of the ${skip.setName} set on your gear was not fully measured, because its sim ${skip.notBuilt ? 'could not be built' : 'failed'}.`,
		error: skip.error,
	};
}

/**
 * Each note once, keyed by what the page shows: field, slot and the
 * first line of the detail. Many rows' sims can fail for one cause, and a Go
 * panic's stack trace differs from sim to sim, so a key on the whole detail
 * would repeat one sentence. The first one stays in its place, unless it has
 * no `error` and a later one does: that one takes the place, so the console
 * and the run's error toast keep the failed call's error.
 */
export function uniqueNotes(notes: readonly RunNote[]): RunNote[] {
	const placeOf = new Map<string, number>();
	const out: RunNote[] = [];
	for (const s of notes) {
		const key = `${s.field}|${s.slot ?? ''}|${s.detail.split('\n', 1)[0]}`;
		const at = placeOf.get(key);
		if (at === undefined) {
			placeOf.set(key, out.length);
			out.push(s);
		} else if (out[at]!.error === undefined && s.error !== undefined) {
			out[at] = s;
		}
	}
	return out;
}

/**
 * The hit-cap notes are written before any candidate is priced, so they say
 * "If gems were swapped": a run whose meta gem stays on swaps nothing.
 */
export function hitCapUnknownNote(): RunNote {
	return {
		field: 'Meta gem swaps and the hit cap',
		detail:
			'If gems were swapped to turn your meta gem on, hit rating was ' +
			'treated as always useful, because this tab works out the hit cap ' +
			'only when every target is level 73.',
	};
}

/**
 * The note every `fullWeight` spec gets, with or without a stats read. It
 * names no reason because the reasons differ by spec (dual wield, the
 * hunter's melee weave, a talent's hit inside the stats read for balance and
 * elemental), and the warrior page serves Arms and Fury under one spec id.
 */
export function hitCapFullWeightNote(): RunNote {
	return {
		field: 'Meta gem swaps and the hit cap',
		detail: 'If gems were swapped to turn your meta gem on, hit rating was ' + 'counted at full value, with no hit cap applied for this spec.',
	};
}

/**
 * The note a spell-hit budget gets when the player has points in a per-spell
 * hit talent: the budget leaves that talent's hit out, so the spells it covers
 * reach the cap sooner than the budget counts.
 */
export function hitCapPerSpellTalentNote(talent: string): RunNote {
	return {
		field: 'Meta gem swaps and the hit cap',
		detail:
			'If gems were swapped to turn your meta gem on, hit rating was valued ' + `as if your ${talent} talent added no hit, so it may be valued too high.`,
	};
}

function fillOptsForSwap(equipment: readonly SimItemSpec[], slotIndex: number, spec: DetectedSpecId | undefined): FillEmptyOpts {
	const usedUnique = new Set<number>();
	const otherGemIds: number[] = [];
	for (let i = 0; i < equipment.length; i++) {
		if (i === slotIndex) continue;
		for (const id of equipment[i]?.gems ?? []) {
			if (!(id > 0)) continue;
			otherGemIds.push(id);
			if (getGem(id)?.unique) usedUnique.add(id);
		}
	}
	const wornGems = (equipment[slotIndex]?.gems ?? []).filter(id => id > 0);
	const metaId = findMetaGemId([...otherGemIds, ...wornGems]);
	return {
		usedUnique,
		...(metaId !== undefined ? { meta: { metaId, otherGemIds } } : {}),
		...(spec !== undefined ? { spec } : {}),
	};
}

function applyRepairedGems(equipment: readonly SimItemSpec[], socketed: SocketedItem[]): SimItemSpec[] {
	return equipment.map((spec, i) => {
		const repaired = socketed[i];
		if (!repaired || !spec.id) return spec;
		return { ...spec, gems: [...repaired.gems] };
	});
}
