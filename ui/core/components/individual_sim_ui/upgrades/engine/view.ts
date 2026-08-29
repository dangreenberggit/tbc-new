/**
 * The view layer. Pure: a re-render of a `Ranking` that already exists. No
 * seam, no I/O, no sim, and nothing here reaches `contentHash`.
 *
 * PORTED from packages/core/src/view.ts. `setPotentialIsConfounded` is
 * inlined here rather than imported from a ported `rank-report-rules.ts`:
 * that file is packages/core's CLI/HTML report renderer (`formatSetBonusLine`,
 * `SLOT_ORDER`, wowsims-JSON export, …), which is out of scope per plan §2.1
 * — the fork's tab is its own renderer (`upgrades_tab.tsx`, slice 4), not a
 * consumer of packages/core's HTML report. `setPotentialIsConfounded` is the
 * one pure predicate `view.ts` itself depends on (ticket 90's confound
 * guard), so it is carried over verbatim rather than pulling in the whole
 * report-formatting module for one function.
 *
 */
import {
  meetsCutoff,
  SET_BONUS_NOISE_FLOOR_DPS,
  type Cutoff,
} from "./cutoff.js";
import { sourceMatchesBoss, type ItemSource } from "./pool.js";
import type { RankedItem, Ranking } from "./rank.js";

/**
 * PORTED verbatim from packages/core/src/rank-report-rules.ts's
 * `setPotentialIsConfounded`. See that file (or PLAN.md ticket 90) for the
 * full `(k−1)·B` inflation argument this guards against.
 */
function setPotentialIsConfounded(
  item: Pick<RankedItem, "setContext">
): boolean {
  const breaks = item.setContext?.prospectiveBonusBreaks;
  return breaks !== undefined && breaks.length > 0;
}

export type ViewOptions = {
  pinBis?: boolean;
  raid?: string;
  boss?: string;
  groupBy?: "rank" | "slot" | "raid";
  hideOwned?: boolean;
  withSetPotential?: boolean;
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
  cutoff: Cutoff
): boolean {
  if (!withSetPotential) return item.belowCutoff;
  const prospective = rankableSetPotential(item);
  if (prospective === 0) return item.belowCutoff;
  const effectiveDps = item.deltaDps + prospective;
  const effectivePct =
    baselineDps === 0 ? item.deltaPct : (effectiveDps / baselineDps) * 100;
  return !meetsCutoff(effectiveDps, effectivePct, cutoff);
}

/**
 * A figure at or below `SET_BONUS_NOISE_FLOOR_DPS` is noise around a true zero,
 * so it contributes nothing: it must not move the sort key or the cutoff
 * verdict. The comparison is strict (`>`), matching the display gate's strict
 * `> SET_BONUS_NOISE_FLOOR_DPS` so a boundary value behaves identically in both
 * layers — no row sorts on a bonus the display hides (ticket 331).
 */
export function rankableSetPotential(
  item: Pick<RankedItem, "setContext">
): number {
  if (setPotentialIsConfounded(item)) return 0;
  const bonus = item.setContext?.prospectiveBonusDps ?? 0;
  return bonus > SET_BONUS_NOISE_FLOOR_DPS ? bonus : 0;
}

function sortKeyFor(withSetPotential: boolean): (r: ViewRow) => number {
  return withSetPotential
    ? (r) => r.deltaDps + rankableSetPotential(r)
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
  const sortKey = sortKeyFor(v.withSetPotential ?? false);

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
        r.cutoff
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
