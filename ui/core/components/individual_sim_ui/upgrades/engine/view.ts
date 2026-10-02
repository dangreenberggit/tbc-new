/**
 * The view layer. Pure: a re-render of a `Ranking` that already exists. No
 * seam, no I/O, no sim, and nothing here reaches `contentHash`.
 *
 * PORTED from packages/core/src/view.ts. The Set-potential credit (ticket 467)
 * reads the corrected `setContext.futureBonuses`, and the breaks (ticket 490)
 * and the other pieces' own stats (ticket 502) on each future's own path, that
 * the engine attaches — a true net (gains minus
 * the measured broken-bonus losses) — rather
 * than the old single nearest-threshold prospective bonus. The ticket-90
 * confound guard is gone: `bonusDpsNet` is already corrected for that inflation,
 * and a row whose loss could not be measured drops to disclosure-only here by
 * the missing-`dps` fallback below.
 *
 * Ticket 511 (fork-only): on a step ranking (`setContext.stepRanking`), a set
 * row is credited from sims of the gear it would be worn in. Each future
 * whose same-gear gate cleared has `stepGearDps`, the sim of the current
 * gear plus the row plus its partner pieces minus the sim of the current
 * gear; the credit is the best `stepGearDps − singleDeltaDps` (best stop), and
 * none of `dps`, the path pieces, the path breaks or `commitBreaks` is read.
 */
import {
  type Cutoff,
  meetsCutoff,
  setBonusNoiseFloorDps,
} from "./cutoff.js";
import { type ItemSource,sourceMatchesBoss } from "./pool.js";
import type { RankedItem, Ranking, SetContext } from "./rank.js";
import { clearsSameGearGate } from "./set-less-copies.js";
import { nextMeasurableThreshold } from "./set-value.js";

export type SetCreditView = "full" | "split";

/**
 * How far the ON credit assumes a player commits (ticket 490).
 * "best-stop": to the threshold where committing pays best on full values,
 * or not at all; only a threshold whose bonus clears the noise floor can be
 * the stop (ticket 502). "full-path": to every credited threshold, counting
 * every piece and charging every break on the way. Which a player does is a
 * preference, not a game fact; best-stop is the owner's choice (confirmed
 * 2026-09-24, ticket 490).
 */
export type SetCreditRule = "best-stop" | "full-path";
export const RULE_490: SetCreditRule = "best-stop";

type SetContextLike = Partial<
  Pick<
    SetContext,
    | "futureBonuses"
    | "commitBreaks"
    | "singleBreaks"
    | "crossesThreshold"
    | "setName"
    | "piecesWornBefore"
    | "stepRanking"
    | "singleDeltaDps"
  >
>;

type FutureLike = NonNullable<SetContext["futureBonuses"]>[number];

/**
 * One itemised line of the ON credit, in the order the walk counts it. `dps`
 * is the signed contribution: a break is negative.
 */
export type SetPotentialTerm =
  | {
      kind: "bonus";
      setName: string;
      threshold: number;
      have: number;
      dps: number;
    }
  | { kind: "piece"; itemId: number; name: string; dps: number }
  | { kind: "break"; setName: string; threshold: number; dps: number }
  /**
   * One eligible bonus of a step ranking (ticket 511): its step gear's total
   * over the current gear, the partner pieces it adds (in sim slot order)
   * and the worn bonuses it loses. These lines are totals, not parts of the
   * credit; `isStop` marks the one the credit stops at.
   */
  | {
      kind: "stop";
      threshold: number;
      setName: string;
      pieces: Array<{ itemId: number; name: string }>;
      broken: Array<{
        setId: number;
        setName: string;
        threshold: number;
        dps?: number;
      }>;
      totalDps: number;
      isStop: boolean;
    };

export type ViewOptions = {
  pinBis?: boolean;
  raid?: string;
  boss?: string;
  groupBy?: "rank" | "slot" | "raid";
  hideOwned?: boolean;
  withSetPotential?: boolean;
  setCredit?: SetCreditView;
};

export type ViewRow = RankedItem & {
  tieGroupId?: string;
  belowCutoffInView: boolean;
};

export type ViewResult = {
  rows: ViewRow[];
  shortlist: ViewRow[];
  belowCutoffCount: number;
  pinBisAvailable: boolean;
  groups?: Array<{ key: string; rows: ViewRow[] }>;
};

function sourcesOf(item: RankedItem): ItemSource[] {
  return item.sources ?? [item.source];
}

function matchesZone(item: RankedItem, zone: string): boolean {
  return sourcesOf(item).some((s) => "zone" in s && s.zone === zone);
}

function matchesBoss(item: RankedItem, zone: string | undefined, boss: string) {
  return sourcesOf(item).some((s) => sourceMatchesBoss(s, boss, zone));
}

/**
 * Display label for every zoneless source kind. Ticket 288: the tab
 * (`upgrades_tab.tsx`'s `sourceLabel`) renders the same per-item source
 * label the raid filter groups here, from this one map, so the two cannot
 * drift the way they did before fork e637fa284 (heroic items filed under
 * "Raid zones" as the raw `"heroic"` token).
 */
export const SOURCE_LABELS: Record<string, string> = {
  badge: "Badge vendor",
  crafted: "Crafted",
  rep: "Reputation vendor",
  pvp: "PvP vendor",
  world: "World drop",
  heroic: "Heroic dungeon",
  unknown: "Source not recorded",
};

function zoneKeyOf(item: RankedItem): string {
  for (const s of sourcesOf(item)) {
    if ("zone" in s) return s.zone;
  }
  return SOURCE_LABELS[item.source.kind] ?? item.source.kind;
}

export type RaidFilterGroup = { key: string; options: string[] };

/**
 * Zones and zoneless buckets, each under its own group key, in that order.
 * Flattening `groups.flatMap(g => g.options)` reproduces the old flat list.
 */
export function raidFilterGroups(items: readonly RankedItem[]): RaidFilterGroup[] {
  const zoneless = new Set(Object.values(SOURCE_LABELS));
  const zones: string[] = [];
  const buckets: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const key = zoneKeyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    (zoneless.has(key) ? buckets : zones).push(key);
  }
  const groups: RaidFilterGroup[] = [];
  if (zones.length > 0) groups.push({ key: 'zone', options: zones });
  if (buckets.length > 0) groups.push({ key: 'other', options: buckets });
  return groups;
}

function matchesRaidFilter(item: RankedItem, value: string): boolean {
  if (matchesZone(item, value)) return true;
  const key = zoneKeyOf(item);
  return key === value && !sourcesOf(item).some((s) => "zone" in s);
}

function tieWindow(a: ViewRow, b: ViewRow): number {
  const se =
    a.seMethod === b.seMethod ? Math.min(a.se, b.se) : Math.max(a.se, b.se);
  return se * 2;
}

function assignTieGroups(
  rows: ViewRow[],
  sortKey: (r: ViewRow) => number
): void {
  const groupIdRef = { next: 1 };
  const byDelta = [...rows].sort((a, b) => sortKey(b) - sortKey(a));
  let groupStart = 0;

  const flush = (end: number) => {
    if (end - groupStart > 1) {
      const id = `tie-${groupIdRef.next}`;
      groupIdRef.next += 1;
      for (let i = groupStart; i < end; i += 1) byDelta[i]!.tieGroupId = id;
    }
  };

  for (let i = 1; i <= byDelta.length; i += 1) {
    const leader = byDelta[groupStart]!;
    const row = byDelta[i];
    const overlapsLeader =
      row !== undefined &&
      sortKey(leader) - sortKey(row) <= tieWindow(row, leader);
    if (!overlapsLeader) {
      flush(i);
      groupStart = i;
    }
  }
}

function belowCutoffUnderView(
  item: RankedItem,
  withSetPotential: boolean,
  baselineDps: number,
  cutoff: Cutoff,
  setCredit: SetCreditView
): boolean {
  if (!withSetPotential) return item.belowCutoff;
  const prospective = rankableSetPotential(
    item,
    setBonusNoiseFloorDps(cutoff),
    setCredit
  );
  if (prospective === 0) return item.belowCutoff;
  const effectiveDps = item.deltaDps + prospective;
  const effectivePct =
    baselineDps === 0 ? item.deltaPct : (effectiveDps / baselineDps) * 100;
  return !meetsCutoff(effectiveDps, effectivePct, cutoff);
}

/**
 * True when a row has future bonuses but some figure its ON credit depends on
 * was not measured: a future's own value, a break or a piece on a future's
 * path (ticket 502), or a commit break of the top package (ticket 477). The
 * credit is then 0 and the tab says "not counted" (ticket 491). False without
 * futures: nothing is credited, so nothing is withheld. A future with no
 * `pieces` field has no path, so it has no piece to be missing.
 */
export function setCreditUnmeasured(ctx: SetContextLike | undefined): boolean {
  const future = ctx?.futureBonuses ?? [];
  if (future.length === 0) return false;
  // A step ranking (ticket 511) is unmeasured exactly when a future lacks its
  // same-gear value and is not below the gate, or a future whose gate cleared
  // lacks its step gear's sim or its partner choice. A below-gate future never
  // zeroes the row, and `commitBreaks` are not read (C171).
  if (ctx?.stepRanking) {
    return future.some((f) => {
      if (f.belowGate) return false;
      if (f.sameGearDps === undefined) return true;
      return f.stepGearDps === undefined || f.partnerUnmeasured !== undefined;
    });
  }
  return (
    future.some(
      (f) =>
        f.dps === undefined ||
        (f.breaks ?? []).some((b) => b.dps === undefined) ||
        (f.pieces ?? []).some((p) => p.dps === undefined)
    ) || (ctx?.commitBreaks ?? []).some((b) => b.dps === undefined)
  );
}

/**
 * Which DPS-cell sub-line a set row shows (ticket 491): none when there is
 * nothing to disclose, "not counted" when the ON credit is zeroed by an
 * unmeasured figure, else the hover hint. The tab renders the string for the
 * key; the choice lives here so it cannot drift from `rankableSetPotential`.
 */
export function setBonusSubLine(
  ctx: SetContextLike | undefined,
  on: boolean
): "not_counted" | "hover_hint" | null {
  if (!ctx) return null;
  const anyDisclosure =
    (ctx.singleBreaks ?? []).length > 0 ||
    ctx.crossesThreshold === true ||
    (ctx.futureBonuses ?? []).length > 0 ||
    (!ctx.stepRanking && (ctx.commitBreaks ?? []).length > 0);
  if (!anyDisclosure) return null;
  return on && setCreditUnmeasured(ctx) ? "not_counted" : "hover_hint";
}

type CreditWalk = {
  credit: number;
  split: number;
  stopThreshold: number;
  terms: SetPotentialTerm[];
};

/**
 * The credit arithmetic, once every figure is known to be measured (tickets
 * 490 and 502). Futures are walked in threshold order. Each step adds its
 * floored bonus, the own stats of each path piece no lower step counted, and
 * minus each path break no lower step charged. A break is charged at its
 * measured value, not floored: each piece's own stats add that same value
 * back, so the two cancel and a row inside a measured package sums to the
 * package's delta (ADR-0034).
 *
 * best-stop: keep the running total and stop at the threshold where it is
 * largest, or not at all when no total is positive. Only a step whose bonus
 * clears the floor can be the stop; otherwise a row would be credited with
 * another item's stats and no bonus. A step below the floor still counts its
 * pieces and breaks, because a higher step's path holds them.
 *
 * full-path: every step whose bonus clears the floor, and the credit is the
 * total after the last one. A skipped step's pieces and breaks are counted at
 * the next step, whose path holds them.
 *
 * The split view keeps its per-step formula, each bonus at its per-piece
 * share minus floored breaks and no pieces, taken at the full view's stop. It
 * is not clamped: the stopping point is the player's, not the display's.
 *
 * The top package's `commitBreaks` are not charged: a row whose own path to
 * each future keeps the other set's bonus should not pay for a slot only the
 * top package vacates (a Malorne chest row charged the Thunderheart 2pc).
 */
function walkCredit(
  ctx: SetContextLike | undefined,
  noiseFloorDps: number,
  rule: SetCreditRule
): CreditWalk {
  if (ctx?.stepRanking) return walkSteps(ctx, noiseFloorDps, rule);
  const future = [...(ctx?.futureBonuses ?? [])].sort(
    (a, b) => a.threshold - b.threshold
  );
  const floored = (v: number): number => (v > noiseFloorDps ? v : 0);
  const counted = new Set<number>();
  const charged = new Set<string>();
  const terms: SetPotentialTerm[] = [];
  let running = 0;
  let splitRunning = 0;
  let best: Omit<CreditWalk, "terms"> & { keep: number } = {
    credit: 0,
    split: 0,
    stopThreshold: 0,
    keep: 0,
  };
  for (const f of future) {
    const bonus = floored(f.dps!);
    if (rule === "full-path" && bonus === 0) continue;
    const add = (term: Exclude<SetPotentialTerm, { kind: "stop" }>) => {
      terms.push(term);
      running += term.dps;
    };
    if (bonus > 0) {
      add({
        kind: "bonus",
        setName: ctx?.setName ?? "",
        threshold: f.threshold,
        have: ctx?.piecesWornBefore ?? 0,
        dps: bonus,
      });
    }
    for (const p of f.pieces ?? []) {
      if (counted.has(p.itemId)) continue;
      counted.add(p.itemId);
      add({ kind: "piece", itemId: p.itemId, name: p.name, dps: p.dps! });
    }
    let splitLoss = 0;
    for (const brk of f.breaks ?? []) {
      const key = `${brk.setId}:${brk.threshold}`;
      if (charged.has(key)) continue;
      charged.add(key);
      splitLoss += floored(brk.dps!);
      if (brk.dps! === 0) continue;
      add({
        kind: "break",
        setName: brk.setName,
        threshold: brk.threshold,
        dps: -brk.dps!,
      });
    }
    splitRunning += floored(f.dps! / f.threshold) - splitLoss;
    if (rule === "full-path" || (bonus > 0 && running > best.credit)) {
      best = {
        credit: running,
        split: splitRunning,
        stopThreshold: f.threshold,
        keep: terms.length,
      };
    }
  }
  return {
    credit: best.credit,
    split: best.split,
    stopThreshold: best.stopThreshold,
    terms: terms.slice(0, best.keep),
  };
}

/**
 * Whether a step ranking's future can be a stop (ticket 511): its same-gear
 * value clears the noise gate. False when it is below the gate or has no
 * same-gear value.
 */
export function stepEligible(
  future: Pick<FutureLike, "belowGate" | "sameGearDps" | "sameGearSe">,
  noiseFloorDps: number
): boolean {
  if (future.belowGate || future.sameGearDps === undefined) return false;
  return clearsSameGearGate(
    future.sameGearDps,
    future.sameGearSe ?? 0,
    noiseFloorDps
  );
}

/**
 * The step rule (ticket 511). Walk the eligible futures in count order with
 * c = `stepGearDps` − d_r, the row's single-swap figure before replication.
 * best-stop: the stop is the future whose c is strictly greater than the best
 * so far, which starts at 0; the credit is that c, or 0. full-path: the stop is
 * the last eligible future. So a credited row's figure, `deltaDps` + credit,
 * is the sim of its stop gear whenever replication did not rewrite it. No
 * figure from single swaps is added up.
 *
 * The split view keeps its per-step formula with `sameGearDps` in place of the
 * bonus: each eligible step adds its value per piece and loses each newly
 * lost worn bonus beyond the row's own break, floored, taken at the stop.
 */
function walkSteps(
  ctx: SetContextLike,
  noiseFloorDps: number,
  rule: SetCreditRule
): CreditWalk {
  const singleDeltaDps = ctx.singleDeltaDps;
  const eligible = [...(ctx.futureBonuses ?? [])]
    .filter(
      (f) => f.stepGearDps !== undefined && stepEligible(f, noiseFloorDps)
    )
    .sort((a, b) => a.threshold - b.threshold);
  if (singleDeltaDps === undefined || eligible.length === 0) {
    return { credit: 0, split: 0, stopThreshold: 0, terms: [] };
  }
  const floored = (v: number): number => (v > noiseFloorDps ? v : 0);
  const charged = new Set(
    (ctx.singleBreaks ?? []).map((b) => `${b.setId}:${b.threshold}`)
  );
  let splitRunning = 0;
  let best = { credit: 0, split: 0, stopThreshold: 0 };
  for (const f of eligible) {
    let splitLoss = 0;
    for (const brk of f.breaks ?? []) {
      const key = `${brk.setId}:${brk.threshold}`;
      if (charged.has(key)) continue;
      charged.add(key);
      splitLoss += floored(brk.dps ?? 0);
    }
    splitRunning += floored(f.sameGearDps! / f.threshold) - splitLoss;
    const c = f.stepGearDps! - singleDeltaDps;
    if (rule === "full-path" || c > best.credit) {
      best = { credit: c, split: splitRunning, stopThreshold: f.threshold };
    }
  }
  const terms: SetPotentialTerm[] = eligible.map((f) => ({
    kind: "stop",
    threshold: f.threshold,
    setName: ctx.setName ?? "",
    pieces: (f.pieces ?? []).map((p) => ({ itemId: p.itemId, name: p.name })),
    broken: (f.breaks ?? []).map((b) => ({
      setId: b.setId,
      setName: b.setName,
      threshold: b.threshold,
      ...(b.dps !== undefined ? { dps: b.dps } : {}),
    })),
    totalDps: f.stepGearDps!,
    isStop: f.threshold === best.stopThreshold,
  }));
  return { ...best, terms };
}

/**
 * The count a crossing row's "Item stats + {set} {n}pc" label names. On a step
 * ranking (ticket 511) it is the row's count after the swap, because the
 * crossing gate measured that count; elsewhere it is the six-set table's next
 * bonus above the worn count. Null when the row crosses nothing.
 */
export function crossingLabelCount(
  ctx:
    | Pick<
        SetContext,
        | "setId"
        | "piecesWornBefore"
        | "piecesAfterSwap"
        | "crossesThreshold"
        | "stepRanking"
      >
    | undefined,
  stepRanking: boolean = ctx?.stepRanking === true
): number | null {
  if (!ctx?.crossesThreshold) return null;
  if (stepRanking) return ctx.piecesAfterSwap;
  return (
    nextMeasurableThreshold(ctx.setId, ctx.piecesWornBefore) ??
    ctx.piecesAfterSwap
  );
}

/**
 * The full-view credit and its itemised terms up to the stop, for the tab's
 * popover (ticket 502): each counted step's bonus (none when it floors to 0),
 * then the pieces it adds, then the breaks it charges. The terms add up to
 * `credit`. On a step ranking (ticket 511) the terms are one `"stop"` total
 * per eligible bonus instead, which do not add up to `credit`. Call it only
 * when `setCreditUnmeasured` is false.
 */
export function setPotentialTerms(
  ctx: SetContextLike | undefined,
  noiseFloorDps: number,
  rule: SetCreditRule = RULE_490
): { credit: number; stopThreshold: number; terms: SetPotentialTerm[] } {
  const { credit, stopThreshold, terms } = walkCredit(ctx, noiseFloorDps, rule);
  return { credit, stopThreshold, terms };
}

/**
 * One step of a step ranking's row (K6, the owner's "steps that add up"): the
 * partner pieces this step adds to the previous step's gear, the bonus it
 * reaches, the worn bonuses it newly loses, and `dps`, its total minus the
 * previous step's total (the first step's minus the row's single swap).
 */
export type SetPotentialStep = {
  kind: "step";
  threshold: number;
  setName: string;
  pieces: Array<{ itemId: number; name: string }>;
  broken: Array<{
    setId: number;
    setName: string;
    threshold: number;
    dps?: number;
  }>;
  dps: number;
  isStop: boolean;
  /**
   * The values of the two lines a step that newly loses a worn bonus splits
   * into (K6B): the Breaks line, the bonus-off gear's sim minus the previous
   * total (−Y), and the pieces line, the step's total minus the bonus-off
   * gear's sim (X). Both are present or both are absent, and they add up to
   * `dps`.
   */
  breaksLineDps?: number;
  piecesLineDps?: number;
};

/**
 * The step ranking's `"stop"` totals up to the stop, turned into steps (K6).
 * The steps' `dps` telescope (C86): they add up to the stop's total minus the
 * single swap, which is the credit. Null when the row has no stop, or when a
 * step's partner pieces do not include the previous step's (the sets do not
 * nest), because then no step is a purchase on top of the one before; the tab
 * shows such a row's totals as separate outcomes. The first step does not
 * name the row's own breaks: the popover lists them above the steps. A step
 * that newly loses a worn bonus gets its two line values (K6B) only when its
 * future's bonus-off sim turned off exactly those bonuses; otherwise, as when
 * that sim failed or the ranking predates it, the step stays one line.
 */
export function setPotentialSteps(
  ctx: SetContextLike | undefined,
  noiseFloorDps: number,
  rule: SetCreditRule = RULE_490
): SetPotentialStep[] | null {
  if (!ctx?.stepRanking || ctx.singleDeltaDps === undefined) return null;
  const stops = walkSteps(ctx, noiseFloorDps, rule).terms.filter(
    (t): t is Extract<SetPotentialTerm, { kind: "stop" }> => t.kind === "stop"
  );
  const last = stops.findIndex((t) => t.isStop);
  if (last < 0) return null;
  const keyOf = (b: { setId: number; threshold: number }) =>
    `${b.setId}:${b.threshold}`;
  let prevIds = new Set<number>();
  let prevBroken = new Set((ctx.singleBreaks ?? []).map(keyOf));
  let prevTotal = ctx.singleDeltaDps;
  const steps: SetPotentialStep[] = [];
  for (const term of stops.slice(0, last + 1)) {
    const ids = new Set(term.pieces.map((p) => p.itemId));
    if ([...prevIds].some((id) => !ids.has(id))) return null;
    const broken = term.broken.filter((b) => !prevBroken.has(keyOf(b)));
    const fut = (ctx.futureBonuses ?? []).find(
      (f) => f.threshold === term.threshold
    );
    const offKeys = new Set((fut?.bonusOff ?? []).map(keyOf));
    const offDps = fut?.bonusOffDps;
    const split =
      broken.length > 0 &&
      offDps !== undefined &&
      offKeys.size === broken.length &&
      broken.every((b) => offKeys.has(keyOf(b)));
    steps.push({
      kind: "step",
      threshold: term.threshold,
      setName: term.setName,
      pieces: term.pieces.filter((p) => !prevIds.has(p.itemId)),
      broken,
      dps: term.totalDps - prevTotal,
      isStop: term.isStop,
      ...(split
        ? {
            breaksLineDps: offDps - prevTotal,
            piecesLineDps: term.totalDps - offDps,
          }
        : {}),
    });
    prevIds = ids;
    prevBroken = new Set([...prevBroken, ...term.broken.map(keyOf)]);
    prevTotal = term.totalDps;
  }
  return steps;
}

/** The credit of `walkCredit` in the full or the split view. */
export function setPotentialCredit(
  ctx: SetContextLike | undefined,
  noiseFloorDps: number,
  setCredit: SetCreditView = "full",
  rule: SetCreditRule = RULE_490
): number {
  const walk = walkCredit(ctx, noiseFloorDps, rule);
  return setCredit === "split" ? walk.split : walk.credit;
}

/**
 * The ON-view set-potential credit for a row (`setPotentialCredit`), in the
 * full view or the split view (each future divided by its FULL piece count).
 *
 * Each bonus is floored at the per-spec noise floor (`setBonusNoiseFloorDps`
 * of the ranking's own `Cutoff`, ≈4.81 ret / ≈5.09 feral): a figure at or below
 * it is noise around a true zero and contributes nothing, so no row sorts on a
 * bonus the display hides (tickets 331, 332). The floor arrives as a parameter,
 * so this stays ignorant of the `Cutoff` type; the comparison is strict (`>`),
 * matching the display gate. Path pieces and path breaks are not floored
 * (ticket 502; see `walkCredit`).
 *
 * Fallback (ticket 467 N5): if any figure the credit depends on lacks a
 * measured `dps` (`setCreditUnmeasured`) — the no-neutral-candidates case where
 * `B` could not be measured — the whole credit is 0, reverting the row to
 * disclosure-only. This suppresses the gain as well as the loss; it is honest
 * and disclosed, not half-credited. An unmeasured commit break still zeroes it
 * (ticket 477), although a measured one is no longer charged (490).
 */
export function rankableSetPotential(
  item: Pick<RankedItem, "setContext">,
  noiseFloorDps: number,
  setCredit: SetCreditView = "full"
): number {
  if ((item.setContext?.futureBonuses ?? []).length === 0) return 0;
  if (setCreditUnmeasured(item.setContext)) return 0;
  return setPotentialCredit(item.setContext, noiseFloorDps, setCredit);
}

function sortKeyFor(
  withSetPotential: boolean,
  noiseFloorDps: number,
  setCredit: SetCreditView = "full"
): (r: ViewRow) => number {
  return withSetPotential
    ? (r) => r.deltaDps + rankableSetPotential(r, noiseFloorDps, setCredit)
    : (r) => r.deltaDps;
}

function compareRows(
  a: ViewRow,
  b: ViewRow,
  pinBis: boolean,
  sortKey: (r: ViewRow) => number
): number {
  if (pinBis) {
    const ap = a.bisTags.includes("BiS") ? 0 : 1;
    const bp = b.bisTags.includes("BiS") ? 0 : 1;
    if (ap !== bp) return ap - bp;
  }
  const ak = sortKey(a);
  const bk = sortKey(b);
  if (ak !== bk) return bk - ak;
  const richness = b.bisTags.length - a.bisTags.length;
  if (richness !== 0) return richness;
  return a.itemId - b.itemId;
}

export function applyView(r: Ranking, v: ViewOptions = {}): ViewResult {
  const pinBis = v.pinBis ?? false;
  const zone = v.raid === undefined || v.raid === "all" ? undefined : v.raid;
  const boss = v.boss === undefined || v.boss === "all" ? undefined : v.boss;
  const noiseFloorDps = setBonusNoiseFloorDps(r.cutoff);
  const setCredit = v.setCredit ?? "full";
  const sortKey = sortKeyFor(
    v.withSetPotential ?? false,
    noiseFloorDps,
    setCredit
  );

  const rows: ViewRow[] = r.items
    .filter((item) => {
      if (v.hideOwned === true && item.owned === true) return false;
      if (zone !== undefined && !matchesRaidFilter(item, zone)) return false;
      if (boss !== undefined && !matchesBoss(item, zone, boss)) return false;
      return true;
    })
    .map((item) => ({
      ...item,
      belowCutoffInView: belowCutoffUnderView(
        item,
        v.withSetPotential ?? false,
        r.baseline.dps,
        r.cutoff,
        setCredit
      ),
    }));

  rows.sort((a, b) => compareRows(a, b, pinBis, sortKey));

  assignTieGroups(rows, sortKey);

  const pinBisAvailable = r.items.some((i) => i.bisTags.includes("BiS"));
  const shortlist = rows.filter((row) => !row.belowCutoffInView);
  const result: ViewResult = {
    rows,
    shortlist,
    belowCutoffCount: rows.length - shortlist.length,
    pinBisAvailable,
  };

  if (v.groupBy === "slot" || v.groupBy === "raid") {
    const keyOf = v.groupBy === "slot" ? (i: ViewRow) => i.slot : zoneKeyOf;
    const groups = new Map<string, ViewRow[]>();
    for (const row of rows) {
      const key = keyOf(row);
      const bucket = groups.get(key);
      if (bucket) bucket.push(row);
      else groups.set(key, [row]);
    }
    result.groups = [...groups].map(([key, groupRows]) => ({
      key,
      rows: groupRows,
    }));
  }

  return result;
}
