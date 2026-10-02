/**
 * The partner pieces a set row is valued with, for one bonus (ticket 511,
 * ADR-0035).
 *
 * FORK-ONLY, no packages/core ancestor. A set row with Set potential on is
 * valued as a sim of gear the player could wear: the current gear plus the
 * row's item plus the other pieces of its set that reach the bonus. Those
 * other pieces are the "partner set". The owner chose this ("option A") and
 * wrote: "Maybe there's a way to just show the best "partner" and use that".
 * The owner also ruled out any player control over the choice: the player
 * picks gear in the game, not the sim setup. "One partner set per bonus,
 * chosen by one function and shown alone" is the orchestrator's reading of
 * those words (stage-gate decision log, 2026-09-28), not the owner's own.
 *
 * `choosePartnerSet` is the only place a partner set is chosen, so the rule
 * can be replaced without touching anything else. `PARTNER_RULE` names the
 * rule the tab uses; its comment gives the check (stage K5P) that chose it.
 *
 * The rules, for row r with single-swap figure d_r and a candidate partner
 * set P, where d_p is piece p's single-swap figure:
 *
 * - "close-calls" (the tab's rule): sims every set whose Z estimate is
 *   within `CLOSE_CALL_MARGIN_DPS` of the best Z estimate and takes the
 *   highest total, ties going to Z's order. A set whose sim fails is
 *   skipped; when every sim fails, Z's choice stands. When Z's estimate is
 *   undefined, the result is Z's: "break-unmeasured".
 * - "sum-of-singles" (Z): the set with the highest estimate
 *   est(P) = d_r + Σ_{p∈P} d_p + Σ_b v_b · (m_b − L_b).
 *   b runs over the worn bonuses the worn-set ladder counted, v_b is b's
 *   measured value, m_b is how many swaps in {r} ∪ P lose b alone, and L_b
 *   is 1 when the gear with every swap loses b. Each single already holds
 *   −v_b for a bonus it loses alone, so m_b − 1 of those are added back when
 *   several share one loss, and a bonus only the combination loses
 *   (m_b = 0, L_b = 1) is subtracted. Ties go to the set whose sorted item
 *   ids compare lowest.
 * - "sum-of-singles-plain" (Z0): Z without the combination-only term. Kept
 *   for scoring only.
 * - "single-swap" (T): the pieces today's `pathToThreshold` picks. Kept for
 *   scoring only.
 * - "every-combination": sims every partner set and takes the highest
 *   total, ties going to Z's order. It is the check's reference answer and
 *   writes an audit; players never run it.
 *
 * Neither this file nor its caller holds a table of set ids or piece counts.
 */

import type { BrokenSetBonus, PackagePiece } from "./set-value.js";

export type PartnerRule =
  | "close-calls"
  | "sum-of-singles"
  | "sum-of-singles-plain"
  | "single-swap"
  | "every-combination";

/**
 * The rule the tab uses. The K5P check (eight built characters, live sims at
 * 10,000 iterations) found that no zero-sim rule chose a set within noise of
 * the best simmed set on every row: outcome P-C. So the tab sims the close
 * calls. Against a player's full-pool run that adds 0 to 4.2% more sims
 * (worst character 27 of 645), and the owner accepted the cost: "I assume
 * it's a full run, 5% for a solid outcome is worth it" (stage-gate decision
 * log, 2026-10-01).
 */
export const PARTNER_RULE: PartnerRule = "close-calls";

/**
 * How far below the best Z estimate a partner set may be and still be simmed
 * by "close-calls". It is M′ = 2·M, where M = 15.9334 DPS is the largest gap
 * K5P measured between the best Z estimate and the estimate of the set the
 * sims found best, over every decided (row, bonus) of its eight characters
 * (W3-TH, Mantle of Malorne 29100, 4pc). Source: the K5P report, from
 * `python fallback_global.py results` in the stage folder
 * `.scratch/stage-gate/511-512-set-credit/k5p/`. The plan of that stage sets
 * the margin at twice M.
 */
export const CLOSE_CALL_MARGIN_DPS = 31.866872635956497;

/** One candidate piece of the row's set, at its first sim slot. */
export type PartnerPiece = {
  itemId: number;
  slotIndex: number;
  singleDeltaDps: number;
};

/**
 * The pieces a partner set is drawn from: the set's candidates that were
 * simmed as singles, outside the row's slot and the slots the set already
 * fills, keeping the best single per slot (the lower id wins a tie), in slot
 * order. Ring, trinket and one-hand pieces are keyed to their first slot, as
 * `selectPackage` keys them.
 */
export function partnerPool(args: {
  pieces: readonly PartnerPiece[];
  wornSetSlots: ReadonlySet<number>;
  rowSlotIndex: number;
}): PartnerPiece[] {
  const bestPerSlot = new Map<number, PartnerPiece>();
  for (const piece of args.pieces) {
    if (piece.slotIndex === args.rowSlotIndex) continue;
    if (args.wornSetSlots.has(piece.slotIndex)) continue;
    const current = bestPerSlot.get(piece.slotIndex);
    if (
      !current ||
      piece.singleDeltaDps > current.singleDeltaDps ||
      (piece.singleDeltaDps === current.singleDeltaDps &&
        piece.itemId < current.itemId)
    ) {
      bestPerSlot.set(piece.slotIndex, piece);
    }
  }
  return [...bestPerSlot.values()].sort((a, b) => a.slotIndex - b.slotIndex);
}

export type PartnerQuery = {
  row: { itemId: number; slotIndex: number; singleDeltaDps: number };
  setId: number;
  /** The bonus's piece count. */
  count: number;
  /** How many partner pieces reach `count` with the row worn. */
  needed: number;
  pool: readonly PartnerPiece[];
  /** The counted worn bonuses lost when every listed swap is made. */
  lostBy: (
    swaps: readonly PackagePiece[]
  ) => readonly Pick<BrokenSetBonus, "setId" | "threshold">[];
  /** A counted worn bonus's measured value; undefined when unmeasured. */
  breakDps: (setId: number, count: number) => number | undefined;
  /** The partner pieces today's single-swap path picks, if it has one. */
  todaysPieces?: readonly PackagePiece[];
  /**
   * Sims the current gear plus the row plus `partners`, returning the total
   * over the current gear. Only "every-combination" and "close-calls" call
   * it.
   */
  simGear?: (
    partners: readonly PackagePiece[]
  ) => Promise<{ totalDps: number; se: number } | undefined>;
};

/** Every set of `needed` pool pieces, each in slot order. */
export function partnerSets(query: PartnerQuery): PartnerPiece[][] {
  const out: PartnerPiece[][] = [];
  const { pool, needed } = query;
  if (needed <= 0 || needed > pool.length) return out;
  const pick = (start: number, chosen: PartnerPiece[]): void => {
    if (chosen.length === needed) {
      out.push([...chosen]);
      return;
    }
    for (let i = start; i <= pool.length - (needed - chosen.length); i++) {
      chosen.push(pool[i]!);
      pick(i + 1, chosen);
      chosen.pop();
    }
  };
  pick(0, []);
  return out;
}

const bonusKey = (b: Pick<BrokenSetBonus, "setId" | "threshold">): string =>
  `${b.setId}:${b.threshold}`;

/**
 * Rule Z's estimate of one partner set (or Z0's without the combination-only
 * term). Undefined when a worn bonus whose term is not 0 has no measured
 * value.
 */
export function sumOfSinglesEstimate(
  query: PartnerQuery,
  set: readonly PartnerPiece[],
  opts: { withCombinationOnly: boolean }
): number | undefined {
  const rowSwap: PackagePiece = {
    itemId: query.row.itemId,
    slotIndex: query.row.slotIndex,
  };
  const swaps: PackagePiece[] = [
    rowSwap,
    ...set.map((p) => ({ itemId: p.itemId, slotIndex: p.slotIndex })),
  ];
  const lostAlone = new Map<string, number>();
  const keys = new Map<string, Pick<BrokenSetBonus, "setId" | "threshold">>();
  for (const swap of swaps) {
    for (const b of query.lostBy([swap])) {
      const key = bonusKey(b);
      keys.set(key, b);
      lostAlone.set(key, (lostAlone.get(key) ?? 0) + 1);
    }
  }
  const lostTogether = new Set<string>();
  for (const b of query.lostBy(swaps)) {
    const key = bonusKey(b);
    keys.set(key, b);
    lostTogether.add(key);
  }
  let est =
    query.row.singleDeltaDps + set.reduce((s, p) => s + p.singleDeltaDps, 0);
  for (const [key, b] of keys) {
    const m = lostAlone.get(key) ?? 0;
    const lost = lostTogether.has(key) ? 1 : 0;
    if (m === 0 && !opts.withCombinationOnly) continue;
    const coefficient = m - lost;
    if (coefficient === 0) continue;
    const v = query.breakDps(b.setId, b.threshold);
    if (v === undefined) return undefined;
    est += coefficient * v;
  }
  return est;
}

export type PartnerAudit = {
  sets: Array<{
    itemIds: number[];
    totalDps: number | null;
    se: number | null;
    estimateZ: number | null;
    estimateZ0: number | null;
  }>;
  chosen: { itemIds: number[]; totalDps: number };
};

export type PartnerChoice =
  | {
      itemIds: number[];
      rule: PartnerRule;
      estimateDps?: number;
      totalDps?: number;
      audit?: PartnerAudit;
    }
  | { unmeasured: "break-unmeasured" };

const sortedIds = (set: readonly { itemId: number }[]): number[] =>
  set.map((p) => p.itemId).sort((a, b) => a - b);

/** Negative when `a`'s sorted ids compare lower than `b`'s. */
function compareIds(
  a: readonly { itemId: number }[],
  b: readonly { itemId: number }[]
): number {
  const x = sortedIds(a);
  const y = sortedIds(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i]! - y[i]!;
  }
  return x.length - y.length;
}

/**
 * The partner set for one row and one bonus under `rule`. Undefined when no
 * set of `needed` pieces exists, or every sim of "every-combination" failed.
 * `{ unmeasured: "break-unmeasured" }` when a zero-sim rule's estimate is
 * undefined for any candidate set: the row is then unmeasured rather than
 * valued on a set chosen without that bonus.
 */
export async function choosePartnerSet(
  query: PartnerQuery,
  rule: PartnerRule
): Promise<PartnerChoice | undefined> {
  if (rule === "single-swap") {
    const pieces = query.todaysPieces;
    if (!pieces || pieces.length !== query.needed) return undefined;
    return {
      itemIds: [...pieces]
        .sort((a, b) => a.slotIndex - b.slotIndex)
        .map((p) => p.itemId),
      rule,
    };
  }
  const sets = partnerSets(query);
  if (sets.length === 0) return undefined;

  if (rule === "every-combination") {
    if (!query.simGear) return undefined;
    const audit: PartnerAudit["sets"] = [];
    let best:
      | { set: PartnerPiece[]; totalDps: number; z: number | undefined }
      | undefined;
    for (const set of sets) {
      const z = sumOfSinglesEstimate(query, set, { withCombinationOnly: true });
      const z0 = sumOfSinglesEstimate(query, set, {
        withCombinationOnly: false,
      });
      const sim = await query.simGear(set);
      audit.push({
        itemIds: set.map((p) => p.itemId),
        totalDps: sim?.totalDps ?? null,
        se: sim?.se ?? null,
        estimateZ: z ?? null,
        estimateZ0: z0 ?? null,
      });
      if (!sim) continue;
      const better =
        !best ||
        sim.totalDps > best.totalDps ||
        (sim.totalDps === best.totalDps &&
          ((z ?? -Infinity) > (best.z ?? -Infinity) ||
            ((z ?? -Infinity) === (best.z ?? -Infinity) &&
              compareIds(set, best.set) < 0)));
      if (better) best = { set, totalDps: sim.totalDps, z };
    }
    if (!best) return undefined;
    const itemIds = best.set.map((p) => p.itemId);
    return {
      itemIds,
      rule,
      totalDps: best.totalDps,
      ...(best.z !== undefined ? { estimateDps: best.z } : {}),
      audit: { sets: audit, chosen: { itemIds, totalDps: best.totalDps } },
    };
  }

  const withCombinationOnly = rule !== "sum-of-singles-plain";
  const ranked: Array<{ set: PartnerPiece[]; est: number }> = [];
  for (const set of sets) {
    const est = sumOfSinglesEstimate(query, set, { withCombinationOnly });
    if (est === undefined) return { unmeasured: "break-unmeasured" };
    ranked.push({ set, est });
  }
  // Z's order: the highest estimate first, ties to the lowest sorted ids.
  ranked.sort((a, b) => b.est - a.est || compareIds(a.set, b.set));
  const top = ranked[0]!;
  if (rule !== "close-calls") {
    return {
      itemIds: top.set.map((p) => p.itemId),
      rule,
      estimateDps: top.est,
    };
  }

  const close = ranked.filter((c) => c.est >= top.est - CLOSE_CALL_MARGIN_DPS);
  // One candidate needs no comparison; its step gear is simmed later anyway.
  if (close.length === 1 || !query.simGear) {
    return {
      itemIds: top.set.map((p) => p.itemId),
      rule,
      estimateDps: top.est,
    };
  }
  let best: { set: PartnerPiece[]; est: number; totalDps: number } | undefined;
  for (const c of close) {
    const sim = await query.simGear(c.set);
    if (!sim) continue;
    // Strictly greater, so a tie keeps the earlier set in Z's order.
    if (!best || sim.totalDps > best.totalDps) {
      best = { ...c, totalDps: sim.totalDps };
    }
  }
  if (!best) {
    return {
      itemIds: top.set.map((p) => p.itemId),
      rule,
      estimateDps: top.est,
    };
  }
  return {
    itemIds: best.set.map((p) => p.itemId),
    rule,
    estimateDps: best.est,
    totalDps: best.totalDps,
  };
}
