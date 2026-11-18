/**
 * Item metadata from the page's `Database` (ui/sim/proto/database.ts), loaded before any
 * tab runs. `ItemEntry` narrows the `UIItem` proto to the fields the engine reads.
 */

import { GemColor, ItemType } from '@generated/proto/common';
import { Database } from '@sim/proto/database';

export type ItemEntry = {
	name: string;
	/** One per socket (`UIItem.gemSockets`). */
	sockets: GemColor[];
	/** Dense stat array indexed by proto.Stat — item's own stats only. */
	stats: number[];
	/** Stat array granted only when every socket is colour-matched. */
	socketBonus: number[];
	setId: number | null;
	setName: string | null;
	unique: boolean;
	itemType: ItemType;
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
		// 0 is the `*Unknown` value; callers test for null ("does not apply").
		handType: item.handType || null,
		weaponType: item.weaponType || null,
		rangedWeaponType: item.rangedWeaponType || null,
	};
}

export function socketsFor(itemId: number): number[] {
	return getItem(itemId)?.sockets ?? [];
}

/**
 * Whether the slot takes a permanent enchant at all. Approximate: callers gate on
 * `enchantAppliesToItem` (enchants.ts), not on this.
 */
export function isEnchantable(itemId: number): boolean {
	const item = Database.getSync().getItemById(itemId);
	if (!item) return false;
	return item.type !== ItemType.ItemTypeUnknown;
}

export { GemColor };
