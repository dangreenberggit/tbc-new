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
 * adaptations, unchanged in shape from packages/core/src/rank.ts.
 *
 * candidate-pool.md M2 (racing, §6.2): screen all eligible, apply the
 * promotion rule, cap the promoted set, full-iteration sim only the
 * promoted candidates — ported unchanged in shape. `screenCandidate` calls
 * `deps.sim.run` with `{ seed, iterations: screenIterations }`, exactly the
 * `SimRunOpts` shape `runCandidate` already uses with the default
 * iterations — the `SimRunner` seam (`seams/sim-runner.ts`) takes
 * iterations per call, so this file needed no change to carry a screening
 * iteration count into a request. `WasmSimRunner.run`
 * (`adapters/wasm_sim_runner.ts`) is what turns `SimRunOpts.iterations`
 * into the proto it hands the WASM worker; it does not go through
 * `sim.ts`'s `makeRaidSimRequest` at all, so that function's `iterations?`
 * override (F7) is not this pass's screening consumer — see this repo's
 * `sim.ts` doc comment for what does use it.
 *
 * Everything else — the eight-stage pipeline, cutoff/replication logic, set
 * synergy, disclosure assembly — is unchanged from packages/core.
 */

import {
  fillEmptyCandidateGems,
  gemContext,
  metaSocketUnpriced,
  missingMetaPreferenceNote,
  type FillEmptyOpts,
  type GemContext,
} from "./candidate-gems.js";
import { orderCandidatesByEp } from "./candidate-order.js";
import { migrateGemsToItem } from "./migrate-gems.js";
import { promisePool } from "./promise-pool.js";
import {
  DEFAULT_PROMOTE_TOP_K,
  DEFAULT_SCREEN_ITERATIONS,
  promotionRule,
  type ScreeningResult,
} from "./promotion.js";
import { compose } from "./compose.js";
import { canonicalJson, ENGINE_VERSION, type HashedGearItem } from "./content-hash.js";
import {
  capStateFrom,
  hitRegression,
  isHitDriven,
  statDeltaBetween,
  type CapState,
} from "./caps.js";
import { cutoffForSpec, meetsCutoff, type Cutoff } from "./cutoff.js";
import {
  buildStandingAssumptions,
  substitutionsFromMetaRepair,
  type Assumptions,
  type Substitution,
} from "./disclosure.js";
import { findMetaGemId, gemsForPhase, getGem, type GemEntry } from "./gems.js";
import { enchantAppliesToItem } from "./enchants.js";
import {
  equipmentFromLoggedGear,
  socketedItemsFromLoggedGear,
} from "./logged-gear.js";
import {
  MetaRepairError,
  repairAndMinimize,
  type MetaRepairSwap,
  type SocketedItem,
} from "./meta-repair.js";
import { isKaelTempLegendary } from "./kael-temp.js";
import {
  filterPoolByPhase,
  simSlotsForPoolSlot,
  type ItemSource,
  type PoolEntry,
  type SimSlotName,
} from "./pool.js";
import type { FightSummary, GearSource } from "./seams/gear-source.js";
import {
  simCacheKey,
  type RaidSimRequest,
  type SimObservation,
  type SimRunOpts,
  type SimRunner,
} from "./seams/sim-runner.js";
import type { Store } from "./seams/store.js";
import {
  assertUsableSeeds,
  DegenerateSeedsError,
  pairedReplicateSe,
  PAIRED_REPLICATE_TOP_N,
  usesPairedReplication,
} from "./se.js";
import { setBreakNote } from "./set-bonus.js";
import {
  brokenSetBonuses,
  computeSynergy,
  isBonusImplemented,
  nextMeasurableThreshold,
  selectPackage,
  setCounts,
  setLabel,
  SET_THRESHOLDS,
  type BrokenSetBonus,
  type DpsSample,
  type IndividualDelta,
  type SelfSetConfound,
  type SetThreshold,
  type UnmeasuredReason,
} from "./set-value.js";
import {
  plausibilityWarnings,
  type PlausibilityWarning,
} from "./plausibility.js";
import { getItem } from "./items.js";
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
   * Pre-M2 (or `fullPool: true`): keeps the first N candidates of the EP
   * ordering, plus every owned row regardless of N (§5.1.1). Once racing is
   * active, the cap instead applies to the *promoted* set (§5.1.1 Dean Q2)
   * — the sim, not EP, picks what the cap keeps. `undefined` means "no cap"
   * — hashed identically to a cap equal to the relevant set's size
   * (content-hash.ts's `candidateCap` normalization, mirrored below since
   * this file hashes via `canonicalJson` directly rather than through
   * `contentHashOf`).
   */
  candidateCap?: number;
  /**
   * Iterations per candidate in the screening pass (candidate-pool.md §6).
   * PORTED unchanged from packages/core/src/rank.ts — see that file's doc
   * comment on this same field for the full measured justification
   * (§3.4.1's proposed 300/35 vs the held-out fixture's 42 above-cutoff
   * rows at contiguous ranks 1–42, corrected to 1000/150). Ignored when
   * `fullPool: true`.
   */
  screenIterations?: number;
  /**
   * How many top-screened candidates promote to a full-iteration sim
   * (candidate-pool.md §6.1). PORTED unchanged from packages/core/src/rank.ts
   * — see that file's doc comment on this same field. Ignored when
   * `fullPool: true`.
   */
  promoteTopK?: number;
  /**
   * Skips screening entirely and full-iteration sims every eligible
   * candidate — ADR-0018's escape flag, now paired with the racing it
   * escapes (candidate-pool.md §6.1). `true` reproduces the pre-M2 flow
   * byte-for-byte (§6.4).
   */
  fullPool?: boolean;
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
   * How many candidate sims may be in flight at once (candidate-pool.md
   * §5.1.2). A plain scalar, not a ranking input — it changes how fast a
   * run goes, never what it returns, so it stays out of the content hash.
   * Defaults to 1 (serial) when omitted.
   */
  concurrency?: number;
  /**
   * Stop signal (candidate-pool.md §5.1.4). On abort, in-flight sims finish
   * and the run returns a `PartialRanking` (`complete: false`); no further
   * candidates are dispatched.
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
   * A single candidate's row finished — fired as each sim lands, ahead of
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
  emptyMetaSocket?: boolean;
  owned?: boolean;
  /**
   * `false` only on a row Stop left unsimmed (candidate-pool.md §5.1.4) —
   * absent otherwise, never `true`, so an ordinary complete run never
   * carries the field at all and a reader can tell "simmed" from "this
   * `Ranking` predates Stop" apart from "this row was skipped by Stop".
   * Such a row's `deltaDps`/`se`/etc. are placeholders, excluded from
   * cutoff classification and tie groups.
   */
  simmed?: false;
  /**
   * Present only when this run raced (candidate-pool.md §6): the row was
   * screened at `iterations` and the promotion rule did not promote it to a
   * full-iteration sim. `deltaDps`/`se` above are the *screening*
   * observation, not a full sim — a third view state, distinct from
   * `belowCutoff` ("measured and small") because a screened row was never
   * measured at full precision at all. Ranked only among other screened
   * rows (view.ts), never interleaved with full-iteration deltas, and
   * never deleted — a screened row keeps its screening delta rather than
   * being dropped from `items`.
   *
   * `promoted: true` never appears here: a promoted candidate goes on to a
   * full sim and this field is absent from its finished row, exactly like
   * `simmed` never carries `true` for a normally-simmed row.
   */
  screened?: { iterations: number; promoted: false };
  belowCutoff: boolean;
  setContext?: SetContext;
};

export type SetContext = {
  setId: number;
  setName: string;
  piecesWornBefore: number;
  piecesAfterSwap: number;
  nextThreshold: SetThreshold | null;
  crossesThreshold: boolean;
  prospectiveBonusDps?: number;
  prospectiveBonusBreaks?: BrokenSetBonus[];
  packages?: SetPackageContext[];
};

export type SetPackageContext = {
  threshold: SetThreshold;
  deltaDps: number;
  itemIds: number[];
  piecesNeeded: number;
};

export type SetBonusValue = {
  setId: number;
  setName: string;
  threshold: SetThreshold;
  piecesWorn: number;
  packageItemIds: number[];
  packageDeltaDps: number;
  bonusDps?: number;
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
  plausibilityWarnings?: PlausibilityWarning[];
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
  stdev: number;
  request: RaidSimRequest;
  slotChoice?: SimSlotName;
  slotIndex: number;
  setBonusNote?: string;
  hitDriven: boolean;
  hitRegression: { lost: number; gapAfter: number } | null;
  repairSwaps: readonly MetaRepairSwap[];
  candidateGems: readonly number[];
};

const DEFAULT_ITERATIONS = 3000;
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
  const request = compose(deps.raidSimSkeleton, {
    name: input.character.name.toLowerCase(),
    race,
    equipment,
  });

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
  const eligible = filterPoolByPhase(deps.pool ?? [], input.maxPhase).filter(
    (e) => !isKaelTempLegendary(e.itemId)
  );
  // Ordering runs before any sim, from raw stats only, so it cannot fail on
  // a candidate the sim itself would later reject. Pre-M2 (or `fullPool`)
  // this order also decides which N the cap keeps (§5.1.1); once racing is
  // active it is a tie-break only — the sim decides the cap via screening.
  const ordered = orderCandidatesByEp(
    eligible,
    equipment,
    deps.epWeights,
    (itemId) => getItem(itemId)?.stats ?? []
  );
  const racing = input.fullPool !== true;
  const screenIterations = input.screenIterations ?? DEFAULT_SCREEN_ITERATIONS;
  const promoteTopK = input.promoteTopK ?? DEFAULT_PROMOTE_TOP_K;

  const simVersion = await deps.sim.version();

  // Hashed on every *eligible* candidate, not the post-cap/post-promotion
  // set: which candidates are eligible is known before any sim runs, so this
  // is stable enough to gate the cache lookup before screening or full sims
  // start. `candidateCap` and the racing knobs are separate hashed fields
  // (below) that narrow the eligible set down to what actually gets a full
  // sim — hashing here rather than at entry because the logged gear is the
  // largest input to every delta, and it is not known until readGear
  // resolves. The check still lands before the sim loop, which is the
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
    fullPool: !racing,
    screenIterations: racing ? screenIterations : null,
    promoteTopK: racing ? promoteTopK : null,
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
    const individualDeltasByItemId = new Map<number, IndividualDelta>();

    const talentsString = talentsStringFromRequest(request);
    const caps = capStateFrom(equipment, socketed, {
      assumedRace: race,
      spec: input.spec,
      ...(talentsString !== undefined ? { talentsString } : {}),
    });

    /**
     * One candidate's best screening delta (candidate-pool.md §6.1/§6.2) —
     * every slot attempt at `screenIterations`, cheapest-delta-wins exactly
     * like `runCandidate`'s full-iteration loop, but with none of the
     * disclosure bookkeeping (hit caps, gem substitution notes, set-bonus
     * context) a screened candidate never carries: only promoted candidates
     * get a `RankedItem`'s full shape. A candidate whose every slot attempt
     * panics screens at `-Infinity` rather than being silently promoted —
     * the same "never let a sim failure look like a win" rule the
     * full-iteration loop encodes by skipping the attempt entirely, except
     * here there is no disclosure row to skip it *into*, so the delta itself
     * carries the refusal.
     */
    async function screenCandidate(entry: PoolEntry): Promise<number> {
      const slotNames = simSlotsForPoolSlot(entry.slot);
      let best: number | undefined;
      const screenOpts = { seed, iterations: screenIterations };
      for (const slotName of slotNames) {
        const slotIndex = SIM_ORDER.indexOf(slotName);
        if (slotIndex < 0) continue;
        const wornAt = equipment.findIndex((spec) => spec.id === entry.itemId);
        if (wornAt >= 0 && wornAt !== slotIndex) continue;
        let swapped: SimItemSpec[];
        try {
          swapped = candidateSwapWithRepairs(
            equipment,
            slotIndex,
            entry.itemId,
            gems
          ).equipment;
        } catch (err) {
          if (!(err instanceof MetaRepairError)) throw err;
          continue;
        }
        const candReq = compose(deps.raidSimSkeleton, {
          name: input.character.name.toLowerCase(),
          race,
          equipment: swapped,
        });
        let candObs = await readCachedSim(
          deps,
          candReq,
          simVersion,
          screenOpts
        );
        if (!candObs) {
          try {
            candObs = await deps.sim.run(candReq, screenOpts);
          } catch {
            continue;
          }
          await cacheSimResult(deps, candReq, simVersion, screenOpts, candObs);
        }
        const deltaDps = candObs.dps - baselineDps;
        if (best === undefined || deltaDps > best) best = deltaDps;
      }
      return best ?? Number.NEGATIVE_INFINITY;
    }

    /**
     * One candidate's full slot-attempt loop, unchanged from the old serial
     * body except that it is now a `promisePool` task rather than one turn
     * of a `for` loop (candidate-pool.md §5.1.2) — every mutation below
     * still lands on the shared `ranked`/`candidateSkips`/
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
      const slotNames = simSlotsForPoolSlot(entry.slot);
      let best: BestSwap | null = null;

      for (let s = 0; s < slotNames.length; s++) {
        const slotName = slotNames[s]!;
        const slotIndex = SIM_ORDER.indexOf(slotName);
        if (slotIndex < 0) {
          throw new Error(
            `slot mapping bug: ${entry.slot} -> ${slotName} is not in SIM_ORDER ` +
              `(item ${entry.itemId} ${entry.name})`
          );
        }
        const wornAt = equipment.findIndex((spec) => spec.id === entry.itemId);
        if (wornAt >= 0 && wornAt !== slotIndex) continue;
        let swapped: SimItemSpec[];
        let repairSwaps: readonly MetaRepairSwap[];
        try {
          const outcome = candidateSwapWithRepairs(
            equipment,
            slotIndex,
            entry.itemId,
            gems
          );
          swapped = outcome.equipment;
          repairSwaps = outcome.swaps;
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
        const candReq = compose(deps.raidSimSkeleton, {
          name: input.character.name.toLowerCase(),
          race,
          equipment: swapped,
        });
        let candObs = await readCachedSim(deps, candReq, simVersion, runOpts);
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
        const deltaDps = candObs.dps - baselineDps;
        const note = setBreakNote(equipment, slotIndex, entry.itemId);
        if (!best || deltaDps > best.deltaDps) {
          const statDelta = statDeltaBetween(equipment, swapped);
          const next: BestSwap = {
            deltaDps,
            stdev: candObs.stdev,
            request: candReq,
            slotIndex,
            hitDriven: isHitDriven(statDelta, caps.hit, { deltaDps }),
            hitRegression: hitRegression(statDelta, caps.hit, { deltaDps }),
            repairSwaps,
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

      individualDeltasByItemId.set(entry.itemId, {
        itemId: entry.itemId,
        slotIndex: best.slotIndex,
        deltaDps: best.deltaDps,
        se: best.stdev / Math.sqrt(iterations),
      });

      const deltaPct =
        baselineDps === 0 ? 0 : (best.deltaDps / baselineDps) * 100;
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
      if (owned) item.owned = true;
      if (metaSocketUnpriced(entry.itemId, best.candidateGems, gems.spec)) {
        item.emptyMetaSocket = true;
      }
      ranked.push(item);
      winningRequests.set(entry.itemId, best.request);
      onProgress?.({ kind: "row", row: item });
    }

    // M2 racing (candidate-pool.md §6.2): screen all eligible, apply the
    // promotion rule, then cap the *promoted* set — the sim, not EP, picks
    // what a cap keeps once racing is active (§5.1.1 Dean Q2). Pre-M2 or
    // `fullPool: true` keeps today's flow: cap the EP order directly, no
    // screening pass, no screened rows.
    let simCandidates: PoolEntry[];
    const screenedRows: RankedItem[] = [];
    if (racing) {
      const screenSignal = deps.signal;
      const screenTasks = ordered.map((entry) => async () => {
        if (screenSignal?.aborted)
          return { itemId: entry.itemId, deltaDps: Number.NEGATIVE_INFINITY };
        const deltaDps = await screenCandidate(entry);
        return { itemId: entry.itemId, deltaDps };
      });
      const screenResults: ScreeningResult[] = await promisePool(
        screenTasks,
        deps.concurrency ?? 1
      );
      // Set-package membership at screening time is judged the same way the
      // full-iteration pass judges it (buildSetBonuses below): any set with
      // a candidate present in the *eligible* pool is a set the promotion
      // rule must not starve of pieces, since selectPackage picks its best
      // pieces from whichever candidates got a full sim.
      const setPackageItemIds = new Set(
        ordered
          .filter((e) => getItem(e.itemId)?.setId != null)
          .map((e) => e.itemId)
      );
      const promotion = promotionRule({
        screened: screenResults,
        candidates: ordered,
        promoteTopK,
        ownedItemIds: equippedIds,
        setPackageItemIds,
      });
      const promotedIds = new Set(
        promotion.filter((p) => p.promoted).map((p) => p.itemId)
      );
      const deltaByItemId = new Map(
        screenResults.map((r) => [r.itemId, r.deltaDps])
      );
      const promotedOrdered = ordered.filter((e) => promotedIds.has(e.itemId));
      // Cap applies to the promoted set (Dean Q2): the first N of the EP
      // order *within the promoted set*, plus every owned row regardless of
      // N — same shape as the pre-M2 cap, just over a narrower input.
      const promotedCap = input.candidateCap ?? promotedOrdered.length;
      simCandidates = promotedOrdered.filter(
        (e, i) => i < promotedCap || equippedIds.has(e.itemId)
      );
      const simCandidateIds = new Set(simCandidates.map((e) => e.itemId));
      for (const entry of ordered) {
        if (simCandidateIds.has(entry.itemId)) continue;
        // Screened out: either the rule never promoted it, or the post-
        // promotion cap dropped it — either way it keeps its screening
        // delta and renders as the third view state (view.ts), never
        // interleaved with full-iteration rows.
        screenedRows.push({
          rank: null,
          itemId: entry.itemId,
          name: entry.name,
          slot: entry.slot,
          source: entry.source,
          deltaDps: deltaByItemId.get(entry.itemId) ?? 0,
          deltaPct: 0,
          se: 0,
          seMethod: "independent",
          screened: { iterations: screenIterations, promoted: false },
          bisTags: entry.bisTags ?? [],
          ...(entry.curatedSets ? { curatedSets: entry.curatedSets } : {}),
          ...(entry.bisSets ? { bisSets: entry.bisSets } : {}),
          belowCutoff: false,
          ...(entry.sources ? { sources: entry.sources } : {}),
        });
      }
    } else {
      const cap = input.candidateCap ?? ordered.length;
      simCandidates = ordered.filter(
        (e, i) => i < cap || equippedIds.has(e.itemId)
      );
    }

    // Counted here, after screening/promotion decide the full-iteration set
    // — screening's own sims are accounted separately (screenCandidate does
    // not touch simsDone/totalSims, which describe the full-iteration
    // budget a progress bar promises).
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
      // A row Stop never reached — placeholder numbers so the shape stays a
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
    const setBonuses = aborted
      ? []
      : await buildSetBonuses(
          deps,
          simCandidates,
          equipment,
          gems,
          race,
          input,
          individualDeltasByItemId,
          { dps: baselineDps, se: observation.stdev / Math.sqrt(iterations) },
          simVersion,
          runOpts,
          packageSimSkips
        );
    if (setBonuses.length > 0) applySetContext(ranked, setBonuses, equipment);
    // Screened-out rows join after set-context (they belong to no set
    // package — a package member is promoted by construction) and after
    // replication's winning-request bookkeeping is built, since they were
    // never simmed at full iterations and have no winning request to
    // register (§6.1: ranked only among themselves, never interleaved).
    ranked.push(...screenedRows);

    onProgress?.({ stage: "ranking" });
    // Sorted first so replication can pick the contested top of the list, then
    // sorted again below — replication rewrites the very `deltaDps` this order
    // is built from, so ranking before it would freeze the ordering the
    // refinement exists to correct. Unsimmed rows sort last regardless of
    // their placeholder deltaDps (0), so an aborted run's honest-but-unsimmed
    // rows never crowd out real deltas at the top of the list. Screened rows
    // sort after every full-iteration row (simmed or not) and are ordered
    // only against each other — a screening delta and a full-iteration delta
    // are not the same quantity (§6.1), so they must never interleave.
    const bySimmedThenDelta = (a: RankedItem, b: RankedItem): number => {
      const aScreened = a.screened !== undefined;
      const bScreened = b.screened !== undefined;
      if (aScreened !== bScreened) return aScreened ? 1 : -1;
      if (aScreened && bScreened) return b.deltaDps - a.deltaDps;
      if (a.simmed === false && b.simmed !== false) return 1;
      if (b.simmed === false && a.simmed !== false) return -1;
      return b.deltaDps - a.deltaDps;
    };
    ranked.sort(bySimmedThenDelta);
    if (!aborted) await replicateTopItems(ranked, winningRequests, baselineDps);
    ranked.sort(bySimmedThenDelta);

    let rank = 1;
    for (const item of ranked) {
      // Screened out: never measured at full precision, so there is no
      // cutoff verdict to give it and no rank to assign (§6.1) — the same
      // treatment Stop's unsimmed rows get, for the same reason.
      if (item.screened !== undefined) {
        item.rank = null;
        continue;
      }
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
      ...(warnings.length > 0 ? { plausibilityWarnings: warnings } : {}),
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
      .filter((item) => !item.belowCutoff)
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
  individualDeltasByItemId: ReadonlyMap<number, IndividualDelta>,
  baseline: DpsSample,
  simVersion: string,
  runOpts: SimRunOpts,
  packageSimSkips: {
    setId: number;
    setName: string;
    threshold: SetThreshold;
    reason: string;
  }[]
): Promise<SetBonusValue[]> {
  const setIdsWithCandidates = new Set<number>();
  for (const entry of candidates) {
    const setId = getItem(entry.itemId)?.setId;
    if (setId != null) setIdsWithCandidates.add(setId);
  }
  if (setIdsWithCandidates.size === 0) return [];

  const wornCounts = setCounts(equipment);
  const slotIndexForPoolEntry = (entry: PoolEntry): number | undefined => {
    for (const slotName of simSlotsForPoolSlot(entry.slot)) {
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
      const packageRequest = compose(deps.raidSimSkeleton, {
        name: input.character.name.toLowerCase(),
        race,
        equipment: packageEquipment,
      });

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
  return results;
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
  equipment: readonly SimItemSpec[]
): void {
  const wornCounts = setCounts(equipment);
  const bonusesBySet = new Map<number, SetBonusValue[]>();
  for (const b of setBonuses) {
    const list = bonusesBySet.get(b.setId) ?? [];
    list.push(b);
    bonusesBySet.set(b.setId, list);
  }

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
    const advancesPieceCount = piecesAfterSwap > piecesWornBefore;
    if (advancesPieceCount && !crossesThreshold && nextThreshold !== null) {
      const matching = bonusesForSet.find((b) => b.threshold === nextThreshold);
      if (matching?.bonusDps !== undefined) {
        setContext.prospectiveBonusDps = matching.bonusDps;
        if (matching.breaks && matching.breaks.length > 0) {
          setContext.prospectiveBonusBreaks = matching.breaks;
        }
      }
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
): { equipment: SimItemSpec[]; swaps: readonly MetaRepairSwap[] } {
  const swapped = swapItemAt(equipment, slotIndex, itemId, gems);
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
