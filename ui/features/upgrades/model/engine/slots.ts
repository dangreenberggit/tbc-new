/**
 * 17-slot sim equipment order, matching the ItemSlot enum order in
 * proto/common.proto. A hand-kept copy of the ranking engine's own list,
 * which a drift check compares.
 */

export const SIM_ORDER = [
	'head',
	'neck',
	'shoulder',
	'back',
	'chest',
	'wrist',
	'hands',
	'waist',
	'legs',
	'feet',
	'finger1',
	'finger2',
	'trinket1',
	'trinket2',
	'mainhand',
	'offhand',
	'ranged',
] as const;

export type SimOrderName = (typeof SIM_ORDER)[number];

export type SimItemSpec = {
	id?: number;
	enchant?: number;
	gems: number[];
};
