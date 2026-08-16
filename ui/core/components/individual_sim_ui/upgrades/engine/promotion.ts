/**
 * M2 promotion rule (candidate-pool.md §6.1) — a pure function.
 *
 * PORTED unchanged (import paths only) from packages/core/src/promotion.ts.
 *
 * No SE, no intervals: F10 measured the only observable SE as independent
 * (~6.8 DPS at 300 iterations), which would promote everything if used as a
 * criterion. Promotion is rank-based instead.
 */
import type { PoolEntry } from "./pool.js";

/**
 * Defaults — see `RankInput.screenIterations` and `RankInput.promoteTopK`
 * in rank.ts for the measured justification (candidate-pool.md §3.4.1's
 * defaults, corrected against the fixture that actually gates 7.2 — see
 * that doc comment for the full story). Defined once so `rank.ts` and
 * `content-hash.ts` (which must normalize an omitted knob the same way the
 * runtime applies it) cannot drift apart.
 */
export const DEFAULT_SCREEN_ITERATIONS = 1000;
export const DEFAULT_PROMOTE_TOP_K = 150;

/** One candidate's screening observation, keyed by item id. */
export type ScreeningResult = {
  itemId: number;
  deltaDps: number;
};

export type PromotionInputs = {
  screened: readonly ScreeningResult[];
  candidates: readonly PoolEntry[];
  promoteTopK: number;
  /** Item ids already worn (candidate-pool.md's "owned" — never dropped). */
  ownedItemIds: ReadonlySet<number>;
  /**
   * Item ids belonging to any set-completion package under consideration —
   * a set piece can be a below-cutoff single yet still be the best available
   * filler for a package (mirrors the full-iteration path in rank.ts).
   */
  setPackageItemIds: ReadonlySet<number>;
};

export type PromotionResult = {
  itemId: number;
  promoted: boolean;
};

/**
 * Promote candidate *c* if any of: *c* is in the global top-`promoteTopK` by
 * screening delta; *c* is best-in-slot at screening (a floor — no empty
 * slot); *c* is in a set-completion package; *c* is owned.
 *
 * Ties in the top-K cutoff break toward the lower item id, mirroring
 * `orderCandidatesByEp`'s total order (candidate-order.ts) — so the boundary
 * of the promoted set never depends on input order.
 */
export function promotionRule(input: PromotionInputs): PromotionResult[] {
  const { screened, candidates, promoteTopK, ownedItemIds, setPackageItemIds } =
    input;
  const slotByItemId = new Map(candidates.map((c) => [c.itemId, c.slot]));

  // Failed screens are excluded before the slice, not sorted to the bottom of
  // it (ticket 156): `slice(0, K)` at the shipped K of 150 takes every row of
  // any pool smaller than 150, so ordering alone still promotes a candidate
  // whose every slot attempt panicked. Promoting one spends a full-iteration
  // sim on a swap already known to crash, and then reports it as "dropped
  // from the ranking" on top of the screening failure already recorded — the
  // same reasoning the best-in-slot floor below already applies.
  const ordered = [...screened]
    .filter((s) => Number.isFinite(s.deltaDps))
    .sort((a, b) => {
      if (a.deltaDps !== b.deltaDps) return b.deltaDps - a.deltaDps;
      return a.itemId - b.itemId;
    });
  const topK = new Set(
    ordered.slice(0, Math.max(0, promoteTopK)).map((s) => s.itemId)
  );

  const bestInSlot = new Set<number>();
  const bestDeltaBySlot = new Map<
    string,
    { itemId: number; deltaDps: number }
  >();
  for (const s of screened) {
    const slot = slotByItemId.get(s.itemId);
    if (slot === undefined) continue;
    // A candidate whose every slot attempt panicked screens at -Infinity.
    // The floor exists so no slot goes unrepresented, but a slot where
    // nothing produced a number has nothing to represent: promoting the
    // argmax of two failures spends a full-iteration sim on a candidate that
    // panics again, and -Infinity serializes to JSON `null`, so a promoted
    // one would break the sort comparator on any rehydrated `Ranking`.
    if (!Number.isFinite(s.deltaDps)) continue;
    const current = bestDeltaBySlot.get(slot);
    if (
      !current ||
      s.deltaDps > current.deltaDps ||
      (s.deltaDps === current.deltaDps && s.itemId < current.itemId)
    ) {
      bestDeltaBySlot.set(slot, { itemId: s.itemId, deltaDps: s.deltaDps });
    }
  }
  for (const { itemId } of bestDeltaBySlot.values()) bestInSlot.add(itemId);

  return screened.map((s) => ({
    itemId: s.itemId,
    promoted:
      topK.has(s.itemId) ||
      bestInSlot.has(s.itemId) ||
      setPackageItemIds.has(s.itemId) ||
      ownedItemIds.has(s.itemId),
  }));
}
