/**
 * The view layer. Pure: a re-render of a `Ranking` that already exists. No
 * seam, no I/O, no sim, and nothing here reaches `contentHash`.
 *
 * PORTED from packages/core/src/view.ts. The Set-potential credit (ticket 467)
 * reads the corrected `setContext.futureBonuses` and the breaks on each
 * future's own path (ticket 490) the engine attaches — a true net (gains minus
 * the measured broken-bonus losses) — rather
 * than the old single nearest-threshold prospective bonus. The ticket-90
 * confound guard is gone: `bonusDpsNet` is already corrected for that inflation,
 * and a row whose loss could not be measured drops to disclosure-only here by
 * the missing-`dps` fallback below.
 *
 */
import {
  type Cutoff,
  meetsCutoff,
  setBonusNoiseFloorDps,
} from "./cutoff.js";
import { type ItemSource,sourceMatchesBoss } from "./pool.js";
import type { RankedItem, Ranking, SetContext } from "./rank.js";

export type SetCreditView = "full" | "split";

/**
 * How far the ON credit assumes a player commits (ticket 490).
 * "best-stop": to the threshold where committing pays best on full values,
 * or not at all. "full-path": to every credited threshold, charging every
 * break on the way. Which a player does is a preference, not a game fact;
 * best-stop is the owner's choice (confirmed 2026-09-24, ticket 490).
 */
export type SetCreditRule = "best-stop" | "full-path";
export const RULE_490: SetCreditRule = "best-stop";

type SetContextLike = Partial<
  Pick<
    SetContext,
    "futureBonuses" | "commitBreaks" | "singleBreaks" | "crossesThreshold"
  >
>;

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
 * was not measured: a future's own value, a break on a future's path, or a
 * commit break of the top package (ticket 477). The credit is then 0 and the
 * tab says "not counted" (ticket 491). False without futures: nothing is
 * credited, so nothing is withheld.
 */
export function setCreditUnmeasured(ctx: SetContextLike | undefined): boolean {
  const future = ctx?.futureBonuses ?? [];
  if (future.length === 0) return false;
  return (
    future.some(
      (f) =>
        f.dps === undefined || (f.breaks ?? []).some((b) => b.dps === undefined)
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
    (ctx.commitBreaks ?? []).length > 0;
  if (!anyDisclosure) return null;
  return on && setCreditUnmeasured(ctx) ? "not_counted" : "hover_hint";
}

/**
 * The credit arithmetic, once every figure is known to be measured (ticket
 * 490). Futures are walked in threshold order. Each is worth its value minus
 * the breaks its own path needs that a lower future has not already charged.
 *
 * best-stop: keep the running total on FULL values and stop at the threshold
 * where it is largest, or not at all when no total is positive. The split view
 * follows that same stopping point, each future at its per-piece share, and is
 * not clamped: the stopping point is the player's, not the display's, so a
 * split figure along it may be negative.
 *
 * full-path: every future above the floor, minus every break on their paths.
 *
 * The top package's `commitBreaks` are not charged: a row whose own path to
 * each future keeps the other set's bonus should not pay for a slot only the
 * top package vacates (a Malorne chest row charged the Thunderheart 2pc).
 */
export function setPotentialCredit(
  ctx: SetContextLike | undefined,
  noiseFloorDps: number,
  setCredit: SetCreditView = "full",
  rule: SetCreditRule = RULE_490
): number {
  const future = [...(ctx?.futureBonuses ?? [])].sort(
    (a, b) => a.threshold - b.threshold
  );
  const floored = (v: number): number => (v > noiseFloorDps ? v : 0);
  const charged = new Set<string>();
  let fullTotal = 0;
  let splitTotal = 0;
  let bestFull = 0;
  let bestSplit = 0;
  for (const f of future) {
    const full = floored(f.dps!);
    const split = floored(f.dps! / f.threshold);
    if (rule === "full-path" && full === 0) continue;
    let loss = 0;
    for (const brk of f.breaks ?? []) {
      const key = `${brk.setId}:${brk.threshold}`;
      if (charged.has(key)) continue;
      charged.add(key);
      loss += floored(brk.dps!);
    }
    fullTotal += full - loss;
    splitTotal += split - loss;
    if (rule === "full-path" || fullTotal > bestFull) {
      bestFull = fullTotal;
      bestSplit = splitTotal;
    }
  }
  return setCredit === "split" ? bestSplit : bestFull;
}

/**
 * The ON-view set-potential credit for a row (`setPotentialCredit`), in the
 * full view or the split view (each future divided by its FULL piece count).
 *
 * Each component is floored at the per-spec noise floor (`setBonusNoiseFloorDps`
 * of the ranking's own `Cutoff`, ≈4.81 ret / ≈5.09 feral): a figure at or below
 * it is noise around a true zero and contributes nothing, so no row sorts on a
 * bonus the display hides (tickets 331, 332). The floor arrives as a parameter,
 * so this stays ignorant of the `Cutoff` type; the comparison is strict (`>`),
 * matching the display gate.
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
