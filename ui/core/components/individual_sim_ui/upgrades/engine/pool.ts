/**
 * Candidate pool types and filters.
 *
 * PORTED from packages/core/src/pool.ts. `ItemSlot` and `ItemSourceKindName`
 * were generated `as const` unions in packages/core (codegen gated by
 * `pnpm verify` there); the fork has no such generator, so both are
 * hand-written literal unions here, kept in sync by inspection with
 * packages/core/src/items.ts's `ItemSlot` and
 * item-source-kinds.generated.ts's `ITEM_SOURCE_KINDS` — see
 * engine/PROVENANCE.md and the drift gate for how a divergence is caught.
 */

import { HandType } from "../../../../proto/common.js";
import { getItem } from "./items.js";
import type { SpecId } from "./types.js";

export type ItemSlot =
  | "head"
  | "neck"
  | "shoulder"
  | "back"
  | "chest"
  | "wrist"
  | "hands"
  | "waist"
  | "legs"
  | "feet"
  | "finger"
  | "trinket"
  | "weapon"
  | "ranged";

export const ITEM_SOURCE_KINDS = [
  "raid",
  "token",
  "badge",
  "crafted",
  "rep",
  "heroic",
  "pvp",
  "world",
  "unknown",
] as const;

export type ItemSourceKindName = (typeof ITEM_SOURCE_KINDS)[number];

export type ItemSourceOrigin =
  | "db"
  | "atlasloot"
  | "two-hop"
  | "wowhead"
  | "curated"
  | "sunmote";

export type ItemSource = { origin?: ItemSourceOrigin } & (
  | { kind: "raid"; zone: string; boss?: string }
  | { kind: "token"; zone: string; boss?: string; token: string }
  | { kind: "badge"; cost: number }
  | {
      kind: "crafted";
      profession: string;
      recipeZone?: string;
      recipeBoss?: string;
      recipeFaction?: string;
      recipeStanding?: string;
      recipeFactionId?: number;
    }
  | { kind: "rep"; faction: string; standing: string; factionId?: number }
  | { kind: "heroic"; dungeon: string }
  | { kind: "pvp"; via: "arena" | "honor"; season?: number }
  | { kind: "world" }
  | { kind: "unknown" }
);

export type ItemSourceKind = ItemSource["kind"];

type Assert<_ extends true> = true;
type Extends<A, B> = [A] extends [B] ? true : false;
type _JsonCoversUnion = Assert<Extends<ItemSourceKind, ItemSourceKindName>>;
type _UnionCoversJson = Assert<Extends<ItemSourceKindName, ItemSourceKind>>;

export type PoolEntry = {
  itemId: number;
  name: string;
  slot: ItemSlot;
  phase: number;
  source: ItemSource;
  sources?: ItemSource[];
  curationHint?: number;
  bisTags?: Array<"BiS" | "Alt" | "Realistic">;
  curatedSets?: string[];
  bisSets?: string[];
};

export type UniverseEntry = {
  itemId: number;
  name: string;
  slot: ItemSlot;
  phase: number;
  sources: ItemSource[];
  curationHint?: number;
  /** @deprecated JSON key from pre-rename generators; mapped to curationHint */
  ep?: number;
  bisTags?: Array<"BiS" | "Alt" | "Realistic">;
  curatedSets?: string[];
  bisSets?: string[];
};

export function poolEntryFromUniverse(entry: UniverseEntry): PoolEntry {
  const source = entry.sources[0];
  if (!source) {
    throw new Error(`universe row ${entry.itemId} has no sources`);
  }
  const curationHint = entry.curationHint ?? entry.ep;
  return {
    itemId: entry.itemId,
    name: entry.name,
    slot: entry.slot,
    phase: entry.phase,
    source,
    sources: [...entry.sources],
    ...(curationHint !== undefined ? { curationHint } : {}),
    ...(entry.bisTags !== undefined ? { bisTags: entry.bisTags } : {}),
    ...(entry.curatedSets !== undefined
      ? { curatedSets: [...entry.curatedSets] }
      : {}),
    ...(entry.bisSets !== undefined ? { bisSets: [...entry.bisSets] } : {}),
  };
}

export function poolFromUniverse(data: {
  entries: readonly UniverseEntry[];
}): PoolEntry[] {
  return data.entries.map(poolEntryFromUniverse);
}

export function filterPoolByPhase(
  pool: readonly PoolEntry[],
  maxPhase: number
): PoolEntry[] {
  return pool.filter((e) => e.phase <= maxPhase);
}

function sourceHasZone(source: ItemSource, zone: string): boolean {
  return "zone" in source && source.zone === zone;
}

export function filterByZone<
  T extends { source: ItemSource; sources?: readonly ItemSource[] },
>(entries: readonly T[], zone: string): T[] {
  return entries.filter(
    (e) =>
      sourceHasZone(e.source, zone) ||
      (e.sources?.some((s) => sourceHasZone(s, zone)) ?? false)
  );
}

export function filterPoolByZone(
  pool: readonly PoolEntry[],
  zone: string
): PoolEntry[] {
  return filterByZone(pool, zone);
}

export function zonesInPool(pool: readonly PoolEntry[]): string[] {
  const zones = new Set<string>();
  for (const e of pool) {
    if ("zone" in e.source) zones.add(e.source.zone);
    for (const s of e.sources ?? []) {
      if ("zone" in s) zones.add(s.zone);
    }
  }
  return [...zones].sort();
}

export const VIEW_ALL = "all";

export function viewFilterValue(raw: string | undefined): string | undefined {
  return raw === undefined || raw === VIEW_ALL ? undefined : raw;
}

export function validateViewFilter(
  value: string | undefined,
  known: readonly string[]
): { ok: true } | { ok: false; known: readonly string[] } {
  const wanted = viewFilterValue(value);
  if (wanted === undefined || known.includes(wanted)) return { ok: true };
  return { ok: false, known };
}

function sourcesOfEntry(entry: {
  source: ItemSource;
  sources?: readonly ItemSource[];
}): readonly ItemSource[] {
  return entry.sources ?? [entry.source];
}

export function sourceMatchesBoss(
  source: ItemSource,
  boss: string,
  zone: string | undefined
): boolean {
  if (!("boss" in source) || source.boss !== boss) return false;
  return zone === undefined || ("zone" in source && source.zone === zone);
}

export function bossesInPool(
  pool: readonly PoolEntry[],
  zone?: string
): string[] {
  const bosses = new Set<string>();
  for (const e of pool) {
    for (const s of sourcesOfEntry(e)) {
      if (!("boss" in s) || s.boss === undefined) continue;
      if (sourceMatchesBoss(s, s.boss, zone)) bosses.add(s.boss);
    }
  }
  return [...bosses].sort();
}

/**
 * A sim equipment slot name. Hand-written subset of `SimOrderName`
 * (slots.ts) the same way packages/core/src/pool.ts derives it, minus the
 * generated-file machinery.
 */
export type SimSlotName =
  | Exclude<ItemSlot, "finger" | "trinket" | "weapon">
  | "finger1"
  | "finger2"
  | "trinket1"
  | "trinket2"
  | "mainhand"
  | "offhand";

/**
 * Specs that put a weapon in the off hand.
 *
 * Membership is about what the spec *can* equip, not what its BiS set happens
 * to use: a fury warrior and a combat rogue always dual-wield, while a hunter
 * or an enhancement shaman may be playing a two-hander build this week. Listing
 * the latter two anyway is correct, because the per-item hand-type filter below
 * is what actually decides whether any given item can go there — a spec that
 * could dual-wield but currently holds a two-hander simply produces no offhand
 * candidates. Excluding them instead would hide real offhand upgrades from
 * every dual-wielding hunter.
 *
 * Ret and feral are absent deliberately: neither can put anything in the off
 * hand, so `"weapon"` keeps mapping to mainhand alone and their rankings are
 * bit-for-bit what they were.
 */
const DUAL_WIELD_SPECS: ReadonlySet<SpecId> = new Set<SpecId>([
  "rogue",
  "enh",
  "warrior",
  "hunter",
]);

/**
 * Whether an item can physically be placed in the given sim slot.
 *
 * Only weapons need this, and the off hand is an **allowlist**, not a
 * denylist: a one-hander or a dedicated off-hand item, and nothing else.
 * Excluding just two-handers is not enough — `HandTypeMainHand` is a distinct
 * value carried by 235 items in the pinned db (Talon of the Phoenix among
 * them), and letting one through produces a candidate the fork's own equip
 * logic then rejects with "No slots left to equip", failing the whole run
 * rather than one row.
 *
 * The main hand is the mirror: everything except a dedicated off-hand item.
 *
 * Items with no recorded hand type (`null`, which the index writes for
 * everything that is not a weapon) are left alone rather than filtered, since
 * a missing field is not evidence of a restriction.
 */
function itemFitsSimSlot(itemId: number, slotName: SimSlotName): boolean {
  if (slotName !== "mainhand" && slotName !== "offhand") return true;
  const handType = getItem(itemId)?.handType;
  if (handType == null) return true;
  if (slotName === "offhand") {
    return (
      handType === HandType.HandTypeOneHand ||
      handType === HandType.HandTypeOffHand
    );
  }
  return handType !== HandType.HandTypeOffHand;
}

/**
 * Map pool slot → sim equipment slot name(s). Rings/trinkets try both; a
 * dual-wield spec's weapons try both hands.
 *
 * Resolving the off hand here rather than adding an `offhand` member to
 * `ItemSlot` is deliberate: a new pool slot would duplicate every one-hander
 * across two pool rows, and every universe on disk would need regenerating to
 * carry the split. The off hand is a *placement* of a weapon, exactly as
 * `finger2` is a placement of a ring, so it belongs on the same axis the
 * finger/trinket pairs already use.
 *
 * `itemId` is optional so callers that only want the candidate placements for a
 * slot — with no particular item in hand — keep working. Passing it filters the
 * list down to placements that item can actually occupy.
 */
export function simSlotsForPoolSlot(
  slot: ItemSlot,
  spec?: SpecId,
  itemId?: number
): readonly SimSlotName[] {
  const placements: readonly SimSlotName[] = ((): readonly SimSlotName[] => {
    switch (slot) {
      case "finger":
        return ["finger1", "finger2"];
      case "trinket":
        return ["trinket1", "trinket2"];
      case "weapon":
        return spec !== undefined && DUAL_WIELD_SPECS.has(spec)
          ? ["mainhand", "offhand"]
          : ["mainhand"];
      default:
        return [slot];
    }
  })();

  if (itemId === undefined) return placements;
  return placements.filter((slotName) => itemFitsSimSlot(itemId, slotName));
}
