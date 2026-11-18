/**
 * Item metadata from the page's own `Database` (ui/sim/proto/database.ts),
 * which is loaded before any tab runs. `ItemEntry` is a narrowed projection
 * of the `UIItem` proto, so engine modules read only the fields below.
 */

import { GemColor, ItemType } from '@generated/proto/common';
import { Database } from '@sim/proto/database';

export type ItemEntry = {
	name: string;
	/** Socket colours, one entry per socket (`UIItem.gemSockets`). */
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
		// (proto/common.proto). It becomes null, "does not apply", which is what
		// callers' `!= null` / `??` checks test for.
		handType: item.handType || null,
		weaponType: item.weaponType || null,
		rangedWeaponType: item.rangedWeaponType || null,
	};
}

export function socketsFor(itemId: number): number[] {
	return getItem(itemId)?.sockets ?? [];
}

/**
 * Whether TBC allows a permanent enchant on this slot at all. An approximate
 * slot-level answer: callers gate on `enchantAppliesToItem` (enchants.ts),
 * not on this flag.
 */
export function isEnchantable(itemId: number): boolean {
	const item = Database.getSync().getItemById(itemId);
	if (!item) return false;
	return item.type !== ItemType.ItemTypeUnknown;
}

export { GemColor };
