/**
 * Gear hit rating for the gem-repair hit budget.
 *
 * PORTED from packages/core/src/caps.ts, then cut down to the fork-only
 * `gearHitRating` (ticket 535). Ticket 521 deleted the rest: the hit and
 * expertise cap readout (`capStateFrom`, `Ranking.caps`) and the
 * `hitDriven` / `hitRegression` row flags built on it. No Upgrades tab screen
 * showed any of them, and the readout's gear sum left out Improved Faerie
 * Fire and enchant hit, so it disagreed with the sim. Core's copy keeps them.
 */
import { enchantStats } from "./enchants";
import { getItem } from "./items";
import { layoutHitRating } from "./meta-repair";
import type { SimItemSpec } from "./slots";
import { type Stat, statAt } from "./stats";

/**
 * The hit `stat` the equipment has: item stats, enchants, gems and active
 * socket bonuses (ticket 535). It leaves out set bonuses, which live in the
 * sim's Go code and are in no database row, so the set phase reads them from
 * the sim instead. Enchants count because a swap can drop one that does not
 * fit the new item, and ret's head enchant has 16 hit.
 */
export function gearHitRating(
  equipment: readonly SimItemSpec[],
  stat: Stat
): number {
  let hit = 0;
  for (const spec of equipment) {
    if (!spec.id) continue;
    hit += statAt(getItem(spec.id)?.stats ?? [], stat);
    if (spec.enchant) hit += statAt(enchantStats(spec.enchant), stat);
  }
  return (
    hit +
    layoutHitRating(
      equipment.map((spec) => ({ itemId: spec.id ?? 0, gems: [...(spec.gems ?? [])] })),
      stat
    )
  );
}
