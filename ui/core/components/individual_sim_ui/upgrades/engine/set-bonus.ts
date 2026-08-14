/**
 * Detect single-item swaps that break a 2-piece or 4-piece set bonus.
 *
 * PORTED from packages/core/src/set-bonus.ts, unchanged except for the
 * items.ts import path.
 */

import { getItem } from "./items.js";
import type { SimItemSpec } from "./slots.js";

function setCounts(equipment: readonly SimItemSpec[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const spec of equipment) {
    if (!spec.id) continue;
    const setId = getItem(spec.id)?.setId;
    if (setId == null) continue;
    counts.set(setId, (counts.get(setId) ?? 0) + 1);
  }
  return counts;
}

function setLabel(equipment: readonly SimItemSpec[], setId: number): string {
  for (const spec of equipment) {
    if (!spec.id) continue;
    const item = getItem(spec.id);
    if (item?.setId === setId && item.setName) return item.setName;
  }
  return `set ${setId}`;
}

export function setBreakNote(
  equipment: readonly SimItemSpec[],
  slotIndex: number,
  newItemId: number
): string | undefined {
  const before = setCounts(equipment);
  const afterEquip = equipment.map((spec, i) =>
    i === slotIndex ? { id: newItemId, gems: [] as number[] } : spec
  );
  const after = setCounts(afterEquip);

  const notes: string[] = [];
  for (const [setId, prev] of before) {
    const next = after.get(setId) ?? 0;
    if (next >= prev) continue;
    const label = setLabel(equipment, setId);
    if (prev >= 4 && next < 4) {
      notes.push(`breaks ${prev}-piece ${label} (below 4)`);
    } else if (prev >= 2 && next < 2) {
      notes.push(`breaks ${prev}-piece ${label} (below 2)`);
    }
  }
  return notes.length > 0 ? notes.join("; ") : undefined;
}
