/**
 * Pre-sim candidate ordering (plan §5.1.3 — candidate-pool.md M1).
 *
 * Sorts eligible candidates by committed-EP delta against the owned item in
 * that slot, computed from raw item data — no gem repair — so the order
 * exists before any sim runs and can never fail on a candidate the sim
 * itself would reject. Ordering only changes *when* a row fills and what a
 * pre-M2 cap keeps; it never changes a displayed number (plan §0).
 */
import { HandType } from "@generated/proto/common";

import { getItem } from "./items";
import { type PoolEntry, type SimSlotName, simSlotsForPoolSlot } from "./pool";
import { SIM_ORDER, type SimItemSpec } from "./slots";
import type { SpecId } from "./types";

/**
 * An item's EP in one sim slot. The slot matters for weapons: wowsims prices
 * weapon damage per second at the main-hand, off-hand or ranged weight of
 * the slot the weapon goes in (`EquippedItem.calcStats(slot)`). Unknown
 * item → 0.
 */
export type ItemEp = (itemId: number, slot: SimSlotName) => number;

const OFFHAND_INDEX = SIM_ORDER.indexOf("offhand");

/**
 * The best committed-EP delta a candidate could offer, taken as the max
 * across every sim slot its pool slot maps to (mirroring how the real
 * candidate loop tries every paired-slot placement and keeps the best) — so
 * a ring or trinket candidate is judged against whichever worn piece it
 * would actually be worth replacing, not an arbitrary side.
 *
 * A two-hander in the main hand is also charged the worn off hand, because
 * the candidate sim clears it (`clearOffHandForTwoHander` in rank.ts).
 *
 * A slot name outside `SIM_ORDER` and a candidate with no slot resolve to a
 * delta of 0 rather than throwing — this must run before any sim, with no
 * sim result yet to explain a skip.
 */
function bestEpDelta(
  entry: PoolEntry,
  equipment: readonly SimItemSpec[],
  itemEp: ItemEp,
  spec?: SpecId
): number {
  const wornEp = (slotName: SimSlotName, slotIndex: number): number => {
    const wornId = equipment[slotIndex]?.id;
    return wornId === undefined ? 0 : itemEp(wornId, slotName);
  };
  const twoHander = getItem(entry.itemId)?.handType === HandType.HandTypeTwoHand;
  let best: number | undefined;
  for (const slotName of simSlotsForPoolSlot(entry.slot, spec, entry.itemId)) {
    const slotIndex = SIM_ORDER.indexOf(slotName);
    if (slotIndex < 0) continue;
    let delta = itemEp(entry.itemId, slotName) - wornEp(slotName, slotIndex);
    if (twoHander && slotName === "mainhand") {
      delta -= wornEp("offhand", OFFHAND_INDEX);
    }
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
  itemEp: ItemEp,
  spec?: SpecId
): PoolEntry[] {
  const delta = new Map(
    candidates.map((c) => [c, bestEpDelta(c, equipment, itemEp, spec)])
  );
  return [...candidates].sort((a, b) => {
    const deltaA = delta.get(a) ?? 0;
    const deltaB = delta.get(b) ?? 0;
    if (deltaA !== deltaB) return deltaB - deltaA;
    return a.itemId - b.itemId;
  });
}
