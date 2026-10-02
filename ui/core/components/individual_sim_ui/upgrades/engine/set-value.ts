/**
 * Set-bonus prospective value — completion-package synergy.
 *
 * PORTED from packages/core/src/set-value.ts. Fork-only changes: the items.ts
 * import path; `brokenSetBonuses` reports every lost implemented threshold, not
 * only the highest, via `lostThresholds` (ticket 476); `netInflation`, the
 * package-synergy correction for broken worn bonuses (ticket 478); and the
 * exported `IMPLEMENTED_SET_IDS`, so a test reads the set list instead of
 * copying it. Core never received ticket 467's broken-bonus work, so these do
 * not exist there. Ticket 512 (fork-only): `SetThreshold` is any piece count,
 * and the break helpers take a `BonusCountPredicate` for which lost counts are
 * breaks. Pure
 * functions only: no sim calls, no seams — same invariant as the source file.
 */

import { getItem } from "./items.js";
import type { PoolEntry } from "./pool.js";
import type { SimItemSpec } from "./slots.js";

/**
 * A piece count of 2 or more at which a set may have a bonus. A plain number,
 * not a union of known counts: the Go sim keys set bonuses at whatever counts a
 * set defines (3 for the crafted 3-piece sets, 6 and 8 for Cryptstalker), and
 * the break side measures every count a swap loses (ticket 512).
 */
export type SetThreshold = number;

/**
 * The counts the gain side tries, and the counts the flag-off break side
 * reads with `isBonusImplemented`. Ticket 511's K5 moves the gain side off it.
 */
export const SET_THRESHOLDS: readonly SetThreshold[] = [2, 4];

/**
 * Whether losing `count` pieces' bonus of `setId` counts as a break. The
 * default, `isBonusImplemented`, reads the six-set table below; with
 * `measureBrokenSetValue` the ranking passes the worn-set ladder's gated
 * measurement instead (ticket 512, `rank.ts`).
 */
export type BonusCountPredicate = (setId: number, count: number) => boolean;

export type UnmeasuredReason =
  | "not-implemented-in-sim"
  | "insufficient-pieces"
  | "sim-failed"
  | "repair-failed"
  | "unmeasurable-at-this-worn-count"
  /**
   * The set screen dropped the set (ticket 511 K5ON, `set-screen.ts`). One
   * marker entry keeps the rows' `setContext`, so they keep their single
   * breaks and crossing; it has no package, so it is never a future.
   */
  | "screened-out";

/**
 * Which (setId, threshold) bonuses the flag-off ranking measures. It stays
 * equal to packages/core/src/set-value.ts's table so that, without
 * `measureBrokenSetValue`, the fork gives the E-W3 parity harness the same
 * `unmeasured` values and breaks as core. With the flag the break side does
 * not read it (ticket 512: the worn-set ladder measures every lost count and
 * the noise gate decides), and after ticket 511's K5 the gain side does not
 * either. The owner decided on 2026-09-28 that the tab keeps no list of
 * implemented set bonuses, so do not extend this table.
 */
const IMPLEMENTED_IN_SIM: Record<
  number,
  Partial<Record<SetThreshold, boolean>>
> = {
  // Justicar 2pc is `false` although it has an effect body: its item_sets.go
  // closure is empty, but sim/paladin/seals.go:553 (also at 8aa378b3) scales
  // the Judgement of the Crusader bonus by 1.15. The default ret APL judges
  // Crusader only in its prepull actions, so the effect is expected near 0
  // DPS (hypothesis, not measured).
  626: { 2: false, 4: true }, // Justicar Battlegear
  629: { 2: true, 4: true }, // Crystalforge Battlegear
  680: { 2: true, 4: true }, // Lightbringer Battlegear
  640: { 2: true, 4: true }, // Malorne Harness
  641: { 2: false, 4: true }, // Nordrassil Harness
  676: { 2: true, 4: true }, // Thunderheart Harness
};

/** The set ids the table above covers, for tests that pin facts per set. */
export const IMPLEMENTED_SET_IDS: readonly number[] = Object.keys(
  IMPLEMENTED_IN_SIM
).map(Number);

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
 * The counts of `setId` lost when its worn count drops from `before` to
 * `after` (`before ≥ t > after`, t ≥ 2) that `counts` accepts, highest first.
 * Every count in that range is tried; no list decides which exist.
 */
export function lostThresholds(
  setId: number,
  before: number,
  after: number,
  counts: BonusCountPredicate = isBonusImplemented
): SetThreshold[] {
  const lost: SetThreshold[] = [];
  for (let t = before; t > after && t >= 2; t--) {
    if (counts(setId, t)) lost.push(t);
  }
  return lost;
}

/**
 * Every worn bonus the added pieces break, one entry per lost count that
 * `counts` accepts, sorted by `setId` then descending threshold. A package
 * that takes Malorne from 4 to 0 loses the 4pc AND the 2pc; reporting only
 * the 4pc left the 2pc's value out of every net (ticket 476).
 */
export function brokenSetBonuses(
  equipment: readonly SimItemSpec[],
  addedPieces: readonly PackagePiece[],
  completingSetId: number,
  counts: BonusCountPredicate = isBonusImplemented
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
    for (const threshold of lostThresholds(
      setId,
      piecesBefore,
      piecesAfter,
      counts
    )) {
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
  /**
   * The confounding threshold's own value, measured by one pair sim and
   * already added back into the 4pc `bonusDps` (ticket 492). Absent when no
   * two package pieces were break-free alone and together, or that sim or its
   * gem repair failed: the 4pc `bonusDps` then still has the `−(n−1)·B2`
   * confound, and `rank.ts` leaves its `bonusDpsNet` unset.
   */
  dps?: number;
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
