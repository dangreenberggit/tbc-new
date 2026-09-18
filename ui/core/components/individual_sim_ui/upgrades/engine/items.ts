/**
 * Item metadata — Database-backed, NOT ported from packages/core/src/items.ts.
 *
 * packages/core's items.ts reads a 6.8 MB generated `data/items/index.json`
 * snapshot (plan §2.1: explicitly not ported). The fork already has this
 * data loaded — the page's own `Database` (`sim.db`, `ui/core/proto_utils/
 * database.ts`) is populated before any tab can run. This module is a thin
 * `ItemEntry`-typed wrapper over `Database.getSync().getItemById`, so every
 * ported module downstream (meta-repair, set-bonus, set-value, caps, …) can
 * keep calling `getItem(id)` exactly as it does in packages/core.
 *
 * `ItemEntry` here is a narrowed *projection* of the fork's `UIItem` proto,
 * not a re-declaration of it — ported call sites only ever read the fields
 * below, and using the proto type directly would let a ported module read a
 * field (e.g. a stat display name) that packages/core's contract never
 * promised.
 */

import { GemColor, ItemType } from "../../../../proto/common.js";
import { Database } from "../../../../proto_utils/database.js";

export type ItemEntry = {
  name: string;
  /** Socket colours, one entry per socket (fork's `gemSockets`). */
  sockets: number[];
  /** Dense stat array indexed by proto.Stat — item's own stats only. */
  stats: number[];
  /** Stat array granted only when every socket is colour-matched. */
  socketBonus: number[];
  setId: number | null;
  setName: string | null;
  unique: boolean;
  /** wowsims ItemType — same enum `enchants.ts`'s eligibility check reads. */
  itemType: number;
  handType: number | null;
  weaponType: number | null;
  rangedWeaponType: number | null;
};

export function getItem(itemId: number): ItemEntry | undefined {
  const item = Database.getSync().getItemById(itemId);
  if (!item) return undefined;
  return {
    name: item.name,
    sockets: [...item.gemSockets],
    stats: item.stats,
    socketBonus: item.socketBonus,
    setId: item.setId || null,
    setName: item.setName || null,
    unique: item.unique,
    itemType: item.type,
    // 0 is `HandTypeUnknown` / `WeaponTypeUnknown` / `RangedWeaponTypeUnknown`
    // in every one of these enums (proto/common.ts) — packages/core's
    // generated db.json instead carried a literal `null` for "does not
    // apply" (see items.ts there), so 0 is normalized to null here to keep
    // every ported caller's `!= null` / `??` checks behaving the same way.
    handType: item.handType || null,
    weaponType: item.weaponType || null,
    rangedWeaponType: item.rangedWeaponType || null,
  };
}

export function socketsFor(itemId: number): number[] {
  return getItem(itemId)?.sockets ?? [];
}

/**
 * Whether TBC allows a permanent enchant on this slot at all. Ported callers
 * only ever gate on `enchantAppliesToItem` (enchants.ts), never on this flag
 * directly — packages/core's own items.ts doc comment says as much — so an
 * approximate slot-level answer here is sufficient; nothing downstream reads
 * it as the final word.
 */
export function isEnchantable(itemId: number): boolean {
  const item = Database.getSync().getItemById(itemId);
  if (!item) return false;
  return item.type !== ItemType.ItemTypeUnknown;
}

export { GemColor };
