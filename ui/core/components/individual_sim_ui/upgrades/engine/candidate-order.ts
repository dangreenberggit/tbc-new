/**
 * Pre-sim candidate ordering (plan §5.1.3 — candidate-pool.md M1).
 *
 * Sorts eligible candidates by committed-EP delta against the owned item in
 * that slot, computed from raw item stats — no gem repair — so the order
 * exists before any sim runs and can never fail on a candidate the sim
 * itself would reject. Ordering only changes *when* a row fills and what a
 * pre-M2 cap keeps; it never changes a displayed number (plan §0).
 */
import { simSlotsForPoolSlot, type PoolEntry } from "./pool.js";
import { SIM_ORDER, type SimItemSpec } from "./slots.js";
import { epScore, type EpWeights } from "./stats.js";

/** Looks up an item's raw stats array by id; missing id → no stats (`[]`). */
export type StatsLookup = (itemId: number) => readonly number[];

/**
 * The best committed-EP delta a candidate could offer, taken as the max
 * across every sim slot its pool slot maps to (mirroring how the real
 * candidate loop tries every paired-slot placement and keeps the best) — so
 * a ring or trinket candidate is judged against whichever worn piece it
 * would actually be worth replacing, not an arbitrary side.
 *
 * Missing stats (`StatsLookup` returning `[]`) and a slot name outside
 * `SIM_ORDER` both resolve to a delta of 0 rather than throwing — this must
 * run before any sim, with no sim result yet to explain a skip.
 */
function bestEpDelta(
  entry: PoolEntry,
  equipment: readonly SimItemSpec[],
  weights: EpWeights,
  stats: StatsLookup
): number {
  const candidateEp = epScore(stats(entry.itemId), weights);
  let best: number | undefined;
  for (const slotName of simSlotsForPoolSlot(entry.slot)) {
    const slotIndex = SIM_ORDER.indexOf(slotName);
    if (slotIndex < 0) continue;
    const wornId = equipment[slotIndex]?.id;
    const wornEp = wornId === undefined ? 0 : epScore(stats(wornId), weights);
    const delta = candidateEp - wornEp;
    if (best === undefined || delta > best) best = delta;
  }
  return best ?? 0;
}

/**
 * Sorts `candidates` by `bestEpDelta` descending, ties broken by item id
 * ascending — a total order, so two runs over the same input never disagree
 * on placement. Does not mutate `candidates`.
 */
export function orderCandidatesByEp(
  candidates: readonly PoolEntry[],
  equipment: readonly SimItemSpec[],
  weights: EpWeights,
  stats: StatsLookup
): PoolEntry[] {
  return [...candidates].sort((a, b) => {
    const deltaA = bestEpDelta(a, equipment, weights, stats);
    const deltaB = bestEpDelta(b, equipment, weights, stats);
    if (deltaA !== deltaB) return deltaB - deltaA;
    return a.itemId - b.itemId;
  });
}
