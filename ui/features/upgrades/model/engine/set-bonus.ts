/**
 * Detect an item's own swap breaking a 2-piece or 4-piece set bonus.
 */

import { setCounts, setNameOf } from './set-value';
import type { SimItemSpec } from './slots';

export function setBreakNote(equipment: readonly SimItemSpec[], slotIndex: number, newItemId: number): string | undefined {
	const before = setCounts(equipment);
	const afterEquip = equipment.map((spec, i) => (i === slotIndex ? { id: newItemId, gems: [] as number[] } : spec));
	const after = setCounts(afterEquip);

	const notes: string[] = [];
	for (const [setId, prev] of before) {
		const next = after.get(setId) ?? 0;
		if (next >= prev) continue;
		const label = setNameOf(equipment, setId);
		if (prev >= 4 && next < 4) {
			notes.push(`breaks ${prev}-piece ${label} (below 4)`);
		} else if (prev >= 2 && next < 2) {
			notes.push(`breaks ${prev}-piece ${label} (below 2)`);
		}
	}
	return notes.length > 0 ? notes.join('; ') : undefined;
}
