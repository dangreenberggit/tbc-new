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
import { type Cutoff,cutoffForSpec, meetsCutoff } from "./cutoff.js";
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
  type BrokenSetBonus,
  brokenSetBonuses,
  combineSe,
  computeSynergy,
  type DpsSample,
  type IndividualDelta,
  type InflationKey,
  isBonusImplemented,
  lostThresholds,
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
   * When set, `buildSetBonuses` runs one extra sim per worn implemented set
   * bonus that a ranked single or package would break, to measure that broken
   * bonus's standalone value `B` in the player's own context (ticket 467). The
   * tab passes it; the E-W3 parity harness does not, so the compared request
   * lists stay identical (`wowsims-fork-parity.test.ts` never sets the flag).
   * Absent = today's behaviour and today's request list exactly.
   */
  measureBrokenSetValue?: boolean;
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
 */
export type SetContext = {
  setId: number;
  setName: string;
  piecesWornBefore: number;
  piecesAfterSwap: number;
  nextThreshold: SetThreshold | null;
  crossesThreshold: boolean;
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
 * Standalone value `B` of one worn implemented set bonus (X, t) that completing
 * or advancing another set would break (ticket 467), measured by vacating the
 * minimum number of worn X pieces that break (X, t) to neutral pool candidates
 * and differencing against the MAIN baseline. `dps` is `B`; absent with an
 * `unmeasured` reason when no neutral replacement existed, the sim failed, or
 * (`dependent-unmeasured`) the solve needed a higher threshold's `B` of the same
 * set that was itself unmeasured (ticket 476).
 */
export type BrokenSetValue = {
  setId: number;
  setName: string;
  threshold: SetThreshold;
  dps?: number;
  se?: number;
  vacatedItemIds: number[];
  replacementItemIds: number[];
  unmeasured?:
    | "no-neutral-candidates"
    | "sim-failed"
    | "repair-failed"
    | "dependent-unmeasured";
};

export type SetBonusValue = {
  setId: number;
  setName: string;
  threshold: SetThreshold;
  piecesWorn: number;
  packageItemIds: number[];
  packageDeltaDps: number;
  bonusDps?: number;
  /**
   * `bonusDps` corrected for ticket 90's `(k − c)·B` inflation using the
   * measured broken-bonus value `B` (ticket 467). `bonusDps` keeps its raw
   * meaning for E-W3 parity; this is the value the ON credit and sort key use.
   * Absent when any needed `B` is unmeasured (no neutral replacement), which
   * reverts the row to disclosure-only.
   */
  bonusDpsNet?: number;
  se?: number;
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
   * Standalone value `B` of each worn implemented set bonus that a ranked
   * single or package would break, measured by one vacate sim per broken bonus
   * (ticket 467). Present only when `deps.measureBrokenSetValue` is set; the
   * E-W3 harness leaves it unset, so this field never appears there and adds no
   * requests to the parity comparison. `dps`/`se` absent with a reason when the
   * pool held no neutral replacement to vacate to.
   */
  brokenSetValues?: BrokenSetValue[];
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
      ? { bonuses: [], brokenSetValues: [], candidateSlotIndex: new Map() }
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
          deps.measureBrokenSetValue ?? false
        );
    const setBonuses = setBonusResult.bonuses;
    if (setBonuses.length > 0) {
      applySetContext(
        ranked,
        setBonuses,
        equipment,
        setBonusResult.brokenSetValues,
        setBonusResult.candidateSlotIndex
      );
    }
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
            `be measured: the sim failed — ${s.reason}`,
        })),
      ],
      items: ranked,
      ...(setBonuses.length > 0 ? { setBonuses } : {}),
      ...(setBonusResult.brokenSetValues.length > 0
        ? { brokenSetValues: setBonusResult.brokenSetValues }
        : {}),
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
   * When set, run one vacate sim per worn implemented bonus a candidate breaks
   * to measure its standalone value `B` (ticket 467). Off in the E-W3 harness
   * so the compared request list is unchanged.
   */
  measureBrokenSetValue: boolean
): Promise<{
  bonuses: SetBonusValue[];
  brokenSetValues: BrokenSetValue[];
  /** itemId -> best pool slotIndex, so `applySetContext` can compute per-row breaks. */
  candidateSlotIndex: Map<number, number>;
}> {
  const setIdsWithCandidates = new Set<number>();
  for (const entry of candidates) {
    const setId = getItem(entry.itemId)?.setId;
    if (setId != null) setIdsWithCandidates.add(setId);
  }
  if (setIdsWithCandidates.size === 0) {
    return { bonuses: [], brokenSetValues: [], candidateSlotIndex: new Map() };
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

    for (const threshold of SET_THRESHOLDS) {
      if (threshold <= piecesWorn) continue;

      if (!isBonusImplemented(setId, threshold)) {
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

      const selection = selectPackage(
        setId,
        threshold,
        equipment,
        candidates,
        [...individualDeltasByItemId.values()],
        slotIndexForPoolEntry
      );
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
        continue;
      }
      const packageRequest = composeFor(packageEquipment);

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
          packageSimSkips.push({
            setId,
            setName: label,
            threshold,
            reason: err instanceof Error ? err.message : String(err),
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

      const breaks = brokenSetBonuses(equipment, addedPieces, setId);
      const selfConfound: SelfSetConfound | undefined =
        threshold === 4 && twoPieceUnmeasurableAtThisWornCount
          ? { threshold: 2 }
          : undefined;
      results.push({
        setId,
        setName: label,
        threshold,
        piecesWorn,
        packageItemIds: addedPieces.map((p) => p.itemId),
        packageDeltaDps: synergy.packageDeltaDps,
        bonusDps: synergy.bonusDps,
        se: synergy.se,
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

  const candidateSlotIndex = new Map<number, number>();
  const candidatesBySlot = new Map<number, PoolEntry[]>();
  for (const entry of candidates) {
    const idx = slotIndexForPoolEntry(entry);
    if (idx === undefined) continue;
    if (!candidateSlotIndex.has(entry.itemId)) {
      candidateSlotIndex.set(entry.itemId, idx);
    }
    const bucket = candidatesBySlot.get(idx) ?? [];
    bucket.push(entry);
    candidatesBySlot.set(idx, bucket);
  }

  const brokenSetValues: BrokenSetValue[] = [];
  if (measureBrokenSetValue) {
    // The distinct worn implemented bonuses (X, t) any candidate would break:
    // from every package's `breaks`, from each set-piece candidate's own single
    // break, and from the top package with that candidate substituted in — the
    // `commitBreaks` a row shows. Without the last source a row could subtract
    // a break nothing measured and keep the whole gain (ticket 477). Keyed by
    // `setId:threshold` so each is measured once, however many rows share it.
    const targets = new Map<string, BrokenSetBonus>();
    const addTarget = (brk: BrokenSetBonus): void => {
      targets.set(`${brk.setId}:${brk.threshold}`, brk);
    };
    for (const b of results) {
      for (const brk of b.breaks ?? []) addTarget(brk);
    }
    for (const entry of candidates) {
      const slotIndex = candidateSlotIndex.get(entry.itemId);
      if (slotIndex === undefined) continue;
      const entrySetId = getItem(entry.itemId)?.setId;
      if (entrySetId == null) continue;
      const singleBreaks = brokenSetBonuses(
        equipment,
        [{ itemId: entry.itemId, slotIndex }],
        entrySetId
      );
      for (const brk of singleBreaks) addTarget(brk);
      const top = topMeasuredPackage(
        results.filter((r) => r.setId === entrySetId)
      );
      if (top) {
        for (const brk of substitutedPackageBreaks(
          entry.itemId,
          entrySetId,
          slotIndex,
          top,
          candidateSlotIndex,
          equipment
        )) {
          addTarget(brk);
        }
      }
    }

    // Per set, highest threshold first: solving a lower threshold's B needs
    // every higher lost threshold's B of the same set (ticket 476).
    const ordered = [...targets.values()].sort((a, b) =>
      a.setId !== b.setId ? a.setId - b.setId : b.threshold - a.threshold
    );
    const measuredByKey = new Map<string, BrokenSetValue>();
    for (const brk of ordered) {
      const measured = await measureBrokenSetValueFor(
        deps,
        brk,
        equipment,
        candidates,
        candidatesBySlot,
        individualDeltasByItemId,
        gems,
        composeFor,
        baseline,
        simVersion,
        runOpts,
        measuredByKey
      );
      measuredByKey.set(`${brk.setId}:${brk.threshold}`, measured);
      brokenSetValues.push(measured);
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
      return brokenSetBonuses(equipment, [{ itemId, slotIndex }], memberSetId);
    });
  for (const b of results) {
    if (b.bonusDps === undefined) continue;
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
        membersPkg: countMembersBreaking(b, brk, equipment, candidateSlotIndex),
        members2pc: two
          ? countMembersBreaking(two, brk, equipment, candidateSlotIndex)
          : 0,
        pkgEnd: pkgEnd.has(key) ? 1 : 0,
        twoPcEnd: twoPcEnd.has(key) ? 1 : 0,
        B,
      });
    }
    if (allMeasured) b.bonusDpsNet = b.bonusDps - netInflation(keys);
  }

  return { bonuses: results, brokenSetValues, candidateSlotIndex };
}

/**
 * The highest measured, non-empty package of one set: the package a row's
 * `commitBreaks` completes, and a source of measurement targets (ticket 477).
 */
function topMeasuredPackage(
  bonusesForSet: readonly SetBonusValue[]
): SetBonusValue | undefined {
  return [...bonusesForSet]
    .filter((b) => b.unmeasured === undefined && b.packageItemIds.length > 0)
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
  equipment: readonly SimItemSpec[]
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
  return brokenSetBonuses(equipment, substituted, setId);
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
  candidateSlotIndex: ReadonlyMap<number, number>
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
      memberSetId
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
 * Measures one broken bonus's standalone value `B` by vacating the minimum
 * number of worn X pieces that break (X, t), to the highest-`deltaDps` neutral
 * pool candidates in those slots — candidates that are not X pieces and that
 * together cross no implemented threshold of any set. Differences the vacate sim
 * against the MAIN baseline (never a screen baseline), copying the package
 * pattern; the stored singles are used as measured, never re-based (ticket 467
 * N3, rank.ts:1111-1134).
 *
 * The vacate and each replacement single can lose MORE than (X, t): at worn
 * Malorne 4 the 3-slot vacate for the 2pc also loses the 4pc, and each single
 * loses the 4pc. With `L_vac` the thresholds the vacate loses, `L_1` those one
 * single loses, `Σs` the replacements' singles and `Δ` the vacate delta,
 *   B_t·(1 − n·[t∈L_1]) = (Σs − Δ) + n·Σ_{L_1, t'≠t} B_t' − Σ_{L_vac, t'≠t} B_t'
 * The naive `Σs − Δ` is `B_2 − 2·B_4` at worn 4 and `B_2 + B_4` at worn 5
 * (ticket 476). Every `t'` on the right is a higher threshold of the same set,
 * which is why `buildSetBonuses` measures targets highest first and passes the
 * results in `measuredByKey`.
 */
async function measureBrokenSetValueFor(
  deps: Deps,
  target: BrokenSetBonus,
  equipment: readonly SimItemSpec[],
  candidates: readonly PoolEntry[],
  candidatesBySlot: ReadonlyMap<number, PoolEntry[]>,
  individualDeltasByItemId: ReadonlyMap<number, IndividualDelta>,
  gems: GemContext,
  composeFor: (equipment: readonly SimItemSpec[]) => RaidSimRequest,
  baseline: DpsSample,
  simVersion: string,
  runOpts: SimRunOpts,
  measuredByKey: ReadonlyMap<string, BrokenSetValue>
): Promise<BrokenSetValue> {
  const wornCounts = setCounts(equipment);
  const wornX = wornCounts.get(target.setId) ?? 0;
  const t = target.threshold;
  // n = 2 when the worn count equals t (one swap breaks it, but the vacate must
  // reach a state no single reaches — 0 worn); else the minimum that breaks it.
  const n = wornX === t ? 2 : wornX - t + 1;

  const failure = (
    reason: NonNullable<BrokenSetValue["unmeasured"]>
  ): BrokenSetValue => ({
    setId: target.setId,
    setName: target.setName,
    threshold: t,
    vacatedItemIds: [],
    replacementItemIds: [],
    unmeasured: reason,
  });

  const lostByVacate = lostThresholds(target.setId, wornX, wornX - n);
  const lostBySingle = lostThresholds(target.setId, wornX, wornX - 1);
  // Checked before the sim, so an unsolvable target costs no run.
  const others = new Map<SetThreshold, BrokenSetValue>();
  for (const other of new Set([...lostByVacate, ...lostBySingle])) {
    if (other === t) continue;
    const known = measuredByKey.get(`${target.setId}:${other}`);
    if (known?.dps === undefined) return failure("dependent-unmeasured");
    others.set(other, known);
  }

  // The worn slots holding X pieces, in slot order.
  const wornXSlots: number[] = [];
  for (let i = 0; i < equipment.length; i++) {
    const id = equipment[i]?.id;
    if (id && getItem(id)?.setId === target.setId) wornXSlots.push(i);
  }
  if (wornXSlots.length < n) return failure("no-neutral-candidates");
  const vacateSlots = wornXSlots.slice(0, n);

  // Pick a neutral replacement per vacated slot: highest measured deltaDps, not
  // an X piece, and the running selection crosses no implemented threshold of
  // any set.
  const runningSetCounts = new Map(wornCounts);
  // Removing the vacated X pieces first, so a replacement's set is scored
  // against the post-removal counts.
  runningSetCounts.set(target.setId, wornX - vacateSlots.length);
  const replacements: { itemId: number; slotIndex: number }[] = [];
  for (const slotIndex of vacateSlots) {
    const pool = (candidatesBySlot.get(slotIndex) ?? [])
      .map((entry) => ({
        entry,
        delta: individualDeltasByItemId.get(entry.itemId)?.deltaDps,
      }))
      .filter(
        (c): c is { entry: PoolEntry; delta: number } =>
          c.delta !== undefined &&
          getItem(c.entry.itemId)?.setId !== target.setId
      )
      .sort((a, b) => b.delta - a.delta);
    let chosen: PoolEntry | undefined;
    for (const { entry } of pool) {
      const candSetId = getItem(entry.itemId)?.setId;
      if (candSetId != null) {
        const after = (runningSetCounts.get(candSetId) ?? 0) + 1;
        const crosses = SET_THRESHOLDS.some(
          (th) =>
            after >= th &&
            (runningSetCounts.get(candSetId) ?? 0) < th &&
            isBonusImplemented(candSetId, th)
        );
        if (crosses) continue;
      }
      chosen = entry;
      if (candSetId != null) {
        runningSetCounts.set(candSetId, (runningSetCounts.get(candSetId) ?? 0) + 1);
      }
      break;
    }
    if (!chosen) return failure("no-neutral-candidates");
    replacements.push({ itemId: chosen.itemId, slotIndex });
  }

  // Build the vacated equipment through the same swap/repair path packages use.
  let vacateEquipment: SimItemSpec[] = [...equipment];
  try {
    for (const r of replacements) {
      const outcome = candidateSwapWithRepairs(
        vacateEquipment,
        r.slotIndex,
        r.itemId,
        gems
      );
      vacateEquipment = outcome.equipment;
    }
  } catch (err) {
    if (!(err instanceof MetaRepairError)) throw err;
    return failure("repair-failed");
  }

  const req = composeFor(vacateEquipment);
  let obs = await readCachedSim(deps, req, simVersion, runOpts);
  if (!obs) {
    try {
      obs = await deps.sim.run(req, runOpts);
    } catch {
      return failure("sim-failed");
    }
    await cacheSimResult(deps, req, simVersion, runOpts, obs);
  }

  const delta = obs.dps - baseline.dps;
  const ownSamples = replacements.map((r) => {
    const ind = individualDeltasByItemId.get(r.itemId);
    return { dps: ind?.deltaDps ?? 0, se: ind?.se ?? 0 };
  });
  const sumOwn = ownSamples.reduce((sum, s) => sum + s.dps, 0);
  // The explicit form in the doc comment. The coefficient is −1 when worn == t
  // (n = 2, the single itself loses t: B = Δ − Σs) and 1 when worn > t.
  const coefficient = 1 - n * (lostBySingle.includes(t) ? 1 : 0);
  let rhs = sumOwn - delta;
  const otherSe: DpsSample[] = [];
  for (const [other, known] of others) {
    const weight =
      (lostBySingle.includes(other) ? n : 0) -
      (lostByVacate.includes(other) ? 1 : 0);
    rhs += weight * known.dps!;
    otherSe.push({ dps: 0, se: weight * (known.se ?? 0) });
  }
  const B = rhs / coefficient;
  const se = combineSe([
    baseline,
    { dps: obs.dps, se: obs.stdev / Math.sqrt(runOpts.iterations) },
    ...ownSamples.map((s) => ({ dps: 0, se: s.se })),
    ...otherSe,
  ]);
  return {
    setId: target.setId,
    setName: target.setName,
    threshold: t,
    dps: B,
    se,
    vacatedItemIds: vacateSlots.map((i) => equipment[i]?.id ?? 0),
    replacementItemIds: replacements.map((r) => r.itemId),
  };
}

export function memberPackages(
  itemId: number,
  bonusesForSet: readonly SetBonusValue[]
): SetPackageContext[] | undefined {
  const measured = bonusesForSet.filter((b) => b.unmeasured === undefined);
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
  candidateSlotIndex: ReadonlyMap<number, number> = new Map()
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

  for (const item of ranked) {
    const setId = getItem(item.itemId)?.setId;
    if (setId == null) continue;
    const bonusesForSet = bonusesBySet.get(setId);
    if (!bonusesForSet) continue;

    const piecesWornBefore = wornCounts.get(setId) ?? 0;
    const piecesAfterSwap = item.owned
      ? piecesWornBefore
      : piecesWornBefore + 1;
    const thresholdBeforeSwap = nextMeasurableThreshold(
      setId,
      piecesWornBefore
    );
    const crossesThreshold =
      thresholdBeforeSwap !== null && piecesAfterSwap >= thresholdBeforeSwap;
    const nextThreshold = nextMeasurableThreshold(setId, piecesAfterSwap);

    const setContext: SetContext = {
      setId,
      setName:
        bonusesForSet[0]?.setName ?? setLabel(equipment, setId, [item.itemId]),
      piecesWornBefore,
      piecesAfterSwap,
      nextThreshold,
      crossesThreshold,
    };

    const slotIndex = candidateSlotIndex.get(item.itemId);

    // singleBreaks: worn bonuses this one piece breaks by itself. Inside
    // deltaDps already; dps is the measured B when available.
    if (slotIndex !== undefined) {
      const single = brokenSetBonuses(
        equipment,
        [{ itemId: item.itemId, slotIndex }],
        setId
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
    const T = [...SET_THRESHOLDS].filter(
      (t) =>
        advancesPieceCount && t > piecesAfterSwap && isBonusImplemented(setId, t)
    );
    const futureBonuses = T.map((t) => {
      const bonus = bonusesForSet.find((b) => b.threshold === t);
      const net = bonus?.bonusDpsNet;
      // Pieces the player still needs from their CURRENT worn count to activate
      // this threshold, counting this candidate as one of them (ticket 467 case
      // 2: at worn 1 the 4pc needs 3 more).
      return {
        threshold: t,
        piecesNeeded: t - piecesWornBefore,
        ...(net !== undefined ? { dps: net } : {}),
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
        equipment
      );
      const singleKeys = new Set(
        (setContext.singleBreaks ?? []).map((b) => `${b.setId}:${b.threshold}`)
      );
      const commitOnly = commitAll.filter(
        (brk) => !singleKeys.has(`${brk.setId}:${brk.threshold}`)
      );
      if (commitOnly.length > 0) {
        setContext.commitBreaks = commitOnly.map((brk) => {
          const dps = dpsForBreak(brk);
          return {
            setId: brk.setId,
            setName: brk.setName,
            threshold: brk.threshold,
            ...(dps !== undefined ? { dps } : {}),
          };
        });
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
