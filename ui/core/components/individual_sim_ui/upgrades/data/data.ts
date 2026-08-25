/**
 * Per-spec pool + EP-weight lookup (plan §2.5). Bundled as static JSON
 * (Vite's default JSON import), same as every other data file in this
 * project — no fetch, no build step of its own.
 *
 * Ret has universes at p2-p5 but EP weights only at p2 (plan §7: "ret p3
 * rankings with p2 weights are usable but degraded" — EP only drives the
 * prefilter and gem fill, never the ranking numbers themselves, which sims
 * produce). Feral mirrors this with p1 EP weights covering p2-p3 universes.
 * See PROVENANCE.md in this directory for the exact source files and dates.
 */

import retP2Universe from "./ret-p2.universe.json";
import retP3Universe from "./ret-p3.universe.json";
import retP4Universe from "./ret-p4.universe.json";
import retP5Universe from "./ret-p5.universe.json";
import feralP2Universe from "./feral-p2.universe.json";
import feralP3Universe from "./feral-p3.universe.json";
import feralP4Universe from "./feral-p4.universe.json";
import feralP5Universe from "./feral-p5.universe.json";
import balanceP2Universe from "./balance-p2.universe.json";
import balanceP3Universe from "./balance-p3.universe.json";
import balanceP4Universe from "./balance-p4.universe.json";
import balanceP5Universe from "./balance-p5.universe.json";
import hunterP2Universe from "./hunter-p2.universe.json";
import hunterP3Universe from "./hunter-p3.universe.json";
import hunterP4Universe from "./hunter-p4.universe.json";
import hunterP5Universe from "./hunter-p5.universe.json";
import mageP2Universe from "./mage-p2.universe.json";
import mageP3Universe from "./mage-p3.universe.json";
import mageP4Universe from "./mage-p4.universe.json";
import mageP5Universe from "./mage-p5.universe.json";
import shadowP2Universe from "./shadow-p2.universe.json";
import shadowP3Universe from "./shadow-p3.universe.json";
import shadowP4Universe from "./shadow-p4.universe.json";
import shadowP5Universe from "./shadow-p5.universe.json";
import rogueP2Universe from "./rogue-p2.universe.json";
import rogueP3Universe from "./rogue-p3.universe.json";
import rogueP4Universe from "./rogue-p4.universe.json";
import rogueP5Universe from "./rogue-p5.universe.json";
import eleP2Universe from "./ele-p2.universe.json";
import eleP3Universe from "./ele-p3.universe.json";
import eleP4Universe from "./ele-p4.universe.json";
import eleP5Universe from "./ele-p5.universe.json";
import enhP2Universe from "./enh-p2.universe.json";
import enhP3Universe from "./enh-p3.universe.json";
import enhP4Universe from "./enh-p4.universe.json";
import enhP5Universe from "./enh-p5.universe.json";
import warlockP2Universe from "./warlock-p2.universe.json";
import warlockP3Universe from "./warlock-p3.universe.json";
import warlockP4Universe from "./warlock-p4.universe.json";
import warlockP5Universe from "./warlock-p5.universe.json";
import warriorP2Universe from "./warrior-p2.universe.json";
import warriorP3Universe from "./warrior-p3.universe.json";
import warriorP4Universe from "./warrior-p4.universe.json";
import warriorP5Universe from "./warrior-p5.universe.json";
import retEpWeights from "./ret-p2.ep-weights.json";
import feralEpWeights from "./feral-p1.ep-weights.json";
import balanceEpWeights from "./balance-fallback.ep-weights.json";
import hunterEpWeights from "./hunter-fallback.ep-weights.json";
import mageEpWeights from "./mage-fallback.ep-weights.json";
import shadowEpWeights from "./shadow-fallback.ep-weights.json";
import rogueEpWeights from "./rogue-fallback.ep-weights.json";
import eleEpWeights from "./ele-fallback.ep-weights.json";
import enhEpWeights from "./enh-fallback.ep-weights.json";
import warlockEpWeights from "./warlock-fallback.ep-weights.json";
import warriorEpWeights from "./warrior-fallback.ep-weights.json";

import { poolFromUniverse, type PoolEntry, type UniverseEntry } from "../engine/pool.js";
import type { ContentPhase, SpecId } from "../engine/types.js";

/**
 * JSON imports always widen to `string`/`number` (AGENTS.md "Never derive a
 * type from a JSON import" — resolveJsonModule + `as const` on a JSON import
 * is TS1355, so any narrower type here would typecheck vacuously). These
 * casts assert the shape once, at the one place raw JSON crosses into the
 * engine's `UniverseEntry`/pool vocabulary, rather than threading `any`
 * through `poolFromUniverse`. The engine itself validates nothing further —
 * a malformed entry surfaces downstream as a missing/wrong pool row, the
 * same failure mode packages/core's own JSON-backed universes have.
 */
type RawUniverse = { entries: UniverseEntry[] };

const UNIVERSES_BY_SPEC_AND_PHASE: Record<
  SpecId,
  Partial<Record<ContentPhase, RawUniverse>>
> = {
  ret: {
    2: retP2Universe as RawUniverse,
    3: retP3Universe as RawUniverse,
    4: retP4Universe as RawUniverse,
    5: retP5Universe as RawUniverse,
  },
  feral: {
    2: feralP2Universe as RawUniverse,
    3: feralP3Universe as RawUniverse,
    4: feralP4Universe as RawUniverse,
    5: feralP5Universe as RawUniverse,
  },
  balance: {
    2: balanceP2Universe as RawUniverse,
    3: balanceP3Universe as RawUniverse,
    4: balanceP4Universe as RawUniverse,
    5: balanceP5Universe as RawUniverse,
  },
  hunter: {
    2: hunterP2Universe as RawUniverse,
    3: hunterP3Universe as RawUniverse,
    4: hunterP4Universe as RawUniverse,
    5: hunterP5Universe as RawUniverse,
  },
  mage: {
    2: mageP2Universe as RawUniverse,
    3: mageP3Universe as RawUniverse,
    4: mageP4Universe as RawUniverse,
    5: mageP5Universe as RawUniverse,
  },
  shadow: {
    2: shadowP2Universe as RawUniverse,
    3: shadowP3Universe as RawUniverse,
    4: shadowP4Universe as RawUniverse,
    5: shadowP5Universe as RawUniverse,
  },
  rogue: {
    2: rogueP2Universe as RawUniverse,
    3: rogueP3Universe as RawUniverse,
    4: rogueP4Universe as RawUniverse,
    5: rogueP5Universe as RawUniverse,
  },
  ele: {
    2: eleP2Universe as RawUniverse,
    3: eleP3Universe as RawUniverse,
    4: eleP4Universe as RawUniverse,
    5: eleP5Universe as RawUniverse,
  },
  enh: {
    2: enhP2Universe as RawUniverse,
    3: enhP3Universe as RawUniverse,
    4: enhP4Universe as RawUniverse,
    5: enhP5Universe as RawUniverse,
  },
  warlock: {
    2: warlockP2Universe as RawUniverse,
    3: warlockP3Universe as RawUniverse,
    4: warlockP4Universe as RawUniverse,
    5: warlockP5Universe as RawUniverse,
  },
  warrior: {
    2: warriorP2Universe as RawUniverse,
    3: warriorP3Universe as RawUniverse,
    4: warriorP4Universe as RawUniverse,
    5: warriorP5Universe as RawUniverse,
  },
};

/**
 * One EP-weights set per spec.
 *
 * The nine specs added by the all-DPS-specs pass each bundle their
 * `fallback` file — the entry `data/presets/ep-weights-by-phase.json` names
 * for a spec below its lowest `byPhase` key. A spec whose weights were
 * written for an earlier phase than the universe being ranked is a real,
 * disclosed degradation, not a bug: EP drives only the candidate prefilter
 * and the gem fill, and every ranking number comes from the sim. The tab's
 * Assumptions block states it per run.
 */
const EP_WEIGHTS_BY_SPEC: Record<SpecId, Readonly<Record<string, number>>> = {
  ret: (retEpWeights as { weights: Record<string, number> }).weights,
  feral: (feralEpWeights as { weights: Record<string, number> }).weights,
  balance: (balanceEpWeights as { weights: Record<string, number> }).weights,
  hunter: (hunterEpWeights as { weights: Record<string, number> }).weights,
  mage: (mageEpWeights as { weights: Record<string, number> }).weights,
  shadow: (shadowEpWeights as { weights: Record<string, number> }).weights,
  rogue: (rogueEpWeights as { weights: Record<string, number> }).weights,
  ele: (eleEpWeights as { weights: Record<string, number> }).weights,
  enh: (enhEpWeights as { weights: Record<string, number> }).weights,
  warlock: (warlockEpWeights as { weights: Record<string, number> }).weights,
  warrior: (warriorEpWeights as { weights: Record<string, number> }).weights,
};

/**
 * The highest universe phase this spec actually has data for, at or below
 * `maxPhase`. Ret p3-p5 all trace back to p2 sources for tags/EP (see this
 * directory's PROVENANCE.md); the *pool membership* file chosen here is
 * still the phase-appropriate one — filterPoolByPhase (pool.ts) does the
 * per-item phase cut once the pool is loaded.
 */
function universeFor(spec: SpecId, maxPhase: ContentPhase): RawUniverse | undefined {
  return universeChoiceFor(spec, maxPhase)?.universe;
}

function universeChoiceFor(
  spec: SpecId,
  maxPhase: ContentPhase
): { universe: RawUniverse; phase: number } | undefined {
  const byPhase = UNIVERSES_BY_SPEC_AND_PHASE[spec];
  let best: RawUniverse | undefined;
  let bestPhase = 0;
  for (const [phaseKey, universe] of Object.entries(byPhase)) {
    const phase = Number(phaseKey);
    if (phase <= maxPhase && phase > bestPhase) {
      best = universe;
      bestPhase = phase;
    }
  }
  return best ? { universe: best, phase: bestPhase } : undefined;
}

/**
 * Which universe file a run drew its pool from, for the assumptions drawer.
 *
 * The chosen file is not always the one the selected phase would suggest --
 * `universeFor` falls back to the highest phase that has data at or below the
 * selection -- so a reader who assumes "phase 4 means the p4 file" can be
 * wrong. Naming the file and its entry count makes that visible instead of
 * requiring someone to know the fallback rule.
 */
export function poolSourceFor(
  spec: SpecId,
  maxPhase: ContentPhase
): { file: string; entries: number } | undefined {
  const choice = universeChoiceFor(spec, maxPhase);
  if (!choice) return undefined;
  return {
    file: `${spec}-p${choice.phase}.universe.json`,
    entries: choice.universe.entries.length,
  };
}

/**
 * The phase each spec's bundled EP weights was written for.
 *
 * `undefined` means the file carries no phase at all — elemental ships a
 * single preset labelled "Default" — which still gets disclosed, as
 * "unphased default". Saying nothing because a file has no phase number
 * would be the same silent degradation the disclosure exists to prevent.
 *
 * These are the phases named by `data/presets/ep-weights-by-phase.json` for
 * each bundled file. Ret and feral keep the values their own PROVENANCE
 * already records.
 */
const EP_WEIGHTS_PHASE_BY_SPEC: Record<SpecId, number | undefined> = {
  ret: 2,
  feral: 1,
  balance: undefined,
  hunter: 1,
  mage: 1,
  shadow: 1,
  rogue: 1,
  ele: undefined,
  enh: undefined,
  warlock: 1,
  warrior: 1,
};

/**
 * The EP-weights disclosure for a run, or `undefined` when the weights were
 * written for exactly the phase being ranked.
 *
 * EP drives only the candidate prefilter and the gem fill — every ranking
 * number comes from the sim — so a mismatch degrades the shortlist's ordering
 * rather than falsifying a DPS figure. That makes it disclosable rather than
 * blocking, but it is not nothing, and it must not be silent.
 */
export function epWeightsDisclosureFor(
  spec: SpecId,
  maxPhase: ContentPhase
): { from: string; requested: string } | undefined {
  const phase = EP_WEIGHTS_PHASE_BY_SPEC[spec];
  if (phase === maxPhase) return undefined;
  return {
    from: phase === undefined ? "an unphased default" : `P${phase}`,
    requested: `P${maxPhase}`,
  };
}

/**
 * How many of the chosen universe's entries carry no source detail.
 *
 * The nine specs added by the all-DPS-specs pass have no Wowhead list layer,
 * so their badge, PvP and vendor gear is admitted on its database `phase`
 * alone and ships `{kind: "unknown", origin: "db"}`. The item is really in
 * the pool and really available at that phase; what is missing is where it
 * comes from. Ret and feral return 0 — their list layer supplies the detail.
 */
export function unsourcedCountFor(
  spec: SpecId,
  maxPhase: ContentPhase
): number {
  const choice = universeChoiceFor(spec, maxPhase);
  if (!choice) return 0;
  let n = 0;
  for (const entry of choice.universe.entries) {
    const sources = (entry as { sources?: Array<{ kind?: string }> }).sources;
    if (sources?.length === 1 && sources[0]?.kind === "unknown") n++;
  }
  return n;
}

export function poolFor(
  spec: SpecId,
  maxPhase: ContentPhase
): readonly PoolEntry[] {
  const universe = universeFor(spec, maxPhase);
  if (!universe) return [];
  return poolFromUniverse(universe);
}

export function epWeightsFor(spec: SpecId): Readonly<Record<string, number>> {
  return EP_WEIGHTS_BY_SPEC[spec];
}

/** Every spec this data directory has a universe for, at any phase. */
export function specsWithData(): readonly SpecId[] {
  return (Object.keys(UNIVERSES_BY_SPEC_AND_PHASE) as SpecId[]).filter(
    (spec) => Object.keys(UNIVERSES_BY_SPEC_AND_PHASE[spec]).length > 0
  );
}
