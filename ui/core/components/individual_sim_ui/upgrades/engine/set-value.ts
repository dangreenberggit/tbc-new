/**
 * Set-bonus prospective value — completion-package synergy.
 *
 * PORTED from packages/core/src/set-value.ts, unchanged except for the
 * items.ts import path. Pure functions only: no sim calls, no seams — same
 * invariant as the source file.
 */

import { getItem } from "./items.js";
import type { PoolEntry } from "./pool.js";
import type { SimItemSpec } from "./slots.js";

export type SetThreshold = 2 | 4;

export const SET_THRESHOLDS: readonly SetThreshold[] = [2, 4];

export type UnmeasuredReason =
  | "not-implemented-in-sim"
  | "insufficient-pieces"
  | "sim-failed"
  | "repair-failed"
  | "unmeasurable-at-this-worn-count";

/**
 * Which (setId, threshold) bonuses have a DPS-relevant effect body in the
 * pinned wowsims Go source — same table as packages/core/src/set-value.ts,
 * carried unchanged since it is a fact about the pinned sim's Go code, not
 * about which repo is asking. Re-verify against the fork's own pin if it
 * ever moves off `8aa378b3` (plan §9 slice 7's rebase item).
 */
const IMPLEMENTED_IN_SIM: Record<
  number,
  Partial<Record<SetThreshold, boolean>>
> = {
  626: { 2: false, 4: true }, // Justicar Battlegear
  629: { 2: true, 4: true }, // Crystalforge Battlegear
  680: { 2: true, 4: true }, // Lightbringer Battlegear
  640: { 2: true, 4: true }, // Malorne Harness
  641: { 2: false, 4: true }, // Nordrassil Harness
  676: { 2: true, 4: true }, // Thunderheart Harness
};

export function isBonusImplemented(
  setId: number,
  threshold: SetThreshold
): boolean {
  return IMPLEMENTED_IN_SIM[setId]?.[threshold] ?? false;
}

export function setCounts(
  equipment: readonly SimItemSpec[]
): Map<number, number> {
  const counts = new Map<number, number>();
  for (const spec of equipment) {
    if (!spec.id) continue;
    const setId = getItem(spec.id)?.setId;
    if (setId == null) continue;
    counts.set(setId, (counts.get(setId) ?? 0) + 1);
  }
  return counts;
}

export function setLabel(
  equipment: readonly SimItemSpec[],
  setId: number,
  alsoConsider: readonly number[] = []
): string {
  for (const spec of equipment) {
    if (!spec.id) continue;
    const item = getItem(spec.id);
    if (item?.setId === setId && item.setName) return item.setName;
  }
  for (const itemId of alsoConsider) {
    const item = getItem(itemId);
    if (item?.setId === setId && item.setName) return item.setName;
  }
  return `set ${setId}`;
}

export function nextMeasurableThreshold(
  setId: number,
  piecesAfterSwap: number
): SetThreshold | null {
  for (const t of SET_THRESHOLDS) {
    if (t <= piecesAfterSwap) continue;
    if (isBonusImplemented(setId, t)) return t;
  }
  return null;
}

export type PackagePiece = {
  itemId: number;
  slotIndex: number;
};

export type PackageSelectionResult =
  | { ok: true; piecesWorn: number; addedPieces: PackagePiece[] }
  | { ok: false; reason: "insufficient-pieces" };

export type IndividualDelta = {
  itemId: number;
  slotIndex: number;
  deltaDps: number;
  se: number;
};

export function selectPackage(
  setId: number,
  threshold: SetThreshold,
  equipment: readonly SimItemSpec[],
  poolCandidates: readonly PoolEntry[],
  individualDeltas: readonly IndividualDelta[],
  slotIndexForPoolEntry: (entry: PoolEntry) => number | undefined
): PackageSelectionResult {
  const wornSlotIndices = new Set<number>();
  let piecesWorn = 0;
  for (let i = 0; i < equipment.length; i++) {
    const spec = equipment[i];
    if (!spec?.id) continue;
    if (getItem(spec.id)?.setId === setId) {
      piecesWorn++;
      wornSlotIndices.add(i);
    }
  }

  const needed = threshold - piecesWorn;
  if (needed <= 0) {
    return { ok: true, piecesWorn, addedPieces: [] };
  }

  const deltaByItemId = new Map(
    individualDeltas.map((d) => [d.itemId, d] as const)
  );

  const bestPerSlot = new Map<number, IndividualDelta & { itemId: number }>();
  for (const entry of poolCandidates) {
    const item = getItem(entry.itemId);
    if (item?.setId !== setId) continue;
    const slotIndex = slotIndexForPoolEntry(entry);
    if (slotIndex === undefined) continue;
    if (wornSlotIndices.has(slotIndex)) continue;
    const delta = deltaByItemId.get(entry.itemId);
    if (!delta) continue;

    const current = bestPerSlot.get(slotIndex);
    if (
      !current ||
      delta.deltaDps > current.deltaDps ||
      (delta.deltaDps === current.deltaDps && delta.itemId < current.itemId)
    ) {
      bestPerSlot.set(slotIndex, delta);
    }
  }

  const candidates = [...bestPerSlot.values()].sort((a, b) =>
    b.deltaDps !== a.deltaDps ? b.deltaDps - a.deltaDps : a.itemId - b.itemId
  );

  if (candidates.length < needed) {
    return { ok: false, reason: "insufficient-pieces" };
  }

  const addedPieces: PackagePiece[] = candidates
    .slice(0, needed)
    .map((c) => ({
      itemId: c.itemId,
      slotIndex: c.slotIndex,
    }))
    .sort((a, b) => a.slotIndex - b.slotIndex);

  return { ok: true, piecesWorn, addedPieces };
}

export type BrokenSetBonus = {
  setId: number;
  setName: string;
  threshold: SetThreshold;
  piecesBefore: number;
  piecesAfter: number;
};

export function brokenSetBonuses(
  equipment: readonly SimItemSpec[],
  addedPieces: readonly PackagePiece[],
  completingSetId: number
): BrokenSetBonus[] {
  const before = setCounts(equipment);
  const after = new Map(before);
  for (const piece of addedPieces) {
    const displaced = equipment[piece.slotIndex]?.id;
    const displacedSetId = displaced ? getItem(displaced)?.setId : undefined;
    if (displacedSetId != null) {
      after.set(displacedSetId, (after.get(displacedSetId) ?? 0) - 1);
    }
    const addedSetId = getItem(piece.itemId)?.setId;
    if (addedSetId != null) {
      after.set(addedSetId, (after.get(addedSetId) ?? 0) + 1);
    }
  }

  const broken: BrokenSetBonus[] = [];
  for (const [setId, piecesBefore] of before) {
    if (setId === completingSetId) continue;
    const piecesAfter = after.get(setId) ?? 0;
    if (piecesAfter >= piecesBefore) continue;
    const lost = [...SET_THRESHOLDS]
      .reverse()
      .find(
        (t) =>
          piecesBefore >= t && piecesAfter < t && isBonusImplemented(setId, t)
      );
    if (lost === undefined) continue;
    broken.push({
      setId,
      setName: setLabel(equipment, setId),
      threshold: lost,
      piecesBefore,
      piecesAfter,
    });
  }
  return broken.sort((a, b) => a.setId - b.setId);
}

export type DpsSample = { dps: number; se: number };

export function combineSe(samples: readonly DpsSample[]): number {
  return Math.sqrt(samples.reduce((sum, s) => sum + s.se * s.se, 0));
}

export type AddedPieceSample = {
  deltaDps: number;
  se: number;
};

export type SynergyInput = {
  baseline: DpsSample;
  packageSample: DpsSample;
  addedPieceSamples: readonly AddedPieceSample[];
  twoPieceBonus?: number;
};

export type SynergyResult = {
  packageDeltaDps: number;
  bonusDps: number;
  se: number;
};

export type SelfSetConfound = {
  threshold: SetThreshold;
};

export function computeSynergy(input: SynergyInput): SynergyResult {
  const packageDeltaDps = input.packageSample.dps - input.baseline.dps;
  const sumSingles = input.addedPieceSamples.reduce(
    (sum, s) => sum + s.deltaDps,
    0
  );
  const bonusDps = packageDeltaDps - sumSingles - (input.twoPieceBonus ?? 0);
  const se = combineSe([
    input.baseline,
    input.packageSample,
    ...input.addedPieceSamples.map((s) => ({ dps: 0, se: s.se })),
  ]);
  return { packageDeltaDps, bonusDps, se };
}
