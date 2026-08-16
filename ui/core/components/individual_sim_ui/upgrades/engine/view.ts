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
 * candidate-pool.md M2 (racing, §6.1/§6.4/7.7) ported unchanged in shape:
 * screened rows are a third view state — present in `rows`, never in
 * `shortlist`, ranked only among themselves via `assignTieGroupsWithinPartition`'s
 * partitioning and `compareRows`'s screened-last ordering, never interleaved
 * with full-iteration deltas.
 */
import { meetsCutoff, type Cutoff } from "./cutoff.js";
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

const ZONELESS_SOURCE_LABELS: Record<string, string> = {
  badge: "Badge vendor",
  crafted: "Crafted",
  rep: "Reputation vendor",
  pvp: "PvP vendor",
  world: "World drop",
  unknown: "Source not recorded",
};

function zoneKeyOf(item: RankedItem): string {
  for (const s of sourcesOf(item)) {
    if ("zone" in s) return s.zone;
  }
  return ZONELESS_SOURCE_LABELS[item.source.kind] ?? item.source.kind;
}

function tieWindow(a: ViewRow, b: ViewRow): number {
  const se =
    a.seMethod === b.seMethod ? Math.min(a.se, b.se) : Math.max(a.se, b.se);
  return se * 2;
}

/**
 * `groupId` starts from a shared counter passed in rather than always at 0,
 * so calling this once per screened/non-screened partition (§6.1: screened
 * rows are ranked only among themselves) cannot mint `tie-1` twice and
 * collide two unrelated groups under one id.
 */
function assignTieGroupsWithinPartition(
  rows: ViewRow[],
  sortKey: (r: ViewRow) => number,
  groupIdRef: { next: number }
): void {
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

/**
 * Screened rows carry a screening-iteration delta, not a full-iteration one
 * (§6.1) — grouping them into the same tie-window math as full-iteration
 * rows would compare two quantities that were never measured the same way.
 * Partitioning first keeps `assignTieGroupsWithinPartition`'s SE-window
 * logic meaningful within each group and absent across the boundary.
 */
function assignTieGroups(
  rows: ViewRow[],
  sortKey: (r: ViewRow) => number
): void {
  const groupIdRef = { next: 1 };
  const fullIteration = rows.filter((r) => r.screened === undefined);
  const screened = rows.filter((r) => r.screened !== undefined);
  assignTieGroupsWithinPartition(fullIteration, sortKey, groupIdRef);
  assignTieGroupsWithinPartition(screened, sortKey, groupIdRef);
}

function belowCutoffUnderView(
  item: RankedItem,
  withSetPotential: boolean,
  baselineDps: number,
  cutoff: Cutoff
): boolean {
  // Screened out (candidate-pool.md §6.1): never measured at full
  // precision, so there is no cutoff verdict to give it — the same
  // "excluded from the shortlist, present in rows" treatment a Stop-
  // unsimmed row gets, and for the same reason (view.ts has no ranking-
  // level `simmed` field to check, but `screened` carries the same idea).
  if (item.screened !== undefined) return true;
  if (!withSetPotential) return item.belowCutoff;
  const prospective = rankableSetPotential(item);
  if (prospective === 0) return item.belowCutoff;
  const effectiveDps = item.deltaDps + prospective;
  const effectivePct =
    baselineDps === 0 ? item.deltaPct : (effectiveDps / baselineDps) * 100;
  return !meetsCutoff(effectiveDps, effectivePct, cutoff);
}

function rankableSetPotential(item: Pick<RankedItem, "setContext">): number {
  if (setPotentialIsConfounded(item)) return 0;
  return item.setContext?.prospectiveBonusDps ?? 0;
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
  // Screened rows sort after every full-iteration row, before anything else
  // is considered (candidate-pool.md §6.1: ranked only among themselves,
  // never interleaved with full-iteration deltas) — a screening delta and a
  // full-iteration delta are not the same quantity, so pinBis and the sort
  // key both apply only *within* whichever group a row belongs to.
  const aScreened = a.screened !== undefined;
  const bScreened = b.screened !== undefined;
  if (aScreened !== bScreened) return aScreened ? 1 : -1;
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
      if (zone !== undefined && !matchesZone(item, zone)) return false;
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
