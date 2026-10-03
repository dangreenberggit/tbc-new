/**
 * Enchant applicability — NOT ported from packages/core/src/enchants.ts.
 *
 * packages/core's enchants.ts re-derives `enchantAppliesToItem` from a
 * generated `data/enchants/index.json` snapshot because the CLI has no
 * running wowsims UI to ask. The fork *is* that UI: `ui/core/proto_utils/
 * utils.ts` already exports `enchantAppliesToItem(enchant, item)` against the
 * live `Database`, built and maintained by upstream. Re-deriving our own copy
 * here would be exactly the kind of drift-prone duplication plan §3 warns
 * about, one level down from the fork/packages-core split — so this module
 * is a thin bridge from the ported call sites' `(effectId, itemId)` form to
 * upstream's `(Enchant, Item)` form, not a second implementation.
 */

import { Database } from "../../../../proto_utils/database.js";
import { enchantAppliesToItem as upstreamEnchantAppliesToItem } from "../../../../proto_utils/utils.js";
import { getItem } from "./items.js";

/**
 * Every ported caller (rank.ts's `swapItemAt`) only ever needs the boolean
 * verdict, keyed by the WCL-style `(effectId, itemId)` pair packages/core's
 * seam uses. `effectId` doubles as `enchant.effectId` in the fork's own
 * proto, so the lookup is a straight scan of the item's eligible slots'
 * enchant lists — small (TBC ships a few hundred enchants total) and run at
 * most once per candidate slot attempt.
 */
export function enchantAppliesToItem(effectId: number, itemId: number): boolean {
  const item = Database.getSync().getItemById(itemId);
  if (!item) return false;
  const itemEntry = getItem(itemId);
  if (!itemEntry) return false;

  // Database.getEnchants(slot) is keyed by ItemSlot, which the ported call
  // sites don't carry — they have the item's ItemType instead. Scanning
  // every slot's enchant list and matching on effectId is the same approach
  // getEnchant() takes in packages/core/src/enchants.ts, just against the
  // live Database instead of the generated snapshot.
  for (const slot of ALL_ITEM_SLOTS) {
    for (const enchant of Database.getSync().getEnchants(slot)) {
      if (enchant.effectId !== effectId) continue;
      if (upstreamEnchantAppliesToItem(enchant, item)) return true;
    }
  }
  return false;
}

/**
 * The stats of the enchant with this `effectId`, found the way
 * `enchantAppliesToItem` finds it, or `[]` when the database has none
 * (ticket 535: an enchant's hit counts toward the repair hit budget).
 */
export function enchantStats(effectId: number): readonly number[] {
  for (const slot of ALL_ITEM_SLOTS) {
    for (const enchant of Database.getSync().getEnchants(slot)) {
      if (enchant.effectId === effectId) return enchant.stats;
    }
  }
  return [];
}

// ItemSlot values 0..16 (proto/common.ts) — iterated rather than imported by
// name because Database.getEnchants keys its internal map by every slot an
// enchant is eligible for, and the cheapest correct scan is "every slot".
const ALL_ITEM_SLOTS = Array.from({ length: 17 }, (_, i) => i);
