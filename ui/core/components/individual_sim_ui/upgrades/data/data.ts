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
import retEpWeights from "./ret-p2.ep-weights.json";
import feralEpWeights from "./feral-p1.ep-weights.json";

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
  },
};

const EP_WEIGHTS_BY_SPEC: Record<SpecId, Readonly<Record<string, number>>> = {
  ret: (retEpWeights as { weights: Record<string, number> }).weights,
  feral: (feralEpWeights as { weights: Record<string, number> }).weights,
};

/**
 * The highest universe phase this spec actually has data for, at or below
 * `maxPhase`. Ret p3-p5 all trace back to p2 sources for tags/EP (see this
 * directory's PROVENANCE.md); the *pool membership* file chosen here is
 * still the phase-appropriate one — filterPoolByPhase (pool.ts) does the
 * per-item phase cut once the pool is loaded.
 */
function universeFor(spec: SpecId, maxPhase: ContentPhase): RawUniverse | undefined {
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
  return best;
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
