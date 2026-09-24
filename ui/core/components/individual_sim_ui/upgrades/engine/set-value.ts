/**
 * Set-bonus prospective value — completion-package synergy.
 *
 * PORTED from packages/core/src/set-value.ts. Fork-only changes: the items.ts
 * import path; `brokenSetBonuses` reports every lost implemented threshold, not
 * only the highest, via `lostThresholds` (ticket 476); and `netInflation`, the
 * package-synergy correction for broken worn bonuses (ticket 478). Core never
 * received ticket 467's broken-bonus work, so these do not exist there. Pure
 * functions only: no sim calls, no seams — same invariant as the source file.
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

/**
 * One item's own DPS delta, used both to pick a set package's pieces and to
 * subtract the pieces' individual value out of a package's measured gain.
 *
 * `deltaDps` must estimate the item's true DPS effect — candidate minus
 * baseline, both read by the SAME engine on the same run. That is the invariant
 * `computeSynergy` depends on: it subtracts these deltas from
 * `packageSample.dps - baseline.dps`, so each one has to be an effect estimate
 * rather than an absolute reading tied to a particular engine's scale.
 *
 * A same-engine difference satisfies this automatically, including one measured
 * by the fork's bulk screening pass against that pass's own baseline probe: a
 * systematic offset between engines cancels inside the subtraction. Re-basing
 * such a delta onto some other baseline would BREAK the invariant rather than
 * restore it, by reintroducing the very offset the subtraction removed. See the
 * comment at `rank.ts`'s `individualDeltasByItemId.set` call.
 */
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

/**
 * The implemented thresholds of `setId` lost when its worn count drops from
 * `before` to `after` (`before ≥ t > after`), highest first.
 */
export function lostThresholds(
  setId: number,
  before: number,
  after: number
): SetThreshold[] {
  return [...SET_THRESHOLDS]
    .reverse()
    .filter((t) => before >= t && after < t && isBonusImplemented(setId, t));
}

/**
 * Every worn implemented bonus the added pieces break, one entry per lost
 * threshold, sorted by `setId` then descending threshold. A package that takes
 * Malorne from 4 to 0 loses the 4pc AND the 2pc; reporting only the 4pc left
 * the 2pc's value out of every net (ticket 476).
 */
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
    for (const threshold of lostThresholds(setId, piecesBefore, piecesAfter)) {
      broken.push({
        setId,
        setName: setLabel(equipment, setId),
        threshold,
        piecesBefore,
        piecesAfter,
      });
    }
  }
  return broken.sort((a, b) =>
    a.setId !== b.setId ? a.setId - b.setId : b.threshold - a.threshold
  );
}

/**
 * One broken worn bonus's counts inside a package's raw synergy, for
 * `netInflation`. `membersPkg` / `members2pc`: how many members of this package
 * / of the same set's 2pc package break it by their own single swap.
 * `pkgEnd` / `twoPcEnd`: 1 if this package's / the 2pc package's end state
 * breaks it. The 2pc fields are 0 when the package is itself the 2pc.
 */
export type InflationKey = {
  setId: number;
  threshold: number;
  membersPkg: number;
  members2pc: number;
  pkgEnd: number;
  twoPcEnd: number;
  B: number;
};

/**
 * How much a package's raw `bonusDps` overstates its bonus because of worn
 * bonuses it breaks: `Σ (membersPkg − members2pc − pkgEnd + twoPcEnd)·B`.
 *
 * `computeSynergy` gives `pkgΔ − Σsingles − raw2pc`. A broken bonus puts a −B
 * in `pkgΔ` once if the package's end state breaks it, in each member single
 * that breaks it (subtracted, so +B each), and in the raw 2pc it subtracts
 * (whose own inflation is `(members2pc − twoPcEnd)·B`, subtracted again). The
 * earlier code subtracted `twoPcEnd`; the sign was hidden at worn 4, where
 * `members2pc − twoPcEnd = 1 = twoPcEnd` (ticket 478 A3, pinned by fixture
 * 476-B in packages/core/test/fork-set-net.test.ts).
 */
export function netInflation(keys: readonly InflationKey[]): number {
  return keys.reduce(
    (sum, k) =>
      sum + (k.membersPkg - k.members2pc - k.pkgEnd + k.twoPcEnd) * k.B,
    0
  );
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
