/**
 * Convert LoggedGear (sim slot names) into the 17-slot equipment vector
 * compose expects.
 *
 * PORTED from packages/core/src/logged-gear.ts, unchanged except for import
 * paths.
 */

import type { SocketedItem } from "./meta-repair.js";
import type { LoggedGear } from "./seams/gear-source.js";
import { SIM_ORDER, type SimItemSpec } from "./slots.js";

export function equipmentFromLoggedGear(gear: LoggedGear): SimItemSpec[] {
  const bySlot = new Map<string, SimItemSpec>();
  for (const item of gear.items) {
    if (!item.id) {
      bySlot.set(item.slot, { gems: [] });
      continue;
    }
    const spec: SimItemSpec = { id: item.id, gems: [...(item.gems ?? [])] };
    if (item.enchant) spec.enchant = item.enchant;
    bySlot.set(item.slot, spec);
  }
  return SIM_ORDER.map((slot) => bySlot.get(slot) ?? { gems: [] });
}

export function socketedItemsFromLoggedGear(gear: LoggedGear): SocketedItem[] {
  return equipmentFromLoggedGear(gear).map((spec) => ({
    itemId: spec.id ?? 0,
    gems: [...spec.gems],
  }));
}
