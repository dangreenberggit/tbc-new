/**
 * Why a slot has no upgrade in it.
 *
 * PORTED from packages/core/src/dead-slots.ts, unchanged except for the
 * items.ts import path and, fork-only (ticket 512), the `counts` option for
 * which lost counts are breaks.
 */

import { getItem } from "./items.js";
import {
  type BonusCountPredicate,
  isBonusImplemented,
  type SetThreshold,
} from "./set-value.js";

export const THIN_POOL_CANDIDATES = 4;

export const UNIQUE_EFFECT_GAP_DPS = -50;

export type DeadSlotCause =
  | "set-break-toll"
  | "unique-effect"
  | "thin-pool"
  | "unknown-item"
  | "unidentified-worn-item"
  | "worn-unrankable"
  | "benign-nothing-better";

export type DeadSlotRow = {
  itemId: number;
  name: string;
  slot: string;
  deltaDps: number;
  owned?: boolean;
};

export type DeadSlot = {
  slot: string;
  cause: DeadSlotCause;
  wornItemId: number | null;
  wornItemName: string | null;
  wornSetId: number | null;
  wornSetName: string | null;
  brokenThreshold?: SetThreshold;
  runnerUpGapDps: number | null;
  tiedCandidates: number | null;
  poolSize: number;
};

export type WornUnrankableItem = {
  itemId: number;
  itemName: string;
  slot: string;
};

export type ClassifyDeadSlotsOptions = {
  wornSetCounts: ReadonlyMap<number, number>;
  wornUnrankable?: readonly WornUnrankableItem[];
  /** Which lost counts are breaks; `isBonusImplemented` when absent. */
  counts?: BonusCountPredicate;
};

/** Dropping one piece loses exactly the worn count, if it is a break. */
function thresholdLostByDroppingOnePiece(
  setId: number,
  piecesWorn: number,
  counts: BonusCountPredicate
): SetThreshold | null {
  return piecesWorn >= 2 && counts(setId, piecesWorn) ? piecesWorn : null;
}

function wornRowsOf(slotRows: readonly DeadSlotRow[]): DeadSlotRow[] {
  const owned = slotRows.filter((r) => r.owned === true);
  if (owned.length > 0) return owned.filter((r) => r.deltaDps === 0);
  return [];
}

export function classifyDeadSlots(
  rows: readonly DeadSlotRow[],
  options: ClassifyDeadSlotsOptions
): DeadSlot[] {
  const bySlot = new Map<string, DeadSlotRow[]>();
  for (const row of rows) {
    const list = bySlot.get(row.slot);
    if (list) list.push(row);
    else bySlot.set(row.slot, [row]);
  }

  const dead: DeadSlot[] = [];

  const unrankableSlots = new Set(
    (options.wornUnrankable ?? []).map((w) => w.slot)
  );
  for (const worn of options.wornUnrankable ?? []) {
    const slotRows = bySlot.get(worn.slot) ?? [];
    dead.push({
      slot: worn.slot,
      cause: "worn-unrankable",
      wornItemId: worn.itemId,
      wornItemName: worn.itemName,
      wornSetId: null,
      wornSetName: null,
      runnerUpGapDps: null,
      tiedCandidates: null,
      poolSize: slotRows.length,
    });
  }

  for (const [slot, slotRows] of bySlot) {
    if (unrankableSlots.has(slot)) continue;
    const best = Math.max(...slotRows.map((r) => r.deltaDps));
    if (best > 0) continue;

    const wornRows = wornRowsOf(slotRows);
    if (wornRows.length === 0) {
      if (slotRows.length === 0) continue;
      dead.push({
        slot,
        cause: "unidentified-worn-item",
        wornItemId: null,
        wornItemName: null,
        wornSetId: null,
        wornSetName: null,
        runnerUpGapDps: null,
        tiedCandidates: null,
        poolSize: slotRows.length,
      });
      continue;
    }

    for (const wornRow of wornRows) {
      const candidates = slotRows.filter((r) => !wornRows.includes(r));

      const strictlyWorse = candidates.filter((r) => r.deltaDps < 0);
      const tiedCandidates = candidates.length - strictlyWorse.length;
      const runnerUpGapDps =
        strictlyWorse.length > 0
          ? Math.max(...strictlyWorse.map((r) => r.deltaDps))
          : 0;

      const wornItem = getItem(wornRow.itemId);
      const wornSetId = wornItem?.setId ?? null;
      const wornSetName = wornItem?.setName ?? null;

      const brokenThreshold =
        wornSetId === null
          ? null
          : thresholdLostByDroppingOnePiece(
              wornSetId,
              options.wornSetCounts.get(wornSetId) ?? 0,
              options.counts ?? isBonusImplemented
            );

      let cause: DeadSlotCause;
      if (wornItem === undefined) {
        cause = "unknown-item";
      } else if (brokenThreshold !== null) {
        cause = "set-break-toll";
      } else if (candidates.length < THIN_POOL_CANDIDATES) {
        cause = "thin-pool";
      } else if (runnerUpGapDps <= UNIQUE_EFFECT_GAP_DPS) {
        cause = "unique-effect";
      } else {
        cause = "benign-nothing-better";
      }

      const entry: DeadSlot = {
        slot,
        cause,
        wornItemId: wornRow.itemId,
        wornItemName: wornRow.name,
        wornSetId,
        wornSetName,
        runnerUpGapDps,
        tiedCandidates,
        poolSize: candidates.length,
      };
      if (brokenThreshold !== null) entry.brokenThreshold = brokenThreshold;
      dead.push(entry);
    }
  }
  return dead;
}
