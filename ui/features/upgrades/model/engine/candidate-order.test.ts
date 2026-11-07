import { describe, expect, it, vi } from "vitest";

import { testItem } from "../../testing/db_pool";
import { orderCandidatesByEp } from "./candidate-order";
import type { PoolEntry, SimSlotName } from "./pool";
import { SIM_ORDER, type SimItemSpec } from "./slots";

// The engine reads hand types through the page's database; the test database stands in for it.
vi.mock("@sim/proto/database", () => ({
  Database: { getSync: () => ({ getItemById: testItem }) },
}));

const SYPHON = 32262; // Syphon of the Nathrezim, one-hander
const RIPPER = 28524; // Emerald Ripper, one-hander
const CATACLYSM = 30902; // Cataclysm's Edge, two-hander
const NEXUS_KEY = 29988; // The Nexus Key, two-hander

const weapon = (itemId: number): PoolEntry => ({
  itemId,
  name: `item ${itemId}`,
  slot: "weapon",
  phase: 3,
  source: { kind: "raid", zone: "Black Temple" },
});

function wearing(worn: Partial<Record<SimSlotName, number>>): SimItemSpec[] {
  return SIM_ORDER.map((slot) => {
    const id = worn[slot as SimSlotName];
    return id === undefined ? { gems: [] } : { id, gems: [] };
  });
}

/** A score table keyed by item and slot; anything not listed scores 0. */
function scores(table: Record<number, Partial<Record<SimSlotName, number>>>) {
  return (itemId: number, slot: SimSlotName) => table[itemId]?.[slot] ?? 0;
}

const order = (entries: PoolEntry[]) => entries.map((e) => e.itemId);

describe("orderCandidatesByEp", () => {
  it("scores a candidate in the slot it would take, so off-hand weapon damage is priced at the off-hand value", () => {
    // Ripper is worth more than Syphon in the off hand, less in the main hand.
    const itemEp = scores({
      [SYPHON]: { mainhand: 100, offhand: 40 },
      [RIPPER]: { mainhand: 90, offhand: 60 },
    });
    const equipment = wearing({ mainhand: SYPHON, offhand: SYPHON });
    // Ripper: max(90 - 100, 60 - 40) = +20. Cataclysm in the main hand alone would be 0 - 100 - 40.
    const ordered = orderCandidatesByEp(
      [weapon(CATACLYSM), weapon(RIPPER)],
      equipment,
      itemEp,
      "enh"
    );
    expect(order(ordered)).toEqual([RIPPER, CATACLYSM]);
  });

  it("prices a two-hander against the worn main hand and the worn off hand it would remove", () => {
    const itemEp = scores({
      [SYPHON]: { mainhand: 100, offhand: 40 },
      [CATACLYSM]: { mainhand: 130 },
      [RIPPER]: { mainhand: 95, offhand: 35 },
    });
    const equipment = wearing({ mainhand: SYPHON, offhand: SYPHON });
    // Cataclysm: 130 - 100 - 40 = -10. Ripper: max(95 - 100, 35 - 40) = -5.
    // Against the main hand alone Cataclysm would be +30 and sort first.
    const ordered = orderCandidatesByEp(
      [weapon(CATACLYSM), weapon(RIPPER)],
      equipment,
      itemEp,
      "enh"
    );
    expect(order(ordered)).toEqual([RIPPER, CATACLYSM]);
  });

  it("compares a two-hander with the main hand alone when the off hand is empty", () => {
    const itemEp = scores({
      [NEXUS_KEY]: { mainhand: 100 },
      [CATACLYSM]: { mainhand: 130 },
      [RIPPER]: { mainhand: 125 },
    });
    const equipment = wearing({ mainhand: NEXUS_KEY });
    // Cataclysm +30, Ripper +25 (a one-hander, main hand only for this spec).
    const ordered = orderCandidatesByEp(
      [weapon(RIPPER), weapon(CATACLYSM)],
      equipment,
      itemEp,
      "ret"
    );
    expect(order(ordered)).toEqual([CATACLYSM, RIPPER]);
  });
});
