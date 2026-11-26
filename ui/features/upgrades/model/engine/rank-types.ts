/**
 * What goes into a ranking run and what comes out: the run's input and dependencies, its
 * progress reports and errors, and the stored `Ranking` with its rows and set figures.
 * `rank.ts` re-exports all of it.
 */

import type { ItemEp } from './candidate-order';
import type { Cutoff } from './cutoff';
import type { Assumptions, RunNote } from './disclosure';
import type { GemEntry } from './gems';
import type { PartnerRule } from './partner-choice';
import type { PlausibilityWarning } from './plausibility';
import type { ItemSource, PoolEntry, SimSlotName } from './pool';
import type { FightSummary, GearSource } from './seams/gear-source';
import type { RaidSimRequest, SimRunner } from './seams/sim-runner';
import type { Store } from './seams/store';
import type { SetScreen, SetScreenMode } from './set-screen';
import type { BrokenSetBonus, SelfSetConfound, SetThreshold, UnmeasuredReason } from './set-value';
import type { SimItemSpec } from './slots';
import type { CharacterRef, ContentPhase, FightRef, Race, SpecId } from './types';

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
	 * The set screen (`set-screen.ts`), run only with `measureSetBonuses`.
	 * "on" values the bonuses rows could reach only for the sets the screen
	 * keeps, and writes `Ranking.setScreen`; the tab passes it. Absent means
	 * "off". Hashed only when set.
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
	 * ends on `done === total`. The candidates' events also carry
	 * `candidateSims`, the sims the candidates run: one per legal slot, less each
	 * slot the store answered or whose hit read or repair failed. After a Stop the
	 * slots left unrun stay in it; the tab hides the time left from a Stop on.
	 */
	| { stage: 'simming'; done: number; total: number; candidateSims?: number }
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
	/** With the suffix's name when the row has `randomSuffix`. */
	name: string;
	/** The random suffix the row was simmed with (`PoolEntry.randomSuffix`). */
	randomSuffix?: number;
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
	 * The set screen's readings, each set's verdict and its reason, written
	 * only when `deps.setScreenMode` is "on". Only the set-bonus popover reads
	 * it, to say why a set was not measured; the set-bonus sims filter on the
	 * screen's own result.
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
