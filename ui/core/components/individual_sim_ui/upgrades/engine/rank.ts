/**
 * rankUpgrades — the deep module interface. Stages sit behind this; callers
 * only see RankInput → Ranking.
 *
 * ADAPTED from packages/core/src/rank.ts. Two real changes from the source,
 * both required by plan §2.1's port surface:
 *
 * 1. **No spec-mismatch check.** packages/core resolves gear from a WCL log
 *    whose owner might have logged an off-spec night, so it classifies the
 *    fight's talents (`spec.ts`) and refuses to rank a mismatch
 *    (carry-forward 61). `spec.ts` is explicitly not ported (§2.1: "the page
 *    *is* a spec") — `PlayerGearSource` (slice 3) reads the page's own
 *    current gear under the page's own selected spec, so there is no
 *    talent-classification step that could disagree with `input.spec`, and
 *    nothing to refuse. `logged.className`/`specIdHint` stay on `LoggedGear`
 *    for seam-interface parity but are unused here.
 * 2. **`contentHashOf`/`ENGINE_VERSION` replaced by a canonical-JSON string
 *    key, not a sha256 digest (D4).** `content-hash.ts`'s `canonicalJson` is
 *    ported unchanged (content-hash.ts in this directory); its `sha256Hex`
 *    half is not — `rankingCacheKey` below hashes nothing, it *is* the
 *    canonical string, mirroring `simCacheKey`'s D4 change in
 *    seams/sim-runner.ts.
 *
 * candidate-pool.md M1 (candidates cap, concurrency, EP ordering, Stop,
 * row-landed progress) is ported alongside these two pre-existing
 * adaptations, unchanged in form from packages/core/src/rank.ts.
 *
 * Everything else — the eight-stage pipeline, cutoff/replication logic, set
 * synergy, disclosure assembly — is unchanged from packages/core.
 */

import { HandType } from "../../../../proto/common.js";
import {
  fillEmptyCandidateGems,
  type FillEmptyOpts,
  type GemContext,
  gemContext,
  metaSocketUnpriced,
  missingMetaPreferenceNote,
} from "./candidate-gems.js";
import { orderCandidatesByEp } from "./candidate-order.js";
import {
  type CapState,
  capStateFrom,
  hitRegression,
  isHitDriven,
  statDeltaBetween,
} from "./caps.js";
import { compose } from "./compose.js";
import { canonicalJson, ENGINE_VERSION, type HashedGearItem } from "./content-hash.js";
import {
  type Cutoff,
  cutoffForSpec,
  meetsCutoff,
  setBonusNoiseFloorDps,
} from "./cutoff.js";
import {
  type Assumptions,
  buildStandingAssumptions,
  type Substitution,
  substitutionsFromMetaRepair,
} from "./disclosure.js";
import { enchantAppliesToItem } from "./enchants.js";
import { findMetaGemId, type GemEntry,gemsForPhase, getGem } from "./gems.js";
import { getItem } from "./items.js";
import { isKaelTempLegendary } from "./kael-temp.js";
import {
  equipmentFromLoggedGear,
  socketedItemsFromLoggedGear,
} from "./logged-gear.js";
import {
  MetaRepairError,
  type MetaRepairSwap,
  repairAndMinimize,
  type SocketedItem,
} from "./meta-repair.js";
import { migrateGemsToItem } from "./migrate-gems.js";
import {
  choosePartnerSet,
  PARTNER_RULE,
  type PartnerAudit,
  type PartnerPiece,
  partnerPool,
  type PartnerRule,
} from "./partner-choice.js";
import {
  type PlausibilityWarning,
  plausibilityWarnings,
} from "./plausibility.js";
import {
  filterPoolByPhase,
  type ItemSource,
  type PoolEntry,
  type SimSlotName,
  simSlotsForPoolSlot,
} from "./pool.js";
import { promisePool } from "./promise-pool.js";
import {
  assertUsableSeeds,
  DegenerateSeedsError,
  PAIRED_REPLICATE_TOP_N,
  pairedReplicateSe,
  usesPairedReplication,
} from "./se.js";
import type { FightSummary, GearSource } from "./seams/gear-source.js";
import {
  // Value imports: these classes are tested with `instanceof`.
  BulkScreenAbortedError,
  BulkScreenIntegrityError,
  type RaidSimRequest,
  simCacheKey,
  type SimObservation,
  type SimRunner,
  type SimRunOpts,
} from "./seams/sim-runner.js";
import type { Store } from "./seams/store.js";
import { setBreakNote } from "./set-bonus.js";
import {
  clearsSameGearGate,
  measureSameGearBonus,
  measureWornSetLadder,
} from "./set-less-copies.js";
import {
  type BonusCountPredicate,
  type BrokenSetBonus,
  brokenSetBonuses,
  combineSe,
  computeSynergy,
  type DpsSample,
  type IndividualDelta,
  type InflationKey,
  isBonusImplemented,
  netInflation,
  nextMeasurableThreshold,
  type PackagePiece,
  selectPackage,
  type SelfSetConfound,
  SET_THRESHOLDS,
  setCounts,
  setLabel,
  type SetThreshold,
  type UnmeasuredReason,
} from "./set-value.js";
import { SIM_ORDER, type SimItemSpec } from "./slots.js";
import type {
  CharacterRef,
  ContentPhase,
  DetectedSpecId,
  FightRef,
  Race,
  SpecId,
} from "./types.js";

export type RankInput = {
  character: CharacterRef;
  spec: SpecId;
  maxPhase: ContentPhase;
  fight?: FightRef;
  race?: Race;
  iterations?: number;
  seeds?: number[];
  /**
   * Keeps the first N candidates of the EP ordering, plus every owned row
   * regardless of N (§5.1.1). `undefined` means "no cap" — hashed
   * identically to a cap equal to the eligible set's size
   * (content-hash.ts's `candidateCap` normalization, mirrored below since
   * this file hashes via `canonicalJson` directly rather than through
   * `contentHashOf`).
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
  gemPalette?: readonly GemEntry[];
  pool?: readonly PoolEntry[];
  /**
   * Per-request item rows for the sim's database (ticket 212). Data, not a
   * port: synchronous, no I/O, nothing to record — same family as `pool` and
   * `epWeights`.
   *
   * The browser needs it because its WASM sim is built without `with_db`, so
   * the registry is filled per request; a candidate is never worn, so the
   * skeleton's own database never describes it. CLI callers omit it —
   * `wowsimcli` is built `with_db` — and composed requests then stay
   * byte-identical to today's.
   */
  simDatabaseFor?: (
    equipment: readonly SimItemSpec[]
  ) => Readonly<Record<string, unknown>> | undefined;
  /**
   * How many candidate sims may be in flight at once (candidate-pool.md
   * §5.1.2). A plain scalar, not a ranking input — it changes how fast a
   * run goes, never what it returns, so it stays out of the content hash.
   * Defaults to 1 (serial) when omitted.
   */
  concurrency?: number;
  /**
   * When set, `buildSetBonuses` measures every bonus of every worn set on the
   * player's own gear with the worn-set ladder, and charges a break only where
   * that value clears the noise gate (tickets 467 and 512); it also measures
   * each package's bonus on the package's own gear (ticket 511). The tab
   * passes it; the E-W3 parity harness does not, so the compared request
   * lists stay identical (`wowsims-fork-parity.test.ts` never sets the flag).
   * Absent = today's behaviour and today's request list exactly.
   */
  measureBrokenSetValue?: boolean;
  /**
   * The rule that picks each set row's partner pieces for a bonus (ticket 511,
   * `partner-choice.ts`). Absent means `PARTNER_RULE`. Only the tab's check
   * hook sets it, in dev and gate builds, to score the rules; it joins the
   * content hash only when set, so a ranking cached under one rule is never
   * served for another.
   */
  partnerRule?: PartnerRule;
  /**
   * Stop signal (candidate-pool.md §5.1.4). On abort, in-flight per-candidate
   * sims finish and the run returns a `PartialRanking` (`complete: false`); no
   * further candidates are dispatched. An in-flight bulk **screening chunk** is
   * aborted rather than finished (ticket 347) — a chunk costs seconds on the Go
   * transport and minutes on the in-browser one, which no honest reading of
   * "in-flight work finishes" covers.
   */
  signal?: AbortSignal;
};

export type Progress =
  | { stage: "resolving" }
  | { stage: "reading-gear" }
  | { stage: "composing" }
  | { stage: "building-pool" }
  | { stage: "simming"; done: number; total: number }
  /**
   * A single candidate's row finished — fired as each sim finishes, ahead of
   * the "ranking" stage, so a caller can fill a skeleton row incrementally
   * rather than waiting for the whole run (candidate-pool.md §5.1.5). No
   * `stage` field: this is a side channel alongside the stage sequence
   * above, not a replacement for the "simming" done/total updates.
   */
  | { kind: "row"; row: RankedItem }
  | { stage: "ranking" };

export type RankErrorKind =
  | "character-not-found"
  | "no-qualifying-fight"
  | "gear-unreadable"
  | "meta-unsolvable"
  | "sim-failed"
  | "wcl-budget-exhausted"
  | "not-implemented"
  | "internal";

export class RankError extends Error {
  readonly kind: RankErrorKind;

  constructor(kind: RankErrorKind, message: string) {
    super(message);
    this.name = "RankError";
    this.kind = kind;
  }
}

export type RankedItem = {
  rank: number | null;
  itemId: number;
  name: string;
  slot: PoolEntry["slot"];
  slotChoice?: SimSlotName;
  source: ItemSource;
  sources?: ItemSource[];
  deltaDps: number;
  deltaPct: number;
  se: number;
  seMethod: "independent" | "paired-replicate";
  bisTags: Array<"BiS" | "Alt" | "Realistic">;
  curatedSets?: string[];
  bisSets?: string[];
  hitDriven?: boolean;
  hitRegression?: { lost: number; gapAfter: number };
  setBonusNote?: string;
  gemSubstitutions?: Array<{
    itemId: number;
    socketIndex: number;
    from: number;
    to: number;
  }>;
  removedItems?: Array<{ itemId: number; slot: SimSlotName }>;
  emptyMetaSocket?: boolean;
  owned?: boolean;
  /**
   * `false` only on a row Stop left unsimmed (candidate-pool.md §5.1.4) —
   * absent otherwise, never `true`, so an ordinary complete run never
   * has the field at all and a reader can tell "simmed" from "this
   * `Ranking` predates Stop" apart from "this row was skipped by Stop".
   * Such a row's `deltaDps`/`se`/etc. are placeholders, excluded from
   * cutoff classification and tie groups.
   */
  simmed?: false;
  belowCutoff: boolean;
  setContext?: SetContext;
};

/**
 * A per-row breakdown of one set piece's set-bonus consequences (ticket 467).
 *
 * `singleBreaks` are already inside `deltaDps` (this one piece's own break);
 * `futureBonuses` and `commitBreaks` are the ON-view terms added on top of
 * `deltaDps` (bonuses the completed set would gain, and worn bonuses completing
 * it would break beyond the single's own break). `dps` on a break is the
 * measured `B`; absent means it could not be measured (`no-neutral-candidates`,
 * `dependent-unmeasured`) and the row falls back to disclosure-only, per the
 * plan's fallback rule — for a future bonus or a commit break alike (477).
 *
 * A future's `breaks` are the worn bonuses its own path breaks beyond the
 * row's single break: this candidate plus the best remaining pieces of that
 * threshold's measured package (the whole package when the candidate is in
 * it). Only these are charged by the ON credit. `commitBreaks` keeps the top
 * package with this candidate substituted: disclosure ("full set end state")
 * and a measurement-target source. Charging the top package's breaks to
 * every future made a Malorne chest row pay for the Thunderheart 2pc that
 * only the Malorne 4pc's hands piece breaks (ticket 490). Every path break is
 * already a measurement target: a path is a subset of the substituted top
 * package, because packages nest, and a subset of vacated slots loses a
 * subset of thresholds.
 *
 * A future's `pieces` are the other members of that same path, in path order,
 * each with its own stats as `dps`: its single delta, plus the worn bonuses it
 * breaks alone, minus the 2pc it crosses alone at worn 1. The ON credit counts
 * them because committing to the bonus means wearing those pieces too, gain or
 * loss (ticket 502, ADR-0034). `pieces` is present, possibly empty, exactly
 * when the future has a path; `dps` is absent when an input was unmeasured.
 */
export type SetContext = {
  setId: number;
  setName: string;
  piecesWornBefore: number;
  piecesAfterSwap: number;
  nextThreshold: SetThreshold | null;
  crossesThreshold: boolean;
  /**
   * Set on every row of a step ranking (ticket 511): the engine valued each
   * future as a sim of the row's step gear. The view's helpers that see only
   * this context read it to apply the step rule instead of the ticket 502
   * walk. Absent on rankings made without `measureBrokenSetValue`.
   */
  stepRanking?: true;
  /**
   * The row's single-swap figure d_r, taken before paired replication
   * rewrites `deltaDps`. A step's credit is its `stepGearDps` minus this.
   */
  singleDeltaDps?: number;
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
    /** The entry's `sameGearDps` and `sameGearSe`, copied (ticket 511). */
    sameGearDps?: number;
    sameGearSe?: number;
    /** The entry's gate did not clear: no package or step sim ran (511). */
    belowGate?: true;
    /**
     * The sim of the current gear plus this row plus its partner pieces, minus
     * the sim of the current gear, and that difference's standard error
     * (ticket 511). Present only on a step ranking, for a future whose gate
     * cleared, when the partner choice and the sim succeeded.
     */
    stepGearDps?: number;
    stepGearSe?: number;
    /** The partner choice needed a worn bonus whose value is unmeasured. */
    partnerUnmeasured?: "break-unmeasured";
    /** The rule that chose `pieces` on a step ranking. */
    partnerRule?: PartnerRule;
    breaks?: Array<{
      setId: number;
      setName: string;
      threshold: SetThreshold;
      dps?: number;
    }>;
    pieces?: Array<{ itemId: number; name: string; dps?: number }>;
  }>;
  commitBreaks?: Array<{
    setId: number;
    setName: string;
    threshold: SetThreshold;
    dps?: number;
  }>;
  commitPackageDeltaDps?: number;
  packages?: SetPackageContext[];
};

export type SetPackageContext = {
  threshold: SetThreshold;
  deltaDps: number;
  itemIds: number[];
  piecesNeeded: number;
};

/**
 * Standalone value `B` of one worn set bonus (X, t) that a swap can break: the
 * worn-set ladder's value at count t on the player's own gear (ticket 512), for
 * a count whose value clears the noise gate or could not be measured. `dps` is
 * `B`; absent with `unmeasured` when a ladder sim failed. Only `sim-failed` is
 * produced since the ladder replaced the vacate sims; the other members are
 * kept for rankings saved before it.
 */
export type BrokenSetValue = {
  setId: number;
  setName: string;
  threshold: SetThreshold;
  dps?: number;
  se?: number;
  unmeasured?:
    | "no-neutral-candidates"
    | "sim-failed"
    | "repair-failed"
    | "dependent-unmeasured";
};

/**
 * One count of one worn set's ladder (ticket 512): its measured value on the
 * player's own gear, and whether it is `counted` as a break — a value that
 * clears the noise gate, or one whose sim failed (the row then shows it as
 * unmeasured). Counts at which the set has no bonus read about 0 and are not
 * counted.
 */
export type WornSetLadderEntry = {
  setId: number;
  setName: string;
  count: number;
  dps?: number;
  se?: number;
  unmeasured?: "sim-failed";
  counted: boolean;
};

/** One crossing gate of `Ranking.crossingGates` (ticket 511). */
export type CrossingGate = {
  setId: number;
  /** One more than the worn count: the count a single swap reaches. */
  count: number;
  /** The candidate whose single-swap gear the gate was measured on. */
  itemId: number;
  dps?: number;
  se?: number;
  cleared: boolean;
};

export type SetStepSims = {
  partnerRule: PartnerRule;
  /** Distinct step gears across every row and future. */
  gears: number;
  simmed: number;
  fromStore: number;
};

export type PartnerAuditEntry = {
  itemId: number;
  setId: number;
  count: number;
  audit: PartnerAudit;
};

export type SetBonusValue = {
  setId: number;
  setName: string;
  threshold: SetThreshold;
  piecesWorn: number;
  packageItemIds: number[];
  packageDeltaDps: number;
  /**
   * The package synergy `pkgΔ − Σsingles − raw2pc`, before any broken-bonus
   * correction. One exception: at worn 1 a 4pc also adds back `(n−1)·B2` from
   * the pair sim (ticket 492, `selfConfound`). E-W3 compares this field.
   */
  bonusDps?: number;
  /**
   * `bonusDps` corrected for ticket 90's `(k − c)·B` inflation using the
   * measured broken-bonus value `B` (ticket 467); the value the ON credit and
   * sort key use. Absent when any needed `B` is unmeasured, or when a worn-1
   * 4pc's `selfConfound` has no `dps` (no usable pair, or the pair sim or its
   * gem repair failed). Absent reverts the row to disclosure-only.
   */
  bonusDpsNet?: number;
  se?: number;
  /**
   * The bonus measured on its own package's gear: the same gear simmed twice
   * with enough of this set's pieces sent as copies to leave `threshold − 1`
   * without them, set kept in one sim and set-less in the other (tickets 511
   * and 512, `measureSameGearBonus`). The noise gate for a
   * set step reads it; `bonusDps` is left as it was. Present only under
   * `deps.measureBrokenSetValue` and for a measured package; absent when a sim
   * failed. `sameGearSe` is the combined standard error of the two sims.
   */
  sameGearDps?: number;
  sameGearSe?: number;
  /**
   * The same-gear value is at or below the noise gate, so this count is not
   * a bonus here and no package, pair or step sim ran for it (ticket 511).
   * Such an entry is never a simmed package: `packageDeltaDps` is 0 and
   * `bonusDps` is absent.
   */
  belowGate?: true;
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
  route: FightSummary["route"];
  confidence?: number;
  salvationUptime?: number;
};

export type Ranking = {
  contentHash: string;
  cutoff: Cutoff;
  fight: ResolvedFight;
  baseline: { dps: number; stdev: number; metaAdjusted: boolean };
  assumptions: Assumptions;
  substitutions: Substitution[];
  caps: CapState;
  items: RankedItem[];
  setBonuses?: SetBonusValue[];
  /**
   * Standalone value `B` of each worn set bonus a swap can break: one entry per
   * counted ladder count (tickets 467 and 512). Present only when
   * `deps.measureBrokenSetValue` is set; the E-W3 harness leaves it unset, so
   * this field never appears there and adds no requests to the parity
   * comparison.
   */
  brokenSetValues?: BrokenSetValue[];
  /**
   * Every count from 2 to the worn count of every worn set, measured with the
   * ladder, counted or not (ticket 512). Present only when
   * `deps.measureBrokenSetValue` is set and a set is worn at 2 or more.
   */
  wornSetLadder?: WornSetLadderEntry[];
  /**
   * One gate per worn set with a pool piece in a slot the set does not fill:
   * the bonus at one piece more than worn, measured on that set's best such
   * candidate's own swap (ticket 511). A row crosses a bonus only when its
   * count's gate here cleared. Present only with `measureBrokenSetValue`.
   */
  crossingGates?: CrossingGate[];
  /**
   * The step-gear sims of a step ranking (ticket 511): the rule that chose
   * the partner pieces, how many distinct step gears there were, and how many
   * of their sims ran or came from the store. Its presence marks the ranking
   * as one whose set rows are valued by the step rule.
   */
  setStepSims?: SetStepSims;
  /**
   * Every partner set simmed for every eligible future, written only under
   * the "every-combination" rule, which the tab's check hook sets to score
   * the zero-sim rules (ticket 511). Players never get it.
   */
  partnerAudit?: PartnerAuditEntry[];
  plausibilityWarnings?: PlausibilityWarning[];
  /**
   * Screening chunks that failed for an engine or transport reason, and whose
   * candidates were priced by the per-candidate loop instead (ticket 347's
   * rider). The ranking is unaffected in content — the loop measures the same
   * question — but it cost more sims than it should have, and saying so is the
   * difference between a slow run and an inexplicable one.
   *
   * Absent when nothing fell back, so a run that took the bulk route cleanly is
   * byte-identical to one on a runner with no bulk capability at all — which is
   * what the route-equivalence tests compare.
   */
  screeningFallbacks?: readonly { candidates: number; reason: string }[];
  /**
   * `true` unless Stop cut this run short (candidate-pool.md §5.1.4).
   *
   * The literal type does real work at every consumer that names `Ranking`
   * in its signature — `applyView` will not accept a `PartialRanking`. It
   * does **not** guard the ranking cache: `Store.put<T>` is generic, so
   * writing a partial under a `ranking:` key type-checks fine. The only
   * thing keeping a partial out of the cache is the `if (aborted) return
   * partial` branch below, which returns before the write — a runtime
   * check, so treat it as one and do not remove it on the theory that the
   * type covers you.
   */
  complete: true;
};

/**
 * What `rankUpgrades` returns when `Deps.signal` aborts mid-run
 * (candidate-pool.md §5.1.4). Rows Stop never reached carry
 * `simmed: false` and are excluded from `rank`/cutoff classification and
 * tie groups; per-sim cache rows for whatever did complete are still
 * written, so a re-run resumes cheaply. Never written to the ranking
 * cache — only a `complete: true` `Ranking` is.
 */
export type PartialRanking = Omit<Ranking, "complete"> & { complete: false };

type BestSwap = {
  deltaDps: number;
  /**
   * The baseline `deltaDps` was measured against — the loop's own baseline, or
   * the bulk engine's probe when this attempt came from the screening pass
   * (see `screenCandidates`). Carried so `deltaPct` divides by the same
   * reference the delta was taken from rather than assuming the loop's.
   */
  baselineDps: number;
  stdev: number;
  request: RaidSimRequest;
  slotChoice?: SimSlotName;
  slotIndex: number;
  setBonusNote?: string;
  hitDriven: boolean;
  hitRegression: { lost: number; gapAfter: number } | null;
  repairSwaps: readonly MetaRepairSwap[];
  /** Worn items the winning attempt took off beyond the swap itself (350). */
  removed: readonly { slotIndex: number; itemId: number }[];
  candidateGems: readonly number[];
};

/**
 * Flat and fixed, for the accurate final pass rather than for speed. The owner's
 * standing decision is that the ranking's published numbers come from a full
 * per-candidate sim at this count, which is why the bulk screening pass changes
 * only where a screening DPS comes from and never what the final pass measures.
 *
 * Deliberately not adaptive. Raising the base count and adopting an
 * adaptive-iteration scheme are held together as one open decision in ticket
 * 339 — the two interact (adaptive is the mechanism that makes a higher base
 * affordable), so neither moves alone.
 *
 * Changing it is not local: the value is part of every ranking cache key.
 *
 * It does not, however, threaten the no-culling batch bound in
 * `bulk/partition.ts`. That boundary moves DOWN as iterations rise, but it
 * floors: n = 25 and n = 26 are single-stage at every count measured up to
 * 1,000,000, and the first multi-stage n settles at 27 above 28,000 iterations
 * (upstream's own estimator, measured in
 * `packages/core/test/bulk-boundary.test.ts`). The shipped bound of 25 is
 * therefore iteration-invariant, and `assertSingleStageChunk` checks every
 * built chunk against that estimator regardless, so a raised constant fails
 * loudly instead of culling silently (ticket 349).
 */
const DEFAULT_ITERATIONS = 5000;
const DEFAULT_SEEDS = [11, 22, 33, 44, 55];

/**
 * Per-spec preset id, disclosed in `Assumptions.presetId`. Values are a fork
 * concept (the page's own current settings serialize to the skeleton per
 * plan D5/§2.3), kept as a stable label rather than packages/core's
 * `ret/p2.raid-sim-skeleton` file-path style, since there is no such file
 * here — the skeleton comes from the page, not from disk.
 */
const PRESET_ID_BY_SPEC: Record<SpecId, string> = {
  ret: "ret/current-page-settings",
  feral: "feral/current-page-settings",
  balance: "balance/current-page-settings",
  hunter: "hunter/current-page-settings",
  mage: "mage/current-page-settings",
  shadow: "shadow/current-page-settings",
  rogue: "rogue/current-page-settings",
  ele: "ele/current-page-settings",
  enh: "enh/current-page-settings",
  warlock: "warlock/current-page-settings",
  warrior: "warrior/current-page-settings",
};

function presetIdFor(spec: SpecId): string {
  return PRESET_ID_BY_SPEC[spec];
}

export async function rankUpgrades(
  input: RankInput,
  deps: Deps,
  onProgress?: (p: Progress) => void
): Promise<Ranking | PartialRanking> {
  onProgress?.({ stage: "resolving" });
  const cutoff = cutoffForSpec(input.spec);
  const fights = await deps.gear.findFights(input.character, input.spec);
  const maybeResolved = resolveFight(fights, input.fight);
  if (!maybeResolved) {
    throw new RankError(
      "no-qualifying-fight",
      `no qualifying fights for ${input.character.name}`
    );
  }
  const resolved: ResolvedFight = maybeResolved;
  const fight = { reportCode: resolved.reportCode, fightId: resolved.fightId };

  onProgress?.({ stage: "reading-gear" });
  const logged = await deps.gear.readGear(fight);

  onProgress?.({ stage: "composing" });
  const race = input.race ?? raceFromSkeleton(deps.raidSimSkeleton);
  const preRepairSocketed = socketedItemsFromLoggedGear(logged);
  let socketed: SocketedItem[] = preRepairSocketed;
  let metaAdjusted = false;
  let metaSwaps: MetaRepairSwap[] = [];
  const gems = gemContext(
    deps.gemPalette ?? gemsForPhase(input.maxPhase),
    deps.epWeights,
    input.spec
  );
  try {
    const minimized = repairAndMinimize({
      items: preRepairSocketed,
      epWeights: deps.epWeights,
      palette: gems.fillPalette,
    });
    socketed = minimized.items;
    metaAdjusted = minimized.metaAdjusted;
    metaSwaps = minimized.swaps;
  } catch (err) {
    if (err instanceof MetaRepairError) {
      throw new RankError("meta-unsolvable", err.message);
    }
    throw err;
  }

  const equipment = applyRepairedGems(
    equipmentFromLoggedGear(logged),
    socketed
  );
  // Every request describes its own equipment in its own database, which is
  // upstream's invariant (ui/core/sim.ts:346-347). Without a resolver this is
  // exactly today's compose call, so CLI requests stay byte-identical.
  const composeFor = (forEquipment: readonly SimItemSpec[]) => {
    const database = deps.simDatabaseFor?.(forEquipment);
    return compose(deps.raidSimSkeleton, {
      name: input.character.name.toLowerCase(),
      race,
      equipment: forEquipment,
      // Spread rather than `database: undefined` — exactOptionalPropertyTypes
      // distinguishes an absent key from an explicit undefined, and compose
      // must see no key at all when there is no resolver.
      //
      // `!== undefined`, not truthiness: an empty database is a meaningful
      // answer ("this request needs no extra rows") and must be written
      // through, where `undefined` means no resolver at all — the CLI path.
      ...(database !== undefined ? { database } : {}),
    });
  };

  /**
   * The base request for a *bulk* screening pass. Identical to `composeFor`
   * except that the embedded database is the union over every gear set the
   * request can ask the sim to equip, not just the baseline's.
   *
   * A bulk request is one request spanning n gear sets, and the browser's WASM
   * sim is built without `with_db`, so its item registry starts empty and is
   * filled per request from the player's database (`adapters/sim_database.ts`
   * doc comment; `compose.ts:48` writes it to the player, not the request
   * root). A candidate item the character does not wear therefore appears in
   * no database the baseline ever built, and environment construction dies on
   * its id — "No item with id: N" — before a single iteration runs.
   *
   * The per-candidate loop never hits this because it composes each request
   * from that candidate's own gear. Screening must widen the database instead.
   * Each gear set is resolved separately and the repeated fields merged by row
   * identity: handing `simDatabaseFor` a flat list of candidate ids instead
   * fails inside `lookupEquipmentSpec` with "No slots left to equip", because
   * it assigns items to slots and cannot place several same-slot items at once.
   */
  const composeForBulk = (
    candidateGear: readonly (readonly SimItemSpec[])[]
  ) => {
    if (!deps.simDatabaseFor) return composeFor(equipment);
    const byField = new Map<string, Map<string, unknown>>();
    for (const gear of [equipment, ...candidateGear]) {
      const database = deps.simDatabaseFor(gear) as
        | Record<string, unknown>
        | undefined;
      if (!database) continue;
      for (const [field, rows] of Object.entries(database)) {
        if (!Array.isArray(rows)) continue;
        const seen = byField.get(field) ?? new Map<string, unknown>();
        // `JSON.stringify` is enough for row identity here (rather than a
        // key-order-stable hash): every row in this union comes from one
        // `simDatabaseFor` implementation within a single run, so equal rows
        // are built the same way and serialise identically. Duplicates only
        // cost bytes anyway — the failure this dedupe avoids is a bloated
        // request, never a wrong one.
        for (const row of rows) seen.set(JSON.stringify(row), row);
        byField.set(field, seen);
      }
    }
    const database = Object.fromEntries(
      [...byField].map(([field, seen]) => [field, [...seen.values()]])
    );
    return compose(deps.raidSimSkeleton, {
      name: input.character.name.toLowerCase(),
      race,
      equipment,
      database,
    });
  };

  const request = composeFor(equipment);

  const iterations = input.iterations ?? DEFAULT_ITERATIONS;
  const seeds = input.seeds ?? DEFAULT_SEEDS;
  try {
    assertUsableSeeds(seeds);
  } catch (err) {
    if (err instanceof DegenerateSeedsError) {
      throw new RankError("internal", err.message);
    }
    throw err;
  }
  const seed = seeds[0] ?? DEFAULT_SEEDS[0]!;
  const runOpts = { seed, iterations };

  onProgress?.({ stage: "building-pool" });
  const equippedIds = new Set(
    equipment.map((s) => s.id).filter((id): id is number => !!id)
  );
  /**
   * Whether the worn main hand leaves the off hand usable at all.
   *
   * A two-hander occupies both hands, so no off-hand candidate is legal
   * beside it. An *empty* main hand counts as usable: nothing blocks the off
   * hand, and a character with no weapon at all should still see off-hand
   * rows rather than silently losing the slot.
   */
  const mainHandIsOneHanded = ((): boolean => {
    const wornMainHandId = equipment[SIM_ORDER.indexOf("mainhand")]?.id;
    if (!wornMainHandId) return true;
    return getItem(wornMainHandId)?.handType !== HandType.HandTypeTwoHand;
  })();
  const eligible = filterPoolByPhase(deps.pool ?? [], input.maxPhase).filter(
    (e) => !isKaelTempLegendary(e.itemId)
  );
  // Ordering runs before any sim, from raw stats only, so it cannot fail on
  // a candidate the sim itself would later reject. This order also decides
  // which N the cap keeps (§5.1.1).
  const ordered = orderCandidatesByEp(
    eligible,
    equipment,
    deps.epWeights,
    (itemId) => getItem(itemId)?.stats ?? [],
    input.spec
  );

  const simVersion = await deps.sim.version();

  // Hashed on every *eligible* candidate, not the post-cap set: which
  // candidates are eligible is known before any sim runs, so this is stable
  // enough to gate the cache lookup before the sim loop starts.
  // `candidateCap` is a separate hashed field (below) that narrows the
  // eligible set down to what actually gets a full sim — hashing here rather
  // than at entry because the logged gear is the
  // largest input to every delta, and it is not known until readGear
  // resolves. The check still happens before the sim loop, which is the
  // expensive part.
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
      .map((item) => ({
        id: item.id,
        slot: item.slot,
        enchant: item.enchant ?? 0,
        gems: [...(item.gems ?? [])],
      }))
      .sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : a.id - b.id)),
    candidates: ordered
      .map((e) => ({ itemId: e.itemId, slot: e.slot }))
      .sort((a, b) =>
        a.itemId !== b.itemId
          ? a.itemId - b.itemId
          : a.slot < b.slot
            ? -1
            : a.slot > b.slot
              ? 1
              : 0
      ),
    gemPaletteIds: gems.palette.map((g) => g.id).sort((a, b) => a - b),
    epWeights: deps.epWeights,
    presetId: presetIdFor(input.spec),
    skeleton: deps.raidSimSkeleton,
    iterations,
    seeds: [...seeds],
    simVersion,
    engineVersion: ENGINE_VERSION,
    // Normalized the same way content-hash.ts normalizes these fields for
    // `contentHashOf` — "no cap"/omitted knob must hash identically to its
    // explicit-default equivalent (plan §5.1.1, §6.1) — even though this
    // file hashes via `canonicalJson` directly rather than `contentHashOf`
    // (D4, see file doc comment above).
    candidateCap: input.candidateCap ?? ordered.length,
    // Frozen at the values the tab has written since `41e2260` set
    // `fullPool: true`. Racing is gone and these describe nothing the engine
    // still does, but they are part of every cache key already written:
    // dropping them would rehash every stored ranking and silently re-sim it.
    // Three fields, not core's four — the fork never hashed `promoteTopJ`,
    // and adding it would change every key. Deliberate divergence; delete
    // only alongside an ENGINE_VERSION bump.
    fullPool: true,
    screenIterations: null,
    promoteTopK: null,
    // Only when set, so a run without it keeps every key already written; a
    // run with it is never served a ranking another rule made (ticket 511).
    ...(deps.partnerRule !== undefined ? { partnerRule: deps.partnerRule } : {}),
  });

  const cached = await deps.store.get<Ranking>(rankingCacheKey(contentHash));
  if (cached) {
    onProgress?.({ stage: "ranking" });
    return cached;
  }

  let simsDone = 0;
  let totalSimsForProgress = 0;

  const job = await deps.store.job.create({ contentHash, input });
  await deps.store.job.update(job.id, { status: "running" });

  try {
    return await rankAfterJobCreated();
  } catch (err) {
    try {
      await deps.store.job.update(job.id, {
        status: "error",
        errorKind: err instanceof RankError ? err.kind : "internal",
        errorDetail: err instanceof Error ? err.message : String(err),
      });
    } catch {
      // deliberately ignored — see packages/core/src/rank.ts
    }
    throw err;
  }

  async function rankAfterJobCreated(): Promise<Ranking | PartialRanking> {
    // Only `deps.sim.run` belongs inside this catch. A store read or write
    // that fails is an `internal` fault, and labelling it `sim-failed` sends
    // an operator to the wrong subsystem.
    let observation = await readCachedSim(deps, request, simVersion, runOpts);
    if (!observation) {
      try {
        observation = await deps.sim.run(request, runOpts);
      } catch (err) {
        throw new RankError(
          "sim-failed",
          err instanceof Error ? err.message : String(err)
        );
      }
      await cacheSimResult(deps, request, simVersion, runOpts, observation);
    }
    simsDone = 1;

    const baselineDps = observation.dps;
    const ranked: RankedItem[] = [];
    const winningRequests = new Map<number, RaidSimRequest>();
    const candidateSkips: {
      kind: "sim" | "repair";
      itemId: number;
      name: string;
      slot: string;
      reason: string;
    }[] = [];
    /**
     * Screening chunks that failed for an engine or transport reason, whose
     * candidates the per-candidate loop priced instead. Disclosed on the
     * `Ranking` so a slow run is explicable rather than mysterious.
     */
    const screeningFallbacks: { candidates: number; reason: string }[] = [];
    const individualDeltasByItemId = new Map<number, IndividualDelta>();

    const talentsString = talentsStringFromRequest(request);
    const caps = capStateFrom(equipment, socketed, {
      assumedRace: race,
      spec: input.spec,
      ...(talentsString !== undefined ? { talentsString } : {}),
    });

    /** Screening observations are keyed by the attempt, not by the item. */
    const screenKey = (itemId: number, slotIndex: number) =>
      `${itemId}:${slotIndex}`;

    /**
     * Which `(item, slot)` attempts are eligible to be priced at all.
     *
     * One implementation for both routes on purpose. The screening pass and the
     * pricing loop each walk the same candidates and must agree *exactly* on the
     * resulting attempt set, because `screenKey` is only `itemId:slotIndex` — it
     * holds no fingerprint of the gear the observation was measured on. If the
     * two routes ever disagreed about which attempts exist while both still
     * continued past the disagreement, the loop could read a screened DPS that
     * was measured on different gear than the `candReq` it records into
     * `winningRequests`, and nothing would report it: a wrong number rather than
     * a failure.
     *
     * Deliberately returns *why* an attempt is ineligible rather than a boolean,
     * so the loop can keep the one behaviour that legitimately differs between
     * the routes — an unmappable slot is a bug assertion the loop throws on,
     * while screening has no run to fail and simply does not screen it. Every
     * other outcome is shared.
     *
     * Meta-gem repair is NOT part of this: `candidateSwapWithRepairs` is
     * deterministic over the same immutable `equipment`/`gems`, so both routes
     * throw on exactly the same attempts, and only the loop records the
     * `candidateSkips` disclosure — keeping that in one place is the point.
     */
    const attemptEligibility = (
      entry: PoolEntry,
      slotName: SimSlotName
    ):
      | { kind: "ok"; slotIndex: number }
      | { kind: "skip" }
      | { kind: "unmapped" } => {
      // A one-hander is only a legal off-hand candidate if the weapon already in
      // the main hand is itself one-handed. `simSlotsForPoolSlot` filters the
      // *candidate's* hand type and knows nothing about what is worn, so without
      // this the ranker sims a one-hander into an empty off hand while a
      // two-hander stays in the main hand — a pairing the game cannot equip,
      // priced as an upgrade.
      //
      // Skipping is the minimal correct semantics. The alternative, letting the
      // off-hand pick displace the worn two-hander, prices a two-item swap under
      // a one-item row: the delta would silently include losing the two-hander,
      // which is not what the row claims. A player holding a two-hander who
      // wants to dual-wield gets that answer from the main-hand rows, which are
      // ranked normally.
      if (slotName === "offhand" && !mainHandIsOneHanded) return { kind: "skip" };
      const slotIndex = SIM_ORDER.indexOf(slotName);
      if (slotIndex < 0) return { kind: "unmapped" };
      // A paired slot tries both placements and keeps the better one, so without
      // this an item already worn in finger2 gets priced as an upgrade into
      // finger1 as well — a second copy the player does not have. Skipping
      // leaves the identity swap as the only outcome for a worn item, matching
      // what every unpaired slot already does.
      //
      // Wearing a second copy of a *non-unique* ring or trinket is legal in TBC,
      // and this guard blocks that row. Ticket 308 decided it is deliberately out
      // of scope, because relaxing the guard here does not produce the missing
      // row. The loop emits one row per *item*, not per placement: it keeps only
      // the best swap across slots, so an unguarded second placement would not
      // appear alongside the worn item's identity swap — it would win the
      // comparison and overwrite it, turning "you already wear this" into "wear a
      // second one" with nothing in the row saying so. The below-cutoff owned-row
      // filter in upgrades_tab.tsx rests on this guard for the same reason.
      // Producing the row honestly needs a per-placement row concept through the
      // engine output, the view, and the UI; every item entry already has
      // `unique` for whoever builds it. Ticket 309 holds the redesign map.
      const wornAt = equipment.findIndex((spec) => spec.id === entry.itemId);
      if (wornAt >= 0 && wornAt !== slotIndex) return { kind: "skip" };
      return { kind: "ok", slotIndex };
    };

    /**
     * Prices every (item, slot) attempt through the runner's bulk capability,
     * returning one observation per attempt **and the baseline those
     * observations must be differenced against**. Returns undefined when the
     * runner has no such capability, which is what keeps the per-candidate path
     * the default and this branch purely additive.
     *
     * The baseline comes back with the observations because it is not
     * interchangeable with the loop's. The bulk pass probes its own baseline
     * inside the same batch, at a seed it picks itself, and the two probes can
     * land far apart: the local HTTP measurement recorded in
     * `.scratch/stage-gate/batch-sim-web-local/execution-ledger-local.md` put
     * the loop's seed-11 baseline at 2246.99 DPS and the bulk pass's own probe
     * at 2181.67 — 65.3 DPS apart, against a cutoff of 3.4.
     *
     * That gap is a SEED artifact, not an engine one, and the distinction
     * matters for anyone tempted to "correct" for it elsewhere. The same ledger
     * records the loop at seed 777 giving 2181.37 — within 0.3 DPS of the bulk
     * probe — so two runs of the *same* route at different seeds differ by more
     * than the two routes do. The engines agree; the seeds do not.
     *
     * Either way the rule is the same and holds under both readings: a delta is
     * only meaningful against the baseline measured in the same run as the
     * observation. Differencing a bulk-measured candidate against the
     * loop-measured baseline would push the whole gap into every screened row's
     * `deltaDps`. Because both halves of a screened delta come from one run, a
     * shared offset cancels inside the subtraction — which is why the stored
     * delta needs no later re-scaling (see `individualDeltasByItemId.set`).
     *
     * One baseline for the whole pass, not one per chunk. The shared chunk
     * driver keeps the first probe it gets (`baseline ??=`) — the first
     * SUCCESSFUL chunk's, since a chunk that fails contributes no probe and its
     * candidates fall through to the loop — and that is the correct choice: a
     * single shared offset is invisible to the sort that produces the
     * ranking, whereas a per-chunk baseline would apply a *different* noise
     * term to each disjoint subset of rows and make candidates from different
     * chunks non-comparable in exactly the global sort and absolute cutoff this
     * function feeds. Nothing cancels per chunk either — every chunk is built
     * from the same `randomSeed` (`adapters/bulk_request_builder.ts`), so a
     * later chunk's probe is a redundant re-measurement of the same stream, not
     * a paired one.
     *
     * Composition happens here exactly as it does in the loop — same
     * `candidateSwapWithRepairs`, same `composeFor` — so the gear the screening
     * pass prices is the gear the loop would have priced. An attempt whose
     * repairs throw is simply not screened; the loop hits the same throw and
     * records the `candidateSkips` row, so the disclosure stays in one place.
     */
    async function screenCandidates(entries: readonly PoolEntry[]): Promise<
      | {
          baselineDps: number;
          byKey: ReadonlyMap<string, SimObservation>;
        }
      | undefined
    > {
      const runBulkScreen = deps.sim.runBulkScreen?.bind(deps.sim);
      if (!runBulkScreen) return undefined;

      const attempts: { key: string; gear: readonly SimItemSpec[] }[] = [];
      for (const entry of entries) {
        const slotNames = simSlotsForPoolSlot(
          entry.slot,
          input.spec,
          entry.itemId
        );
        for (const slotName of slotNames) {
          const eligibility = attemptEligibility(entry, slotName);
          // An unmappable slot is a bug the loop asserts on. Screening has no
          // run to fail here — the loop reaches the same attempt and throws —
          // so it simply does not screen it.
          if (eligibility.kind !== "ok") continue;
          const { slotIndex } = eligibility;
          try {
            const outcome = candidateSwapWithRepairs(
              equipment,
              slotIndex,
              entry.itemId,
              gems
            );
            attempts.push({
              key: screenKey(entry.itemId, slotIndex),
              gear: outcome.equipment,
            });
          } catch (err) {
            if (!(err instanceof MetaRepairError)) throw err;
          }
        }
      }
      if (attempts.length === 0) return undefined;

      let result;
      try {
        result = await runBulkScreen({
          baseRequest: composeForBulk(attempts.map((attempt) => attempt.gear)),
          candidates: attempts.map((attempt, index) => ({
            index,
            gear: { items: attempt.gear.map((item) => ({ ...item })) },
          })),
          iterations,
          // The same seed the per-candidate path would have used, so the
          // screening pass measures the question the loop asks.
          seed: runOpts.seed,
          // Ticket 347: the runner aborts the in-flight chunk on Stop and
          // issues no further one.
          signal: deps.signal,
        });
      } catch (err) {
        // Stop: no screening numbers, and the caller's own abort handling
        // takes it from here — the loop dispatches nothing either.
        if (err instanceof BulkScreenAbortedError) return undefined;
        // A structurally wrong bulk response is not something to work around
        // quietly; it is exactly what the integrity checks exist to report.
        if (err instanceof BulkScreenIntegrityError) throw err;
        // Everything else — an engine-reported failure, a dead worker, an HTTP
        // status — costs speed, not correctness: every attempt falls through to
        // `deps.sim.run` below, which measures the same question the batch
        // would have. Disclosed rather than silent.
        screeningFallbacks.push({
          candidates: attempts.length,
          reason: err instanceof Error ? err.message : String(err),
        });
        return undefined;
      }
      for (const failure of result.failures ?? []) {
        screeningFallbacks.push({
          candidates: failure.indices.length,
          reason: failure.reason,
        });
      }

      const byKey = new Map<string, SimObservation>();
      for (const row of result.rows) {
        const attempt = attempts[row.index];
        if (attempt) byKey.set(attempt.key, row.observation);
      }
      return { baselineDps: result.baseline.dps, byKey };
    }

    /**
     * One candidate's full slot-attempt loop, unchanged from the old serial
     * body except that it is now a `promisePool` task rather than one turn
     * of a `for` loop (candidate-pool.md §5.1.2) — every mutation below
     * still writes to the shared `ranked`/`candidateSkips`/
     * `individualDeltasByItemId`/`winningRequests` collections, which is
     * safe because JS interleaves at `await` points only, never inside a
     * synchronous stretch of code. Ordering downstream never depends on
     * which task finishes first: `ranked` is sorted by `deltaDps` right
     * after the pool drains, and `candidateSkips` is sorted by item id
     * before it feeds `substitutions` below — both so two runs at
     * different `concurrency` values produce byte-identical output (7.3).
     */
    async function runCandidate(entry: PoolEntry): Promise<void> {
      const owned = equippedIds.has(entry.itemId);
      const slotNames = simSlotsForPoolSlot(
        entry.slot,
        input.spec,
        entry.itemId
      );
      let best: BestSwap | null = null;

      for (let s = 0; s < slotNames.length; s++) {
        const slotName = slotNames[s]!;
        // Shared with the screening pass — see `attemptEligibility` for why the
        // two routes must agree on the attempt set, and for the reasoning behind
        // each guard.
        const eligibility = attemptEligibility(entry, slotName);
        if (eligibility.kind === "unmapped") {
          throw new Error(
            `slot mapping bug: ${entry.slot} -> ${slotName} is not in SIM_ORDER ` +
              `(item ${entry.itemId} ${entry.name})`
          );
        }
        if (eligibility.kind === "skip") continue;
        const { slotIndex } = eligibility;
        let swapped: SimItemSpec[];
        let repairSwaps: readonly MetaRepairSwap[];
        let removed: readonly { slotIndex: number; itemId: number }[];
        try {
          const outcome = candidateSwapWithRepairs(
            equipment,
            slotIndex,
            entry.itemId,
            gems
          );
          swapped = outcome.equipment;
          repairSwaps = outcome.swaps;
          removed = outcome.removed;
        } catch (err) {
          if (!(err instanceof MetaRepairError)) throw err;
          candidateSkips.push({
            kind: "repair",
            itemId: entry.itemId,
            name: entry.name,
            slot: slotName,
            reason: err.message,
          });
          continue;
        }
        const candReq = composeFor(swapped);
        // The bulk screening pass, when one ran, has already priced this exact
        // (item, slot) attempt — everything else about the attempt is computed
        // here exactly as the per-candidate path computes it, so only the DPS
        // observation differs by route. `composeFor` still runs: it is pure and
        // pre-sim, and `winningRequests` (used by `replicateTopItems`) must hold
        // the same request either way.
        // Which baseline this attempt's delta is taken against travels with the
        // observation, because the two are only meaningful as a pair: a
        // screened observation was measured alongside the screening pass's own
        // baseline probe and must be differenced against it (see
        // `screenCandidates` for the measured 65.3 DPS gap that makes mixing
        // them wrong), while a looped or cached observation belongs to
        // `baselineDps`.
        let candBaselineDps = baselineDps;
        let candObs = screened?.byKey.get(screenKey(entry.itemId, slotIndex));
        if (candObs) {
          candBaselineDps = screened!.baselineDps;
          // Stored so a re-run screens from the store instead of re-simming;
          // see `cacheScreenResult` for why this is its own key namespace.
          await cacheScreenResult(deps, candReq, simVersion, runOpts, {
            observation: candObs,
            baselineDps: candBaselineDps,
          });
        } else {
          const cachedScreen = await readCachedScreen(
            deps,
            candReq,
            simVersion,
            runOpts
          );
          if (cachedScreen) {
            candObs = cachedScreen.observation;
            candBaselineDps = cachedScreen.baselineDps;
          }
        }
        if (!candObs) {
          candObs = await readCachedSim(deps, candReq, simVersion, runOpts);
        }
        if (!candObs) {
          try {
            candObs = await deps.sim.run(candReq, runOpts);
          } catch (err) {
            candidateSkips.push({
              kind: "sim",
              itemId: entry.itemId,
              name: entry.name,
              slot: slotName,
              reason: err instanceof Error ? err.message : String(err),
            });
            continue;
          }
          await cacheSimResult(deps, candReq, simVersion, runOpts, candObs);
        }
        const deltaDps = candObs.dps - candBaselineDps;
        const note = setBreakNote(equipment, slotIndex, entry.itemId);
        if (!best || deltaDps > best.deltaDps) {
          const statDelta = statDeltaBetween(equipment, swapped);
          const next: BestSwap = {
            deltaDps,
            baselineDps: candBaselineDps,
            stdev: candObs.stdev,
            request: candReq,
            slotIndex,
            hitDriven: isHitDriven(
              statDelta,
              caps.hit,
              { deltaDps },
              input.spec
            ),
            hitRegression: hitRegression(
              statDelta,
              caps.hit,
              { deltaDps },
              input.spec
            ),
            repairSwaps,
            removed,
            candidateGems: swapped[slotIndex]?.gems ?? [],
          };
          if (slotNames.length > 1) {
            next.slotChoice = slotName;
          }
          if (note) next.setBonusNote = note;
          best = next;
        }
      }

      simsDone += 1;
      onProgress?.({ stage: "simming", done: simsDone, total: totalSims });

      if (!best) return;

      // Stored as measured, with NO re-basing onto the loop's baseline — and
      // that is the correct thing to do, which is worth stating because the
      // opposite is an inviting mistake.
      //
      // This map is combined arithmetically with a loop-measured number:
      // `buildSetBonuses` sims each package through `deps.sim.run` and
      // `computeSynergy` (set-value.ts) computes `bonusDps = (packageDps -
      // baseline) - sum(addedPieceDeltas)`. So the deltas summed here must be on
      // the same footing as that package delta. They already are. A screened
      // delta is `screenedCandidateDps - screenedBaselineDps` — a difference of
      // two readings from the SAME run — so whatever separates that run from the
      // loop's, seed or engine, cancels inside the subtraction before the value
      // is ever stored. Both routes yield an estimate of the item's own DPS
      // effect, carrying no run-specific term. The ledger measures the two
      // routes' deltas agreeing to ~0.1 DPS mean while their baselines sat 65.3
      // apart, which is that cancellation observed rather than assumed.
      //
      // Adding `(best.baselineDps - baselineDps)` here to "convert to the loop's
      // scale" would INJECT that 65.3 rather than remove it, once per added
      // piece, against real bonuses of tens of DPS — and the 2-piece result
      // compounds into the 4-piece calculation through `twoPieceBonus`. Only an
      // absolute DPS reading needs re-basing; a same-run delta does not. The
      // set-bonus assertions in `bulk-screen-branch.test.ts` pin this: they go
      // red if a scale correction is reintroduced here.
      individualDeltasByItemId.set(entry.itemId, {
        itemId: entry.itemId,
        slotIndex: best.slotIndex,
        deltaDps: best.deltaDps,
        se: best.stdev / Math.sqrt(iterations),
      });

      const deltaPct =
        best.baselineDps === 0
          ? 0
          : (best.deltaDps / best.baselineDps) * 100;
      const belowCutoff = !meetsCutoff(best.deltaDps, deltaPct, cutoff);
      const item: RankedItem = {
        rank: null,
        itemId: entry.itemId,
        name: entry.name,
        slot: entry.slot,
        source: entry.source,
        deltaDps: best.deltaDps,
        deltaPct,
        se: best.stdev / Math.sqrt(iterations),
        seMethod: "independent",
        bisTags: entry.bisTags ?? [],
        ...(entry.curatedSets ? { curatedSets: entry.curatedSets } : {}),
        ...(entry.bisSets ? { bisSets: entry.bisSets } : {}),
        belowCutoff,
      };
      if (entry.sources) item.sources = entry.sources;
      if (best.hitDriven) item.hitDriven = true;
      if (best.hitRegression) item.hitRegression = best.hitRegression;
      if (best.slotChoice) item.slotChoice = best.slotChoice;
      if (best.setBonusNote) item.setBonusNote = best.setBonusNote;
      if (best.repairSwaps.length > 0) {
        item.gemSubstitutions = best.repairSwaps.map((s) => ({
          itemId: s.itemId,
          socketIndex: s.socketIndex,
          from: s.from,
          to: s.to,
        }));
      }
      if (best.removed.length > 0) {
        item.removedItems = best.removed.map((r) => ({
          itemId: r.itemId,
          slot: SIM_ORDER[r.slotIndex] as SimSlotName,
        }));
      }
      if (owned) item.owned = true;
      if (metaSocketUnpriced(entry.itemId, best.candidateGems, gems.spec)) {
        item.emptyMetaSocket = true;
      }
      ranked.push(item);
      winningRequests.set(entry.itemId, best.request);
      onProgress?.({ kind: "row", row: item });
    }

    // Every eligible candidate gets a full-iteration sim; the cap keeps the
    // first N of the EP order plus every owned row regardless of N (§5.1.1).
    const cap = input.candidateCap ?? ordered.length;
    const simCandidates = ordered.filter(
      (e, i) => i < cap || equippedIds.has(e.itemId)
    );

    // Counted here, after the cap decides the full-iteration set.
    const replicaSims = usesPairedReplication(seeds)
      ? (seeds.length - 1) *
        (1 + Math.min(PAIRED_REPLICATE_TOP_N, simCandidates.length))
      : 0;
    const totalSims = 1 + simCandidates.length + replicaSims;
    totalSimsForProgress = totalSims;
    onProgress?.({ stage: "simming", done: simsDone, total: totalSims });

    // Stop (candidate-pool.md §5.1.4): candidates not yet dispatched when
    // `signal` aborts are simply never started — `promisePool` stops
    // pulling new tasks once it observes the abort, so this is a plain
    // pre-dispatch filter rather than cooperative cancellation of tasks
    // already in flight. Read once so an abort mid-dispatch is a clean cut
    // rather than a race between this check and the pool's own loop.
    const signal = deps.signal;

    // Cheap screening pass, when the runner offers one (batch-sim plan Step 8).
    // It supplies nothing but the DPS number for each (item, slot) attempt; the
    // per-candidate loop below still composes every request, computes every stat
    // delta and populates every row-metadata collection exactly as it always
    // has. The accurate final pass — paired-seed replication against a single
    // baseline — is untouched, so the ranking's estimand does not change.
    //
    // Absent capability, or an abort already raised, means no screening pass and
    // the loop runs exactly as before. An abort raised *during* the pass
    // is reported as `BulkScreenAbortedError` and is handled the same way: no
    // screening numbers, and the loop below dispatches nothing either.
    const screened = signal?.aborted
      ? undefined
      : await screenCandidates(simCandidates);
    const dispatchedCandidates = signal?.aborted ? [] : simCandidates;
    const tasks = dispatchedCandidates.map(
      (entry) => () => runCandidate(entry)
    );
    const concurrency = deps.concurrency ?? 1;
    let aborted = signal?.aborted ?? false;
    if (tasks.length > 0) {
      if (signal !== undefined) {
        // A cooperative check between dispatches, not preemption of a task
        // already running — promisePool's own dispatch loop calls this
        // between tasks, so nothing in flight is torn down mid-sim.
        await promisePool(
          tasks.map((task) => async () => {
            if (signal.aborted) {
              aborted = true;
              return;
            }
            await task();
          }),
          concurrency
        );
      } else {
        await promisePool(tasks, concurrency);
      }
    }
    // Re-read after the pool drains: an abort raised while the *last* task
    // was in flight skips nothing, so the loop above never sets the flag,
    // yet the run must still stop before replication and set packages
    // (§5.1.4 — completeness is "the whole flow ran", not "all candidates
    // ran").
    if (signal?.aborted) aborted = true;
    // A candidate the sim panicked on is already dropped and disclosed in
    // `substitutions` (ticket 122), and it never reaches
    // `individualDeltasByItemId` either — so filtering on that map alone
    // would re-add it here as a Stop placeholder, and the ranking would
    // both say it was dropped for a sim failure and show it as unsimmed.
    const skippedIds = new Set(candidateSkips.map((s) => s.itemId));
    const unsimmedCandidates = aborted
      ? simCandidates.filter(
          (c) =>
            !individualDeltasByItemId.has(c.itemId) && !skippedIds.has(c.itemId)
        )
      : [];
    for (const entry of unsimmedCandidates) {
      // A row Stop never reached — placeholder numbers so the row stays a
      // RankedItem, but `simmed: false` pulls it out of cutoff
      // classification and tie groups below rather than letting a zeroed
      // deltaDps masquerade as a measured one.
      ranked.push({
        rank: null,
        itemId: entry.itemId,
        name: entry.name,
        slot: entry.slot,
        source: entry.source,
        deltaDps: 0,
        deltaPct: 0,
        se: 0,
        seMethod: "independent",
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
    // below reads the same on every run at every `concurrency` (7.3).
    candidateSkips.sort((a, b) => a.itemId - b.itemId);

    const packageSimSkips: {
      setId: number;
      setName: string;
      threshold: SetThreshold;
      reason: string;
    }[] = [];

    // Set-bonus packages and paired replication both dispatch further sims
    // for refinement, not for coverage — Stop's contract is "finish
    // in-flight and stop", so once aborted, neither runs; what already
    // simmed stands, and the unsimmed rows stay honestly unsimmed rather
    // than pulling more work in behind the caller's back.
    const setBonusResult = aborted
      ? {
          bonuses: [],
          brokenSetValues: [],
          wornSetLadder: [],
          crossingGates: [],
          candidateSlotIndex: new Map(),
        }
      : await buildSetBonuses(
          deps,
          simCandidates,
          equipment,
          gems,
          race,
          input,
          composeFor,
          individualDeltasByItemId,
          { dps: baselineDps, se: observation.stdev / Math.sqrt(iterations) },
          simVersion,
          runOpts,
          packageSimSkips,
          deps.measureBrokenSetValue ?? false,
          cutoff
        );
    // With the flag, a lost count is a break only when the ladder counted it,
    // and no table is read. An aborted run has no ladder, so it charges none.
    const counts: BonusCountPredicate | undefined = deps.measureBrokenSetValue
      ? countedLadderBreaks(setBonusResult.wornSetLadder)
      : undefined;
    const setBonuses = setBonusResult.bonuses;
    // Ticket 511: with the flag, each set row is valued by the step rule.
    const stepPath = (deps.measureBrokenSetValue ?? false) && !aborted;
    if (setBonuses.length > 0) {
      applySetContext(
        ranked,
        setBonuses,
        equipment,
        setBonusResult.brokenSetValues,
        setBonusResult.candidateSlotIndex,
        individualDeltasByItemId,
        counts,
        stepPath ? { crossingGates: setBonusResult.crossingGates } : undefined
      );
    }
    // After the futures are complete and before replication rewrites the top
    // rows' `deltaDps` (C89): the step gears' sims, one per distinct gear.
    const steps =
      stepPath && setBonuses.length > 0 && counts
        ? await measureSetSteps({
            deps,
            ranked,
            setBonuses,
            equipment,
            gems,
            composeFor,
            individualDeltasByItemId,
            brokenSetValues: setBonusResult.brokenSetValues,
            candidateSlotIndex: setBonusResult.candidateSlotIndex,
            counts,
            baseline: {
              dps: baselineDps,
              se: observation.stdev / Math.sqrt(iterations),
            },
            simVersion,
            runOpts,
            floorDps: setBonusNoiseFloorDps(cutoff),
          })
        : undefined;
    onProgress?.({ stage: "ranking" });
    // Sorted first so replication can pick the contested top of the list, then
    // sorted again below — replication rewrites the very `deltaDps` this order
    // is built from, so ranking before it would freeze the ordering the
    // refinement exists to correct. Unsimmed rows sort last regardless of
    // their placeholder deltaDps (0), so an aborted run's honest-but-unsimmed
    // rows never crowd out real deltas at the top of the list.
    // Tiebreak matches view.ts's compareRows (bisTags richness, then itemId)
    // so the stamped rank and the rendered row order agree inside exact
    // delta ties (ticket 279) -- but only while the view sorts on raw
    // deltaDps: with set-potential on, compareRows keys on deltaDps +
    // rankableSetPotential and the two orders can still diverge (repo
    // ticket 287).
    const bySimmedThenDelta = (a: RankedItem, b: RankedItem): number => {
      if (a.simmed === false && b.simmed !== false) return 1;
      if (b.simmed === false && a.simmed !== false) return -1;
      if (a.deltaDps !== b.deltaDps) return b.deltaDps - a.deltaDps;
      const richness = b.bisTags.length - a.bisTags.length;
      if (richness !== 0) return richness;
      return a.itemId - b.itemId;
    };
    ranked.sort(bySimmedThenDelta);
    if (!aborted) await replicateTopItems(ranked, winningRequests, baselineDps);
    ranked.sort(bySimmedThenDelta);

    let rank = 1;
    for (const item of ranked) {
      // Stop left this row unsimmed — excluded from cutoff classification
      // and tie groups (candidate-pool.md §5.1.4): there is no measured
      // delta to classify or group.
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
      rows: ranked.map((i) => ({
        itemId: i.itemId,
        name: i.name,
        slot: i.slot,
        deltaDps: i.deltaDps,
        ...(i.owned === true ? { owned: true } : {}),
      })),
      wornSetCounts: setCounts(equipment),
      ...(counts ? { counts } : {}),
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
      caps,
      substitutions: [
        ...substitutionsFromMetaRepair(metaSwaps),
        ...metaPreferenceDisclosure(gems.spec),
        ...candidateSkips.map((s) => ({
          field: `candidate ${s.itemId} (${s.slot})`,
          detail:
            `${s.name} was dropped from the ranking: ` +
            (s.kind === "sim"
              ? `the sim failed on this swap — ${s.reason}`
              : `gem repair could not activate its meta — ${s.reason}`),
        })),
        ...packageSimSkips.map((s) => ({
          field: `${s.setName} ${s.threshold}pc completion package`,
          detail:
            `the ${s.setName} ${s.threshold}pc completion package could not ` +
            `be measured: ${s.reason}`,
        })),
      ],
      items: ranked,
      ...(setBonuses.length > 0 ? { setBonuses } : {}),
      ...(setBonusResult.brokenSetValues.length > 0
        ? { brokenSetValues: setBonusResult.brokenSetValues }
        : {}),
      ...(setBonusResult.wornSetLadder.length > 0
        ? { wornSetLadder: setBonusResult.wornSetLadder }
        : {}),
      ...(setBonusResult.crossingGates.length > 0
        ? { crossingGates: setBonusResult.crossingGates }
        : {}),
      ...(steps ? { setStepSims: steps.setStepSims } : {}),
      ...(steps?.partnerAudit ? { partnerAudit: steps.partnerAudit } : {}),
      ...(warnings.length > 0 ? { plausibilityWarnings: warnings } : {}),
      ...(screeningFallbacks.length > 0 ? { screeningFallbacks } : {}),
    };

    if (aborted) {
      // No ranking-cache row for a partial run (candidate-pool.md §5.1.4) —
      // the type only permits `complete: true` there, so this branch is the
      // enforcement, not a convention a future edit could quietly drop.
      // Per-sim rows already landed via `cacheSimResult` inside
      // `runCandidate`, so a re-run still resumes cheaply.
      const partial: PartialRanking = { ...rankingBase, complete: false };
      await deps.store.job.update(job.id, {
        status: "done",
        result: partial,
      });
      return partial;
    }

    const ranking: Ranking = { ...rankingBase, complete: true };
    await deps.store.put(rankingCacheKey(contentHash), ranking);
    await deps.store.job.update(job.id, {
      status: "done",
      result: ranking,
    });
    return ranking;
  }

  async function replicateTopItems(
    ranked: RankedItem[],
    winningRequests: ReadonlyMap<number, RaidSimRequest>,
    baselineDps: number
  ): Promise<void> {
    if (!usesPairedReplication(seeds)) return;

    const top = ranked
      .filter((item) => !item.belowCutoff && item.simmed !== false)
      .slice(0, PAIRED_REPLICATE_TOP_N);
    if (top.length === 0) return;
    const baselineBySeed = new Map<number, number>();
    for (const s of seeds) {
      baselineBySeed.set(s, (await simFor(request, s)).dps);
      bumpProgress(s);
    }

    for (const item of top) {
      const candReq = winningRequests.get(item.itemId);
      if (!candReq) {
        throw new RankError(
          "internal",
          `no recorded request for ranked item ${item.itemId} (${item.name}); ` +
            `paired replication cannot re-sim it`
        );
      }
      const deltas: number[] = [];
      for (const s of seeds) {
        const obs = await simFor(candReq, s);
        deltas.push(obs.dps - baselineBySeed.get(s)!);
        bumpProgress(s);
      }
      item.se = pairedReplicateSe(deltas);
      item.seMethod = "paired-replicate";
      item.deltaDps = deltas.reduce((sum, d) => sum + d, 0) / deltas.length;
      item.deltaPct =
        baselineDps === 0 ? 0 : (item.deltaDps / baselineDps) * 100;
      item.belowCutoff = !meetsCutoff(item.deltaDps, item.deltaPct, cutoff);
    }
  }

  function bumpProgress(seedForRun: number): void {
    if (seedForRun === seeds[0]) return;
    simsDone += 1;
    onProgress?.({
      stage: "simming",
      done: simsDone,
      total: totalSimsForProgress,
    });
  }

  async function simFor(
    req: RaidSimRequest,
    seedForRun: number
  ): Promise<SimObservation> {
    const opts = { seed: seedForRun, iterations };
    const cached = await readCachedSim(deps, req, simVersion, opts);
    if (cached) return cached;
    let obs: SimObservation;
    try {
      obs = await deps.sim.run(req, opts);
    } catch (err) {
      throw new RankError(
        "sim-failed",
        err instanceof Error ? err.message : String(err)
      );
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
   * `rankUpgrades`'s own compose helper, passed in rather than rebuilt here:
   * a second copy drifts silently, since no test covers both call sites
   * (ticket 212 review). Every composed request must carry the database its
   * own equipment needs.
   */
  composeFor: (equipment: readonly SimItemSpec[]) => RaidSimRequest,
  individualDeltasByItemId: ReadonlyMap<number, IndividualDelta>,
  baseline: DpsSample,
  simVersion: string,
  runOpts: SimRunOpts,
  packageSimSkips: {
    setId: number;
    setName: string;
    threshold: SetThreshold;
    reason: string;
  }[],
  /**
   * When set, measure every worn set's bonuses with the ladder, charge only
   * the counted ones as breaks, and gate each package's bonus (tickets 467,
   * 511 and 512). Off in the E-W3 harness so the compared request list is
   * unchanged.
   */
  measureBrokenSetValue: boolean,
  /** The ranking's cutoff, for the noise floor of the ladder's gate. */
  cutoff: Cutoff
): Promise<{
  bonuses: SetBonusValue[];
  brokenSetValues: BrokenSetValue[];
  wornSetLadder: WornSetLadderEntry[];
  crossingGates: CrossingGate[];
  /** itemId -> best pool slotIndex, so `applySetContext` can compute per-row breaks. */
  candidateSlotIndex: Map<number, number>;
}> {
  // The set sims' own store-cached run. A gate or ladder request sends
  // copies, so it is never a request the store already holds (tickets 511
  // and 512).
  const cachedSampleRun =
    (what: string) =>
    async (request: RaidSimRequest): Promise<DpsSample> => {
      let obs = await readCachedSim(deps, request, simVersion, runOpts);
      if (!obs) {
        try {
          obs = await deps.sim.run(request, runOpts);
        } catch (err) {
          console.warn(`[upgrades] ${what} not measured: the sim failed`, err);
          throw err;
        }
        await cacheSimResult(deps, request, simVersion, runOpts, obs);
      }
      return { dps: obs.dps, se: obs.stdev / Math.sqrt(runOpts.iterations) };
    };

  // Ticket 512: the value of every bonus each worn set has, on the player's
  // own gear, before any package is built, so every break below reads the
  // gated measurement instead of a table. It runs even when no set piece is a
  // candidate, because the dead-slot check reads it too.
  const wornSetLadder = measureBrokenSetValue
    ? await measureWornSetLadders(
        equipment,
        composeFor,
        cachedSampleRun,
        setBonusNoiseFloorDps(cutoff)
      )
    : [];
  const counts: BonusCountPredicate = measureBrokenSetValue
    ? countedLadderBreaks(wornSetLadder)
    : isBonusImplemented;
  const brokenSetValues: BrokenSetValue[] = wornSetLadder
    .filter((e) => e.counted)
    .sort((a, b) => (a.setId !== b.setId ? a.setId - b.setId : b.count - a.count))
    .map((e) => ({
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
  if (setIdsWithCandidates.size === 0) {
    return {
      bonuses: [],
      brokenSetValues,
      wornSetLadder,
      crossingGates: [],
      candidateSlotIndex: new Map(),
    };
  }

  const wornCounts = setCounts(equipment);
  const slotIndexForPoolEntry = (entry: PoolEntry): number | undefined => {
    for (const slotName of simSlotsForPoolSlot(
      entry.slot,
      input.spec,
      entry.itemId
    )) {
      const idx = SIM_ORDER.indexOf(slotName);
      if (idx >= 0) return idx;
    }
    return undefined;
  };

  const floorDps = setBonusNoiseFloorDps(cutoff);
  const selectFor = (setId: number, threshold: SetThreshold) =>
    selectPackage(
      setId,
      threshold,
      equipment,
      candidates,
      [...individualDeltasByItemId.values()],
      slotIndexForPoolEntry
    );
  // Ticket 511, flag only: every count from one above the worn count up to
  // the count the pool can fill, with no list of which counts have a bonus.
  // The same-gear gate below decides which are bonuses here.
  const reachableCounts = (setId: number, piecesWorn: number): SetThreshold[] => {
    const counts: SetThreshold[] = [];
    for (let t = Math.max(2, piecesWorn + 1); selectFor(setId, t).ok; t++) {
      counts.push(t);
    }
    return counts;
  };

  const results: SetBonusValue[] = [];
  for (const setId of setIdsWithCandidates) {
    const piecesWorn = wornCounts.get(setId) ?? 0;
    const label = setLabel(
      equipment,
      setId,
      candidates.map((entry) => entry.itemId)
    );
    let twoPieceBonus: number | undefined;
    let twoPieceUnmeasurableAtThisWornCount = false;
    // Flag only (C31): a 4pc's raw value subtracts the 2pc's, so it is left
    // unset when the 2pc package was attempted and failed.
    let twoPieceFailed = false;

    const thresholds = measureBrokenSetValue
      ? reachableCounts(setId, piecesWorn)
      : SET_THRESHOLDS.filter((t) => t > piecesWorn);
    if (measureBrokenSetValue && thresholds.length === 0) {
      // No count is in reach. One entry still marks the set, so its rows keep
      // their single breaks and crossing in `setContext`; it is never a future.
      results.push({
        setId,
        setName: label,
        threshold: Math.max(2, piecesWorn + 1),
        piecesWorn,
        packageItemIds: [],
        packageDeltaDps: 0,
        unmeasured: "insufficient-pieces",
      });
      continue;
    }

    for (const threshold of thresholds) {
      if (!measureBrokenSetValue && !isBonusImplemented(setId, threshold)) {
        results.push({
          setId,
          setName: label,
          threshold,
          piecesWorn,
          packageItemIds: [],
          packageDeltaDps: 0,
          unmeasured: "not-implemented-in-sim",
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
          unmeasured: "insufficient-pieces",
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
          packageItemIds: addedPieces.map((p) => p.itemId),
          packageDeltaDps: 0,
          unmeasured: "unmeasurable-at-this-worn-count",
        });
        continue;
      }
      let packageEquipment: SimItemSpec[] = [...equipment];
      const packageRepairSwaps: MetaRepairSwap[] = [];
      try {
        for (const piece of addedPieces) {
          const outcome = candidateSwapWithRepairs(
            packageEquipment,
            piece.slotIndex,
            piece.itemId,
            gems
          );
          packageEquipment = outcome.equipment;
          const packageSlots = new Set(addedPieces.map((p) => p.slotIndex));
          packageRepairSwaps.push(
            ...outcome.swaps.filter((s) => !packageSlots.has(s.itemIndex))
          );
        }
      } catch (err) {
        if (!(err instanceof MetaRepairError)) throw err;
        console.warn(
          `[upgrades] ${label} ${threshold}pc bonus package not measured: gem repair failed`,
          err
        );
        packageSimSkips.push({
          setId,
          setName: label,
          threshold,
          reason: `gem repair could not activate its meta — ${err.message}`,
        });
        results.push({
          setId,
          setName: label,
          threshold,
          piecesWorn,
          packageItemIds: addedPieces.map((p) => p.itemId),
          packageDeltaDps: 0,
          unmeasured: "repair-failed",
        });
        if (threshold === 2) twoPieceFailed = true;
        continue;
      }
      const packageRequest = composeFor(packageEquipment);

      // Ticket 511, flag only: the gate runs before the package sim, so a
      // count with no bonus on this gear costs its two gate sims and nothing
      // else. It does not need the package's result.
      let sameGear: DpsSample | undefined;
      if (measureBrokenSetValue) {
        sameGear = await measureSameGearBonus(
          cachedSampleRun(`${label} ${threshold}pc same-gear bonus`),
          packageRequest,
          packageEquipment.flatMap((spec, i) =>
            spec.id && getItem(spec.id)?.setId === setId ? [i] : []
          ),
          threshold - 1
        );
        if (!sameGear) {
          packageSimSkips.push({
            setId,
            setName: label,
            threshold,
            reason: "the same-gear sims of its bonus failed",
          });
          results.push({
            setId,
            setName: label,
            threshold,
            piecesWorn,
            packageItemIds: addedPieces.map((p) => p.itemId),
            packageDeltaDps: 0,
            unmeasured: "sim-failed",
          });
          if (threshold === 2) twoPieceFailed = true;
          continue;
        }
        if (!clearsSameGearGate(sameGear.dps, sameGear.se, floorDps)) {
          results.push({
            setId,
            setName: label,
            threshold,
            piecesWorn,
            packageItemIds: addedPieces.map((p) => p.itemId),
            packageDeltaDps: 0,
            sameGearDps: sameGear.dps,
            sameGearSe: sameGear.se,
            belowGate: true,
          });
          continue;
        }
      }
      const gateFields = sameGear
        ? { sameGearDps: sameGear.dps, sameGearSe: sameGear.se }
        : {};

      let packageObs = await readCachedSim(
        deps,
        packageRequest,
        simVersion,
        runOpts
      );
      if (!packageObs) {
        try {
          packageObs = await deps.sim.run(packageRequest, runOpts);
        } catch (err) {
          console.warn(
            `[upgrades] ${label} ${threshold}pc bonus package not measured: the sim failed`,
            err
          );
          packageSimSkips.push({
            setId,
            setName: label,
            threshold,
            reason: `the sim failed — ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
          results.push({
            setId,
            setName: label,
            threshold,
            piecesWorn,
            packageItemIds: addedPieces.map((p) => p.itemId),
            packageDeltaDps: 0,
            ...gateFields,
            unmeasured: "sim-failed",
          });
          if (threshold === 2) twoPieceFailed = true;
          continue;
        }
        await cacheSimResult(
          deps,
          packageRequest,
          simVersion,
          runOpts,
          packageObs
        );
      }

      const addedPieceSamples = addedPieces.map((p) => {
        const individual = individualDeltasByItemId.get(p.itemId);
        return {
          deltaDps: individual?.deltaDps ?? 0,
          se: individual?.se ?? 0,
        };
      });
      const packageSample: DpsSample = {
        dps: packageObs.dps,
        se: packageObs.stdev / Math.sqrt(runOpts.iterations),
      };
      const synergy = computeSynergy({
        baseline,
        packageSample,
        addedPieceSamples,
        ...(threshold === 4 && twoPieceBonus !== undefined
          ? { twoPieceBonus }
          : {}),
      });
      if (threshold === 2) twoPieceBonus = synergy.bonusDps;

      const breaks = brokenSetBonuses(equipment, addedPieces, setId, counts);
      let selfConfound: SelfSetConfound | undefined =
        threshold === 4 && twoPieceUnmeasurableAtThisWornCount
          ? { threshold: 2 }
          : undefined;
      if (selfConfound) {
        // Ticket 492. At worn 1 the 2pc package is one piece, so the 2pc is
        // never measured, and every single of the 4pc package crosses the
        // 2pc: raw4 = B4 − (n−1)·B2 for n added pieces. Two added pieces
        // simmed together end at 3 worn with only the 2pc active, so
        // B2 = Σ(their singles) − their pair delta. A break of another worn
        // set would sit in the singles and the pair unequally and bias B2, so
        // each piece must be break-free alone and the two together: worn
        // Malorne 3, two break-free singles still take it to 1 as a pair.
        // With no such pair `bonusDpsNet` stays unset (see below).
        const breakFree = addedPieces.filter(
          (p) =>
            brokenSetBonuses(equipment, [p], setId, counts).length === 0 &&
            individualDeltasByItemId.has(p.itemId)
        );
        const pair = breakFree
          .flatMap((a, i) => breakFree.slice(i + 1).map((b) => [a, b]))
          .find(
            (p) => brokenSetBonuses(equipment, p, setId, counts).length === 0
          );
        const pairB2 =
          pair !== undefined
            ? await measurePairTwoPiece(
                `${label} ${threshold}pc`,
                deps,
                pair,
                equipment,
                gems,
                composeFor,
                individualDeltasByItemId,
                baseline,
                simVersion,
                runOpts
              )
            : undefined;
        if (pairB2) {
          const extra = addedPieces.length - 1;
          synergy.bonusDps += extra * pairB2.dps;
          synergy.se = Math.sqrt(synergy.se ** 2 + (extra * pairB2.se) ** 2);
          selfConfound = { threshold: 2, dps: pairB2.dps };
        }
      }
      const missingTwoPiece =
        measureBrokenSetValue && threshold === 4 && twoPieceFailed;
      results.push({
        setId,
        setName: label,
        threshold,
        piecesWorn,
        packageItemIds: addedPieces.map((p) => p.itemId),
        packageDeltaDps: synergy.packageDeltaDps,
        ...(missingTwoPiece
          ? {}
          : { bonusDps: synergy.bonusDps, se: synergy.se }),
        ...gateFields,
        ...(breaks.length > 0 ? { breaks } : {}),
        ...(selfConfound ? { selfConfound } : {}),
        ...(packageRepairSwaps.length > 0
          ? {
              gemSubstitutions: packageRepairSwaps.map((s) => ({
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

  // Ticket 511, flag only: whether one more piece of a worn set reaches a
  // bonus, measured on the gear a row actually makes. One gate per worn set
  // with a candidate in a slot the set does not fill, on that set's best such
  // candidate's own swap, so a row's "crosses" label reads a measurement
  // rather than the six-set table.
  const crossingGates: CrossingGate[] = [];
  if (measureBrokenSetValue) {
    for (const setId of [...setIdsWithCandidates].sort((a, b) => a - b)) {
      const worn = wornCounts.get(setId) ?? 0;
      if (worn < 1) continue;
      const wornSlots = new Set(
        equipment.flatMap((spec, i) =>
          spec.id && getItem(spec.id)?.setId === setId ? [i] : []
        )
      );
      let best: IndividualDelta | undefined;
      for (const entry of candidates) {
        if (getItem(entry.itemId)?.setId !== setId) continue;
        const single = individualDeltasByItemId.get(entry.itemId);
        if (!single || wornSlots.has(single.slotIndex)) continue;
        if (
          !best ||
          single.deltaDps > best.deltaDps ||
          (single.deltaDps === best.deltaDps && single.itemId < best.itemId)
        ) {
          best = single;
        }
      }
      if (!best) continue;
      let swapped: SimItemSpec[] | undefined;
      try {
        swapped = candidateSwapWithRepairs(
          equipment,
          best.slotIndex,
          best.itemId,
          gems
        ).equipment;
      } catch (err) {
        if (!(err instanceof MetaRepairError)) throw err;
      }
      const value = swapped
        ? await measureSameGearBonus(
            cachedSampleRun(
              `${setLabel(equipment, setId)} ${worn + 1}pc crossing gate`
            ),
            composeFor(swapped),
            swapped.flatMap((spec, i) =>
              spec.id && getItem(spec.id)?.setId === setId ? [i] : []
            ),
            worn
          )
        : undefined;
      crossingGates.push({
        setId,
        count: worn + 1,
        itemId: best.itemId,
        ...(value ? { dps: value.dps, se: value.se } : {}),
        cleared:
          value !== undefined &&
          clearsSameGearGate(value.dps, value.se, floorDps),
      });
    }
  }

  const candidateSlotIndex = new Map<number, number>();
  for (const entry of candidates) {
    const idx = slotIndexForPoolEntry(entry);
    if (idx === undefined) continue;
    if (!candidateSlotIndex.has(entry.itemId)) {
      candidateSlotIndex.set(entry.itemId, idx);
    }
  }

  // Correct `bonusDps` for ticket 90's inflation using the measured B.
  //
  // `computeSynergy` builds `bonusDps = pkgΔ − Σsingles − raw2pc`. A worn bonus
  // (X, t') that the package breaks puts a −B term in each input:
  //   • pkgΔ holds −B once iff this package's END STATE breaks it (`pkgEnd`);
  //   • each member single that breaks it holds −B, subtracted: +B per member
  //     (`membersPkg`);
  //   • the raw 2pc (subtracted by the 4pc only) carries its own inflation
  //     `(members2pc − twoPcEnd)·B`, which the subtraction negates.
  // So `I = Σ (membersPkg − members2pc − pkgEnd + twoPcEnd)·B` over every lost
  // threshold (`netInflation`), and `bonusDpsNet = bonusDps − I`. Reading each
  // package's own `breaks` (its measured end state) keeps this right when the
  // 2pc and 4pc packages pick different slots (ticket 467).
  //
  // Ticket 478 A3: the earlier form subtracted `twoPcEnd`. The two agree at worn
  // Malorne 4, where `members2pc − twoPcEnd = 2 − 1 = 1 = twoPcEnd`, and differ
  // at worn 5 (net4 180 instead of 80; fixture 476-B). The keys are the union of
  // this package's breaks, the 2pc package's breaks, and every member single's
  // breaks. Today the 2pc package is a prefix of the 4pc and a member single
  // never breaks what its package keeps, so the union equals this package's own
  // `breaks`; it is kept so the formula stays whole if package selection changes.
  const bBy = new Map<string, number | undefined>();
  for (const v of brokenSetValues) bBy.set(`${v.setId}:${v.threshold}`, v.dps);
  const breakKey = (b: Pick<BrokenSetBonus, "setId" | "threshold">) =>
    `${b.setId}:${b.threshold}`;
  const memberSingleBreaks = (pkg: SetBonusValue): BrokenSetBonus[] =>
    pkg.packageItemIds.flatMap((itemId) => {
      const slotIndex = candidateSlotIndex.get(itemId);
      const memberSetId = getItem(itemId)?.setId;
      if (slotIndex === undefined || memberSetId == null) return [];
      return brokenSetBonuses(
        equipment,
        [{ itemId, slotIndex }],
        memberSetId,
        counts
      );
    });
  for (const b of results) {
    if (b.bonusDps === undefined) continue;
    // A worn-1 4pc whose 2pc the pair sim did not measure still carries
    // `−(n−1)·B2`. Crediting it would rank rows on a confounded figure, so
    // the net stays unset and the row shows as not counted.
    if (b.selfConfound !== undefined && b.selfConfound.dps === undefined) {
      continue;
    }
    // The 4pc subtracts a measured raw 2pc; only then do the 2pc terms apply.
    const two =
      b.threshold === 4
        ? results.find(
            (r) =>
              r.setId === b.setId &&
              r.threshold === 2 &&
              r.unmeasured === undefined &&
              r.bonusDps !== undefined
          )
        : undefined;
    const union = new Map<string, BrokenSetBonus>();
    for (const brk of [
      ...(b.breaks ?? []),
      ...(two?.breaks ?? []),
      ...memberSingleBreaks(b),
      ...(two ? memberSingleBreaks(two) : []),
    ]) {
      union.set(breakKey(brk), brk);
    }
    const pkgEnd = new Set((b.breaks ?? []).map(breakKey));
    const twoPcEnd = new Set((two?.breaks ?? []).map(breakKey));
    const keys: InflationKey[] = [];
    let allMeasured = true;
    for (const [key, brk] of union) {
      const B = bBy.get(key);
      if (B === undefined) {
        allMeasured = false;
        break;
      }
      keys.push({
        setId: brk.setId,
        threshold: brk.threshold,
        membersPkg: countMembersBreaking(
          b,
          brk,
          equipment,
          candidateSlotIndex,
          counts
        ),
        members2pc: two
          ? countMembersBreaking(two, brk, equipment, candidateSlotIndex, counts)
          : 0,
        pkgEnd: pkgEnd.has(key) ? 1 : 0,
        twoPcEnd: twoPcEnd.has(key) ? 1 : 0,
        B,
      });
    }
    if (allMeasured) b.bonusDpsNet = b.bonusDps - netInflation(keys);
  }

  return {
    bonuses: results,
    brokenSetValues,
    wornSetLadder,
    crossingGates,
    candidateSlotIndex,
  };
}

/**
 * The step-sim phase of a step ranking (ticket 511). For each set row and each
 * future whose same-gear gate cleared, `choosePartnerSet` picks the partner
 * pieces once, and the row's step gear — the current gear plus the row plus
 * those pieces, folded in slot order with the same gem repairs as every other
 * swap — is simmed once per distinct gear. A future's `stepGearDps` is that
 * sim minus the baseline. A failed choice, repair or sim leaves the future
 * without it, which makes the row unmeasured; it never fails the ranking.
 */
async function measureSetSteps(args: {
  deps: Deps;
  ranked: RankedItem[];
  setBonuses: readonly SetBonusValue[];
  equipment: readonly SimItemSpec[];
  gems: GemContext;
  composeFor: (equipment: readonly SimItemSpec[]) => RaidSimRequest;
  individualDeltasByItemId: ReadonlyMap<number, IndividualDelta>;
  brokenSetValues: readonly BrokenSetValue[];
  candidateSlotIndex: ReadonlyMap<number, number>;
  counts: BonusCountPredicate;
  baseline: DpsSample;
  simVersion: string;
  runOpts: SimRunOpts;
  floorDps: number;
}): Promise<{ setStepSims: SetStepSims; partnerAudit?: PartnerAuditEntry[] }> {
  const { deps, equipment, gems, composeFor, counts, baseline, runOpts } = args;
  const rule = deps.partnerRule ?? PARTNER_RULE;
  const bBy = new Map<string, number | undefined>();
  for (const v of args.brokenSetValues) {
    bBy.set(`${v.setId}:${v.threshold}`, v.dps);
  }
  const nameOf = new Map(args.ranked.map((r) => [r.itemId, r.name]));
  let simmed = 0;
  let fromStore = 0;

  /** A store hit, else a sim; undefined when the sim fails. */
  const runCounted = async (
    request: RaidSimRequest
  ): Promise<{ totalDps: number; se: number } | undefined> => {
    let obs = await readCachedSim(deps, request, args.simVersion, runOpts);
    if (obs) {
      fromStore += 1;
    } else {
      try {
        obs = await deps.sim.run(request, runOpts);
      } catch (err) {
        console.warn(
          "[upgrades] set step gear not measured: the sim failed",
          err
        );
        return undefined;
      }
      simmed += 1;
      await cacheSimResult(deps, request, args.simVersion, runOpts, obs);
    }
    const se = obs.stdev / Math.sqrt(runOpts.iterations);
    return {
      totalDps: obs.dps - baseline.dps,
      se: Math.sqrt(se ** 2 + baseline.se ** 2),
    };
  };

  /** The step gear's request, or undefined when a gem repair fails. */
  const stepGear = (
    swaps: readonly PackagePiece[]
  ): RaidSimRequest | undefined => {
    let gear: SimItemSpec[] = [...equipment];
    try {
      for (const p of [...swaps].sort((a, b) => a.slotIndex - b.slotIndex)) {
        gear = candidateSwapWithRepairs(gear, p.slotIndex, p.itemId, gems)
          .equipment;
      }
    } catch (err) {
      if (!(err instanceof MetaRepairError)) throw err;
      return undefined;
    }
    return composeFor(gear);
  };

  type Future = NonNullable<SetContext["futureBonuses"]>[number];
  const requests = new Map<string, RaidSimRequest>();
  const pending: Array<{ future: Future; key: string }> = [];
  const audits: PartnerAuditEntry[] = [];

  for (const item of args.ranked) {
    const ctx = item.setContext;
    if (!ctx) continue;
    const single = args.individualDeltasByItemId.get(item.itemId);
    if (!single) continue;
    ctx.singleDeltaDps = single.deltaDps;
    const eligible = (ctx.futureBonuses ?? []).filter(
      (f) =>
        !f.belowGate &&
        f.sameGearDps !== undefined &&
        clearsSameGearGate(f.sameGearDps, f.sameGearSe ?? 0, args.floorDps)
    );
    if (eligible.length === 0) continue;

    const setId = ctx.setId;
    const wornSetSlots = new Set(
      equipment.flatMap((spec, i) =>
        spec.id && getItem(spec.id)?.setId === setId ? [i] : []
      )
    );
    const pieces: PartnerPiece[] = [];
    for (const [itemId, slotIndex] of args.candidateSlotIndex) {
      if (itemId === item.itemId || getItem(itemId)?.setId !== setId) continue;
      const delta = args.individualDeltasByItemId.get(itemId);
      if (!delta) continue;
      pieces.push({ itemId, slotIndex, singleDeltaDps: delta.deltaDps });
    }
    const pool = partnerPool({
      pieces,
      wornSetSlots,
      rowSlotIndex: single.slotIndex,
    });
    const rowSwap: PackagePiece = {
      itemId: item.itemId,
      slotIndex: single.slotIndex,
    };
    const lostBy = (swaps: readonly PackagePiece[]) =>
      brokenSetBonuses(equipment, swaps, setId, counts);

    for (const f of eligible) {
      const entry = args.setBonuses.find(
        (b) => b.setId === setId && b.threshold === f.threshold
      );
      const pathSlot = args.candidateSlotIndex.get(item.itemId);
      const todaysPieces =
        entry && entry.packageItemIds.length > 0 && pathSlot !== undefined
          ? pathToThreshold(
              item.itemId,
              pathSlot,
              entry,
              args.candidateSlotIndex,
              args.individualDeltasByItemId
            ).filter((p) => p.itemId !== item.itemId)
          : undefined;
      const choice = await choosePartnerSet(
        {
          row: {
            itemId: item.itemId,
            slotIndex: single.slotIndex,
            singleDeltaDps: single.deltaDps,
          },
          setId,
          count: f.threshold,
          needed: f.threshold - ctx.piecesAfterSwap,
          pool,
          lostBy,
          breakDps: (s, c) => bBy.get(`${s}:${c}`),
          ...(todaysPieces ? { todaysPieces } : {}),
          simGear: async (partners) => {
            const request = stepGear([rowSwap, ...partners]);
            return request ? runCounted(request) : undefined;
          },
        },
        rule
      );
      // On a step ranking an eligible future's `pieces` and `breaks` are its
      // partner choice's, so the ticket 502 path's are dropped first.
      delete f.pieces;
      delete f.breaks;
      if (choice === undefined) continue;
      if ("unmeasured" in choice) {
        f.partnerUnmeasured = choice.unmeasured;
        continue;
      }
      if (choice.audit) {
        audits.push({
          itemId: item.itemId,
          setId,
          count: f.threshold,
          audit: choice.audit,
        });
      }
      const slotOf = new Map<number, number>();
      for (const p of [...pool, ...(todaysPieces ?? [])]) {
        slotOf.set(p.itemId, p.slotIndex);
      }
      const partners: PackagePiece[] = choice.itemIds
        .map((itemId) => ({ itemId, slotIndex: slotOf.get(itemId)! }))
        .sort((a, b) => a.slotIndex - b.slotIndex);
      f.partnerRule = rule;
      f.pieces = partners.map((p) => ({
        itemId: p.itemId,
        name: nameOf.get(p.itemId) ?? String(p.itemId),
      }));
      // Every counted worn bonus the step gear loses against the current
      // gear, the row's own break included: the popover line is a total over
      // the current gear.
      const lost = lostBy([rowSwap, ...partners]);
      if (lost.length > 0) {
        f.breaks = lost.map((brk) => {
          const dps = bBy.get(`${brk.setId}:${brk.threshold}`);
          return {
            setId: brk.setId,
            setName: brk.setName,
            threshold: brk.threshold,
            ...(dps !== undefined ? { dps } : {}),
          };
        });
      }
      const request = stepGear([rowSwap, ...partners]);
      if (!request) continue;
      const key = simCacheKey(request, args.simVersion, runOpts);
      requests.set(key, request);
      pending.push({ future: f, key });
    }
  }

  // Identical step gears are simmed once. Each task handles its own sim
  // failure, so one failed sim leaves only its own futures unmeasured (C170).
  const totals = new Map<string, { totalDps: number; se: number }>();
  const keys = [...requests.keys()];
  await promisePool(
    keys.map((key) => async () => {
      const total = await runCounted(requests.get(key)!);
      if (total) totals.set(key, total);
    }),
    deps.concurrency ?? 1
  );
  for (const { future, key } of pending) {
    const total = totals.get(key);
    if (!total) continue;
    future.stepGearDps = total.totalDps;
    future.stepGearSe = total.se;
  }

  return {
    setStepSims: { partnerRule: rule, gears: keys.length, simmed, fromStore },
    ...(rule === "every-combination" ? { partnerAudit: audits } : {}),
  };
}

/**
 * The highest measured, non-empty package of one set: the package a row's
 * `commitBreaks` completes, and a source of measurement targets (ticket 477).
 */
function topMeasuredPackage(
  bonusesForSet: readonly SetBonusValue[]
): SetBonusValue | undefined {
  // `!belowGate` (C198): a below-gate entry has package ids but no package
  // sim, so it is never a measured package (ticket 511).
  return [...bonusesForSet]
    .filter(
      (b) =>
        b.unmeasured === undefined &&
        !b.belowGate &&
        b.packageItemIds.length > 0
    )
    .sort((a, b) => b.threshold - a.threshold)[0];
}

/**
 * The worn bonuses broken by the top package with `itemId` substituted into
 * its own slot (the package's piece in that slot, if any, is dropped). Shared
 * by `applySetContext`'s `commitBreaks` and the B target discovery, so every
 * break a row shows is one the engine tried to measure (ticket 477).
 */
function substitutedPackageBreaks(
  itemId: number,
  setId: number,
  slotIndex: number,
  topPackage: SetBonusValue,
  candidateSlotIndex: ReadonlyMap<number, number>,
  equipment: readonly SimItemSpec[],
  counts: BonusCountPredicate
): BrokenSetBonus[] {
  const substituted: PackagePiece[] = topPackage.packageItemIds
    .map((pieceItemId) => ({
      itemId: pieceItemId,
      slotIndex: candidateSlotIndex.get(pieceItemId),
    }))
    .filter(
      (p): p is PackagePiece =>
        p.slotIndex !== undefined && p.slotIndex !== slotIndex
    );
  substituted.push({ itemId, slotIndex });
  return brokenSetBonuses(equipment, substituted, setId, counts);
}

/**
 * One sim of two break-free set pieces added together at worn 1, giving the
 * 2pc value `B2 = Σ singles − pair delta` (ticket 492). Undefined when the gem
 * repair or the sim fails; the caller then keeps the raw 4pc `bonusDps` and
 * leaves its `bonusDpsNet` unset.
 */
async function measurePairTwoPiece(
  bonusLabel: string,
  deps: Deps,
  pair: readonly PackagePiece[],
  equipment: readonly SimItemSpec[],
  gems: GemContext,
  composeFor: (equipment: readonly SimItemSpec[]) => RaidSimRequest,
  individualDeltasByItemId: ReadonlyMap<number, IndividualDelta>,
  baseline: DpsSample,
  simVersion: string,
  runOpts: SimRunOpts
): Promise<{ dps: number; se: number } | undefined> {
  let pairEquipment: SimItemSpec[] = [...equipment];
  try {
    for (const piece of pair) {
      pairEquipment = candidateSwapWithRepairs(
        pairEquipment,
        piece.slotIndex,
        piece.itemId,
        gems
      ).equipment;
    }
  } catch (err) {
    if (!(err instanceof MetaRepairError)) throw err;
    console.warn(
      `[upgrades] ${bonusLabel} net value not measured: gem repair failed for the worn-1 pair that measures the 2pc`,
      err
    );
    return undefined;
  }
  const request = composeFor(pairEquipment);
  let obs = await readCachedSim(deps, request, simVersion, runOpts);
  if (!obs) {
    try {
      obs = await deps.sim.run(request, runOpts);
    } catch (err) {
      console.warn(
        `[upgrades] ${bonusLabel} net value not measured: the sim failed for the worn-1 pair that measures the 2pc`,
        err
      );
      return undefined;
    }
    await cacheSimResult(deps, request, simVersion, runOpts, obs);
  }
  const singles = pair.map((p) => individualDeltasByItemId.get(p.itemId)!);
  const pairSample: DpsSample = {
    dps: obs.dps,
    se: obs.stdev / Math.sqrt(runOpts.iterations),
  };
  return {
    dps:
      singles.reduce((sum, s) => sum + s.deltaDps, 0) -
      (pairSample.dps - baseline.dps),
    se: combineSe([
      baseline,
      pairSample,
      ...singles.map((s) => ({ dps: 0, se: s.se })),
    ]),
  };
}

/**
 * The pieces a player adds to reach `pkg`'s threshold when this candidate is
 * one of them (ticket 490): the whole package if the candidate is in it,
 * else the candidate plus the best `pkg.length − 1` package pieces outside its
 * slot, ranked the way `selectPackage` ranks them (single delta, then lowest
 * id). A candidate outside the package keeps what the package would not need.
 */
function pathToThreshold(
  itemId: number,
  slotIndex: number,
  pkg: SetBonusValue,
  candidateSlotIndex: ReadonlyMap<number, number>,
  individualDeltasByItemId: ReadonlyMap<number, IndividualDelta>
): PackagePiece[] {
  const members = pkg.packageItemIds
    .map((pieceItemId) => ({
      itemId: pieceItemId,
      slotIndex: candidateSlotIndex.get(pieceItemId),
    }))
    .filter((p): p is PackagePiece => p.slotIndex !== undefined);
  if (pkg.packageItemIds.includes(itemId)) return members;
  const deltaOf = (id: number) =>
    individualDeltasByItemId.get(id)?.deltaDps ?? -Infinity;
  const rest = members
    .filter((p) => p.slotIndex !== slotIndex)
    .sort((a, b) =>
      deltaOf(b.itemId) !== deltaOf(a.itemId)
        ? deltaOf(b.itemId) - deltaOf(a.itemId)
        : a.itemId - b.itemId
    )
    .slice(0, pkg.packageItemIds.length - 1);
  return [...rest, { itemId, slotIndex }];
}

/**
 * How many of a package's members break (X, t) by their own single swap — the
 * `memberSingleBreaks` count in the inflation correction. A member breaks it iff
 * swapping that one piece into its slot drops the worn (X, t) below threshold.
 */
function countMembersBreaking(
  pkg: SetBonusValue,
  target: Pick<BrokenSetBonus, "setId" | "threshold">,
  equipment: readonly SimItemSpec[],
  candidateSlotIndex: ReadonlyMap<number, number>,
  counts: BonusCountPredicate
): number {
  let k = 0;
  for (const itemId of pkg.packageItemIds) {
    const slotIndex = candidateSlotIndex.get(itemId);
    if (slotIndex === undefined) continue;
    const memberSetId = getItem(itemId)?.setId;
    if (memberSetId == null) continue;
    const breaks = brokenSetBonuses(
      equipment,
      [{ itemId, slotIndex }],
      memberSetId,
      counts
    );
    if (
      breaks.some(
        (brk) =>
          brk.setId === target.setId && brk.threshold === target.threshold
      )
    ) {
      k += 1;
    }
  }
  return k;
}

/**
 * The worn-set ladder of every set worn at 2 or more pieces, in set-id order
 * (ticket 512). Each count is `counted` when its value clears the same noise
 * gate as a set bonus, or when its sims failed. No table decides which sets or
 * counts are measured.
 */
async function measureWornSetLadders(
  equipment: readonly SimItemSpec[],
  composeFor: (equipment: readonly SimItemSpec[]) => RaidSimRequest,
  cachedSampleRun: (
    what: string
  ) => (request: RaidSimRequest) => Promise<DpsSample>,
  floorDps: number
): Promise<WornSetLadderEntry[]> {
  const worn = [...setCounts(equipment)]
    .filter(([, count]) => count >= 2)
    .map(([setId]) => setId)
    .sort((a, b) => a - b);
  if (worn.length === 0) return [];
  const request = composeFor(equipment);
  const entries: WornSetLadderEntry[] = [];
  for (const setId of worn) {
    const setName = setLabel(equipment, setId);
    const slots = equipment.flatMap((spec, i) =>
      spec.id && getItem(spec.id)?.setId === setId ? [i] : []
    );
    const rungs = await measureWornSetLadder(
      cachedSampleRun(`${setName} worn-set ladder`),
      request,
      slots
    );
    for (const rung of rungs) {
      const counted =
        rung.unmeasured !== undefined ||
        (rung.dps !== undefined &&
          clearsSameGearGate(rung.dps, rung.se ?? 0, floorDps));
      entries.push({ setId, setName, ...rung, counted });
    }
  }
  return entries;
}

/** The break predicate the flag path uses: a count the ladder counted. */
function countedLadderBreaks(
  ladder: readonly WornSetLadderEntry[]
): BonusCountPredicate {
  const counted = new Set(
    ladder.filter((e) => e.counted).map((e) => `${e.setId}:${e.count}`)
  );
  return (setId, count) => counted.has(`${setId}:${count}`);
}

/**
 * The smallest entry count above `after` whose same-gear gate cleared, or
 * null (ticket 511). An entry carries `sameGearDps` without `belowGate`
 * exactly when its gate cleared.
 */
function nextClearedThreshold(
  bonusesForSet: readonly SetBonusValue[],
  after: number
): SetThreshold | null {
  const counts = bonusesForSet
    .filter(
      (b) => b.threshold > after && b.sameGearDps !== undefined && !b.belowGate
    )
    .map((b) => b.threshold);
  return counts.length > 0 ? Math.min(...counts) : null;
}

export function memberPackages(
  itemId: number,
  bonusesForSet: readonly SetBonusValue[]
): SetPackageContext[] | undefined {
  // `!belowGate` (C198): a below-gate entry's package was never simmed, so
  // its `packageDeltaDps` of 0 is not a measurement (ticket 511).
  const measured = bonusesForSet.filter(
    (b) => b.unmeasured === undefined && !b.belowGate
  );
  if (!measured.some((b) => b.packageItemIds.includes(itemId))) {
    return undefined;
  }
  return measured
    .slice()
    .sort((a, b) => a.threshold - b.threshold)
    .map((b) => ({
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
  candidateSlotIndex: ReadonlyMap<number, number> = new Map(),
  individualDeltasByItemId: ReadonlyMap<number, IndividualDelta> = new Map(),
  counts: BonusCountPredicate = isBonusImplemented,
  /**
   * Present exactly on the flag path (ticket 511): the crossing gates, so the
   * crossing and next-bonus counts read measurements instead of the six-set
   * table, and every entry above the swap's count becomes a future.
   */
  stepPath?: { crossingGates: readonly CrossingGate[] }
): void {
  const wornCounts = setCounts(equipment);
  const bonusesBySet = new Map<number, SetBonusValue[]>();
  for (const b of setBonuses) {
    const list = bonusesBySet.get(b.setId) ?? [];
    list.push(b);
    bonusesBySet.set(b.setId, list);
  }
  const bBy = new Map<string, number | undefined>();
  for (const v of brokenSetValues) bBy.set(`${v.setId}:${v.threshold}`, v.dps);
  const dpsForBreak = (brk: BrokenSetBonus): number | undefined =>
    bBy.get(`${brk.setId}:${brk.threshold}`);
  const rankedById = new Map(ranked.map((r) => [r.itemId, r]));

  for (const item of ranked) {
    const setId = getItem(item.itemId)?.setId;
    if (setId == null) continue;
    const bonusesForSet = bonusesBySet.get(setId);
    if (!bonusesForSet) continue;

    const piecesWornBefore = wornCounts.get(setId) ?? 0;
    const piecesAfterSwap = item.owned
      ? piecesWornBefore
      : piecesWornBefore + 1;
    // Flag path (ticket 511): one more piece crosses a bonus only when that
    // count's crossing gate cleared, and the next bonus is the next count
    // whose gate cleared. No table is read.
    const crossingCleared =
      stepPath?.crossingGates.some(
        (g) =>
          g.setId === setId && g.count === piecesWornBefore + 1 && g.cleared
      ) ?? false;
    const thresholdBeforeSwap = stepPath
      ? crossingCleared
        ? piecesWornBefore + 1
        : nextClearedThreshold(bonusesForSet, piecesWornBefore)
      : nextMeasurableThreshold(setId, piecesWornBefore);
    const crossesThreshold = stepPath
      ? !item.owned && piecesAfterSwap === piecesWornBefore + 1 && crossingCleared
      : thresholdBeforeSwap !== null && piecesAfterSwap >= thresholdBeforeSwap;
    const nextThreshold = stepPath
      ? nextClearedThreshold(bonusesForSet, piecesAfterSwap)
      : nextMeasurableThreshold(setId, piecesAfterSwap);

    const setContext: SetContext = {
      setId,
      setName:
        bonusesForSet[0]?.setName ?? setLabel(equipment, setId, [item.itemId]),
      piecesWornBefore,
      piecesAfterSwap,
      nextThreshold,
      crossesThreshold,
      ...(stepPath ? { stepRanking: true as const } : {}),
    };

    const slotIndex = candidateSlotIndex.get(item.itemId);

    // singleBreaks: worn bonuses this one piece breaks by itself. Inside
    // deltaDps already; dps is the measured B when available.
    if (slotIndex !== undefined) {
      const single = brokenSetBonuses(
        equipment,
        [{ itemId: item.itemId, slotIndex }],
        setId,
        counts
      );
      if (single.length > 0) {
        setContext.singleBreaks = single.map((brk) => {
          const dps = dpsForBreak(brk);
          return {
            setId: brk.setId,
            setName: brk.setName,
            threshold: brk.threshold,
            ...(dps !== undefined ? { dps } : {}),
          };
        });
      }
    }

    // futureBonuses: every implemented threshold above the post-swap count, its
    // corrected net value. dps absent when the correction could not be measured.
    // Only for a swap that adds a set piece: an owned row's swap changes nothing,
    // so crediting it a future bonus would rank "keep what you wear" on value
    // the swap cannot bring (ticket 478 A4; fixture A4 showed credit 80).
    const advancesPieceCount = piecesAfterSwap > piecesWornBefore;
    // Flag path (ticket 511): every entry above the swap's count that has a
    // package or is below the gate, with no list. A below-gate future is
    // never a stop, but it is shown so the row can say the count was tried.
    const T = stepPath
      ? bonusesForSet
          .filter(
            (b) =>
              advancesPieceCount &&
              b.threshold > piecesAfterSwap &&
              (b.packageItemIds.length > 0 || b.belowGate === true)
          )
          .map((b) => b.threshold)
          .sort((a, b) => a - b)
      : [...SET_THRESHOLDS].filter(
          (t) =>
            advancesPieceCount &&
            t > piecesAfterSwap &&
            isBonusImplemented(setId, t)
        );
    const singleKeys = new Set(
      (setContext.singleBreaks ?? []).map((b) => `${b.setId}:${b.threshold}`)
    );
    const withDps = (brk: BrokenSetBonus) => {
      const dps = dpsForBreak(brk);
      return {
        setId: brk.setId,
        setName: brk.setName,
        threshold: brk.threshold,
        ...(dps !== undefined ? { dps } : {}),
      };
    };
    // A path piece's own stats (ticket 502): its single from the individual
    // deltas, read here before `replicateTopItems` rewrites the top rows'
    // `deltaDps`, so a row inside a measured package sums to that package's
    // delta. The worn bonuses it breaks alone are added back because the path
    // charges each break once; the 2pc it crosses alone at worn 1 is taken
    // out because the row's own delta already holds it. Undefined when any
    // input was unmeasured.
    const ownStats = (p: PackagePiece): number | undefined => {
      const single = individualDeltasByItemId.get(p.itemId)?.deltaDps;
      if (single === undefined) return undefined;
      let own = single;
      for (const brk of brokenSetBonuses(equipment, [p], setId, counts)) {
        const dps = dpsForBreak(brk);
        if (dps === undefined) return undefined;
        own += dps;
      }
      const pieceAfterSwap = rankedById.get(p.itemId)?.owned
        ? piecesWornBefore
        : piecesWornBefore + 1;
      if (
        thresholdBeforeSwap !== null &&
        pieceAfterSwap >= thresholdBeforeSwap
      ) {
        const crossed = bonusesForSet.find(
          (b) => b.selfConfound?.threshold === thresholdBeforeSwap
        )?.selfConfound?.dps;
        if (crossed === undefined) return undefined;
        own -= crossed;
      }
      return own;
    };
    const futureBonuses = T.map((t) => {
      const bonus = bonusesForSet.find((b) => b.threshold === t);
      const net = bonus?.bonusDpsNet;
      // `!belowGate` (C198): no path through a package that was never simmed
      // (ticket 511).
      const path =
        bonus &&
        bonus.unmeasured === undefined &&
        !bonus.belowGate &&
        bonus.packageItemIds.length > 0 &&
        slotIndex !== undefined
          ? pathToThreshold(
              item.itemId,
              slotIndex,
              bonus,
              candidateSlotIndex,
              individualDeltasByItemId
            )
          : undefined;
      // The worn bonuses this future's own path breaks beyond the single's
      // own break (ticket 490). Keys a lower future already lists stay here
      // too; the view charges each key once.
      const pathBreaks = path
        ? brokenSetBonuses(equipment, path, setId, counts).filter(
            (brk) => !singleKeys.has(`${brk.setId}:${brk.threshold}`)
          )
        : [];
      // The path's other members (ticket 502). Pieces a lower future already
      // lists stay here too; the view counts each piece once.
      const pieces = path
        ?.filter((p) => p.itemId !== item.itemId)
        .map((p) => {
          const dps = ownStats(p);
          return {
            itemId: p.itemId,
            name: rankedById.get(p.itemId)?.name ?? String(p.itemId),
            ...(dps !== undefined ? { dps } : {}),
          };
        });
      // Pieces the player still needs from their CURRENT worn count to activate
      // this threshold, counting this candidate as one of them (ticket 467 case
      // 2: at worn 1 the 4pc needs 3 more).
      return {
        threshold: t,
        piecesNeeded: t - piecesWornBefore,
        ...(net !== undefined ? { dps: net } : {}),
        ...(bonus?.sameGearDps !== undefined && bonus.sameGearSe !== undefined
          ? { sameGearDps: bonus.sameGearDps, sameGearSe: bonus.sameGearSe }
          : {}),
        ...(bonus?.belowGate ? { belowGate: true as const } : {}),
        ...(pathBreaks.length > 0 ? { breaks: pathBreaks.map(withDps) } : {}),
        ...(pieces ? { pieces } : {}),
      };
    });
    if (futureBonuses.length > 0) setContext.futureBonuses = futureBonuses;

    // commitBreaks: the worn bonuses broken by completing the top implemented
    // threshold package with this item in its slot, beyond the row's own single
    // break. commitPackageDeltaDps: that package's end-state value (disclosure).
    const topPackage = topMeasuredPackage(bonusesForSet);
    if (topPackage && slotIndex !== undefined) {
      const commitAll = substitutedPackageBreaks(
        item.itemId,
        setId,
        slotIndex,
        topPackage,
        candidateSlotIndex,
        equipment,
        counts
      );
      const commitOnly = commitAll.filter(
        (brk) => !singleKeys.has(`${brk.setId}:${brk.threshold}`)
      );
      if (commitOnly.length > 0) {
        setContext.commitBreaks = commitOnly.map(withDps);
      }
      setContext.commitPackageDeltaDps = topPackage.packageDeltaDps;
    }

    const pkgs = memberPackages(item.itemId, bonusesForSet);
    if (pkgs) setContext.packages = pkgs;
    item.setContext = setContext;
  }
}

export function resolveFight(
  fights: readonly FightSummary[],
  requested?: FightRef
): ResolvedFight | undefined {
  if (requested) {
    const match = fights.find(
      (f) =>
        f.reportCode === requested.reportCode && f.fightId === requested.fightId
    );
    return match
      ? summaryToResolved(match)
      : {
          ...requested,
          route: "report-events",
        };
  }
  const ranked = fights.find((f) => f.route === "ranked");
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
    ...(f.salvationUptime === undefined
      ? {}
      : { salvationUptime: f.salvationUptime }),
  };
}

/** Namespaced so a ranking blob cannot collide with another content-addressed value. */
function rankingCacheKey(contentHash: string): string {
  return `ranking:${contentHash}`;
}

async function readCachedSim(
  deps: Deps,
  req: RaidSimRequest,
  simVersion: string,
  opts: SimRunOpts
): Promise<SimObservation | undefined> {
  return asInternal(() =>
    deps.store.get<SimObservation>(simStoreKey(req, simVersion, opts))
  );
}

function simStoreKey(
  req: RaidSimRequest,
  simVersion: string,
  opts: SimRunOpts
): string {
  return `sim:${simCacheKey(req, simVersion, opts)}`;
}

async function cacheSimResult(
  deps: Deps,
  req: RaidSimRequest,
  simVersion: string,
  opts: SimRunOpts,
  observation: SimObservation
): Promise<void> {
  await asInternal(() =>
    deps.store.put(simStoreKey(req, simVersion, opts), observation)
  );
}

/**
 * A screened observation is stored under its own key namespace, deliberately
 * NOT under `simStoreKey`.
 *
 * The loop's key is `sim:<request>:<version>:<seed>:<iterations>` and records
 * nothing about which run produced the number — in particular not the screening
 * pass's own probe seed, which it picks itself. A screened observation filed
 * there would be read back by two callers that must never see one: the
 * per-candidate loop, which differences against the loop's own baseline, and —
 * because `simFor` shares `readCachedSim` and replication re-sims at
 * `seeds[0]`, the same seed `runOpts` holds — `replicateTopItems`, whose
 * paired-seed contract is that candidate and baseline come from the same run.
 * Either would pair an observation with a baseline it was not measured against,
 * reintroducing the gap `screenCandidates` documents, and the second would push
 * it into the accurate final pass the screening pass is designed not to touch.
 *
 * Scoping the key to the screening route keeps the reuse (a re-run screens from
 * the store instead of re-simming) while making the observation unreachable
 * from the paths that would misread it. The stored value keeps the baseline
 * it was measured against for the same reason the in-memory result does: the
 * observation and its baseline are only meaningful as a pair.
 */
type CachedScreenObservation = {
  observation: SimObservation;
  baselineDps: number;
};

function screenStoreKey(
  req: RaidSimRequest,
  simVersion: string,
  opts: SimRunOpts
): string {
  return `screen:${simCacheKey(req, simVersion, opts)}`;
}

async function readCachedScreen(
  deps: Deps,
  req: RaidSimRequest,
  simVersion: string,
  opts: SimRunOpts
): Promise<CachedScreenObservation | undefined> {
  return asInternal(() =>
    deps.store.get<CachedScreenObservation>(
      screenStoreKey(req, simVersion, opts)
    )
  );
}

async function cacheScreenResult(
  deps: Deps,
  req: RaidSimRequest,
  simVersion: string,
  opts: SimRunOpts,
  value: CachedScreenObservation
): Promise<void> {
  await asInternal(() =>
    deps.store.put(screenStoreKey(req, simVersion, opts), value)
  );
}

async function asInternal<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    throw new RankError(
      "internal",
      err instanceof Error ? err.message : String(err)
    );
  }
}

function raceFromSkeleton(skeleton: RaidSimRequest): Race {
  const raw = (
    skeleton as {
      raid?: { parties?: Array<{ players?: Array<{ race?: string }> }> };
    }
  ).raid?.parties?.[0]?.players?.[0]?.race;
  if (raw && isRace(raw)) return raw;
  return "RaceHuman";
}

function talentsStringFromRequest(request: RaidSimRequest): string | undefined {
  const raw = (
    request as {
      raid?: {
        parties?: Array<{ players?: Array<{ talentsString?: string }> }>;
      };
    }
  ).raid?.parties?.[0]?.players?.[0]?.talentsString;
  return typeof raw === "string" ? raw : undefined;
}

function isRace(value: string): value is Race {
  return (
    value === "RaceHuman" ||
    value === "RaceDwarf" ||
    value === "RaceNightElf" ||
    value === "RaceGnome" ||
    value === "RaceDraenei" ||
    value === "RaceOrc" ||
    value === "RaceUndead" ||
    value === "RaceTauren" ||
    value === "RaceTroll" ||
    value === "RaceBloodElf"
  );
}

export function equipmentForCandidateSwap(
  equipment: readonly SimItemSpec[],
  slotIndex: number,
  itemId: number,
  gems: GemContext
): SimItemSpec[] {
  return candidateSwapWithRepairs(equipment, slotIndex, itemId, gems).equipment;
}

export function candidateSwapWithRepairs(
  equipment: readonly SimItemSpec[],
  slotIndex: number,
  itemId: number,
  gems: GemContext
): {
  equipment: SimItemSpec[];
  swaps: readonly MetaRepairSwap[];
  removed: readonly { slotIndex: number; itemId: number }[];
} {
  // Before the swap, and `swapItemAt` takes the cleared array: `swapItemAt`
  // computes `fillOptsForSwap` from whatever array it is handed, so clearing
  // afterwards would leave a unique gem on the removed off-hand item still
  // counted in `usedUnique` and still blocking the candidate's own socket.
  const { equipment: cleared, removed } = clearOffHandForTwoHander(
    equipment,
    slotIndex,
    itemId
  );
  const swapped = swapItemAt(cleared, slotIndex, itemId, gems);
  const socketed: SocketedItem[] = swapped.map((spec) => ({
    itemId: spec.id ?? 0,
    gems: [...spec.gems],
  }));
  const minimized = repairAndMinimize({
    items: socketed,
    epWeights: gems.weights,
    palette: gems.fillPalette,
  });
  return {
    equipment: applyRepairedGems(swapped, minimized.items),
    swaps: minimized.swaps.filter((s) => s.itemIndex !== slotIndex),
    removed,
  };
}

/**
 * Takes the worn off-hand item off when a two-handed candidate goes in the
 * main hand, and names what it took (ticket 350).
 *
 * A two-hander occupies both hands, so pricing one beside a worn off-hand item
 * composes gear the game cannot equip. Clearing the slot leaves a legal,
 * ordinary two-hander build and an honest swap — the row then debits the
 * off-hand item's stats through `statDeltaBetween` and discloses it through
 * `RankedItem.removedItems`, so a reader cannot mistake the two-item change
 * for a one-item one.
 *
 * This is a different case from the `offhand` guard in `attemptEligibility`,
 * which covers a two-hander already WORN with a one-hander offered for the off
 * hand. That trade is rejected there because displacing the worn two-hander
 * would price a one-hander while silently costing a two-hander; this one is
 * disclosed rather than rejected because the resulting build is legal and the
 * cost is stated. See that guard's own scope paragraph.
 *
 * Returns the input array untouched, with no removals, in every other case.
 */
function clearOffHandForTwoHander(
  equipment: readonly SimItemSpec[],
  slotIndex: number,
  itemId: number
): {
  equipment: readonly SimItemSpec[];
  removed: readonly { slotIndex: number; itemId: number }[];
} {
  if (slotIndex !== SIM_ORDER.indexOf("mainhand")) {
    return { equipment, removed: [] };
  }
  if (getItem(itemId)?.handType !== HandType.HandTypeTwoHand) {
    return { equipment, removed: [] };
  }
  const offHandIndex = SIM_ORDER.indexOf("offhand");
  const wornOffHandId = equipment[offHandIndex]?.id;
  if (!wornOffHandId) return { equipment, removed: [] };

  const cleared = equipment.map((spec, i) =>
    // The bare-slot value `equipmentFromLoggedGear` writes for an empty slot,
    // so a cleared off hand is indistinguishable from one the player never
    // filled — which is what every downstream gem and stat stage already
    // handles.
    i === offHandIndex ? { gems: [] } : spec
  );
  return {
    equipment: cleared,
    removed: [{ slotIndex: offHandIndex, itemId: wornOffHandId }],
  };
}

function swapItemAt(
  equipment: readonly SimItemSpec[],
  slotIndex: number,
  itemId: number,
  gemCtx: GemContext
): SimItemSpec[] {
  return equipment.map((spec, i) => {
    if (i !== slotIndex) return spec;
    const sameItem = spec.id === itemId;
    const gems = sameItem
      ? [...(spec.gems ?? [])]
      : fillEmptyCandidateGems(
          itemId,
          migrateGemsToItem(spec.gems ?? [], spec.id ?? 0, itemId),
          gemCtx.fillPalette,
          gemCtx.weightRecord,
          fillOptsForSwap(equipment, slotIndex, gemCtx.spec)
        );
    const out: SimItemSpec = { id: itemId, gems };
    if (spec.enchant && enchantAppliesToItem(spec.enchant, itemId)) {
      out.enchant = spec.enchant;
    }
    return out;
  });
}

function metaPreferenceDisclosure(
  spec: DetectedSpecId | undefined
): Substitution[] {
  const note = missingMetaPreferenceNote(spec);
  return note ? [{ field: "gems.meta-preference", detail: note }] : [];
}

function fillOptsForSwap(
  equipment: readonly SimItemSpec[],
  slotIndex: number,
  spec: DetectedSpecId | undefined
): FillEmptyOpts {
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
  const wornGems = (equipment[slotIndex]?.gems ?? []).filter((id) => id > 0);
  const metaId = findMetaGemId([...otherGemIds, ...wornGems]);
  return {
    usedUnique,
    ...(metaId !== undefined ? { meta: { metaId, otherGemIds } } : {}),
    ...(spec !== undefined ? { spec } : {}),
  };
}

function applyRepairedGems(
  equipment: readonly SimItemSpec[],
  socketed: SocketedItem[]
): SimItemSpec[] {
  return equipment.map((spec, i) => {
    const repaired = socketed[i];
    if (!repaired || !spec.id) return spec;
    return { ...spec, gems: [...repaired.gems] };
  });
}
