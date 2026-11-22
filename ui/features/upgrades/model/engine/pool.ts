/**
 * Candidate pool types and filters.
 *
 * `ItemSlot` and `ITEM_SOURCE_KINDS` are copied by hand from the engine this
 * file was ported from, and a drift check compares them member by member.
 */

import { HandType } from '@generated/proto/common';

import { getItem } from './items';
import type { SimOrderName } from './slots';
import type { SpecId } from './types';

/**
 * A candidate pool slot: rings, trinkets and one-handers are one slot each. Not wowsims'
 * `ItemSlot` enum; `simSlotsForPoolSlot` maps it to sim slots.
 */
export type ItemSlot =
	| 'head'
	| 'neck'
	| 'shoulder'
	| 'back'
	| 'chest'
	| 'wrist'
	| 'hands'
	| 'waist'
	| 'legs'
	| 'feet'
	| 'finger'
	| 'trinket'
	| 'weapon'
	| 'ranged';

export const ITEM_SOURCE_KINDS = ['raid', 'token', 'badge', 'crafted', 'rep', 'heroic', 'pvp', 'world', 'unknown'] as const;

export type ItemSourceKindName = (typeof ITEM_SOURCE_KINDS)[number];

/**
 * The tab reads its sources from wowsims' item data
 * (ui/features/upgrades/utils/item_sources.ts), which states no origin, recipe,
 * cost, faction id or arena season. The tab builds neither the `badge` nor the
 * `world` variant; they stay because `ITEM_SOURCE_KINDS` must match that
 * engine's list.
 */
export type ItemSource =
	| { kind: 'raid'; zone: string; boss?: string; heroic?: boolean }
	| {
			kind: 'token';
			zone: string;
			boss?: string;
			token: string;
			tokenId?: number;
	  }
	| { kind: 'badge'; cost: number }
	| { kind: 'crafted'; profession: string }
	| { kind: 'rep'; faction: string; standing: string }
	| { kind: 'heroic'; dungeon: string }
	| { kind: 'pvp'; via: 'arena' }
	| { kind: 'world' }
	| { kind: 'unknown' };

export type ItemSourceKind = ItemSource['kind'];

type Assert<_ extends true> = true;
type Extends<A, B> = [A] extends [B] ? true : false;
type _JsonCoversUnion = Assert<Extends<ItemSourceKind, ItemSourceKindName>>;
type _UnionCoversJson = Assert<Extends<ItemSourceKindName, ItemSourceKind>>;

export type PoolEntry = {
	itemId: number;
	name: string;
	slot: ItemSlot;
	phase: number;
	source: ItemSource;
	sources?: ItemSource[];
	bisTags?: Array<'BiS' | 'Alt' | 'Realistic'>;
	curatedSets?: string[];
	bisSets?: string[];
};

export function filterPoolByPhase(pool: readonly PoolEntry[], maxPhase: number): PoolEntry[] {
	return pool.filter(e => e.phase <= maxPhase);
}

export function sourceMatchesBoss(source: ItemSource, boss: string, zone: string | undefined): boolean {
	if (!('boss' in source) || source.boss !== boss) return false;
	return zone === undefined || ('zone' in source && source.zone === zone);
}

export type SimSlotName = SimOrderName;

/**
 * Specs that can put a one-handed weapon in the off hand: wowsims' per-spec `canDualWield`,
 * pinned by model/dual_wield_specs.test.ts. It is what the spec can equip, not what its BiS
 * uses. A dedicated off-hand item goes to the off hand for every spec, so a spec missing
 * here still has an off hand.
 */
export const DUAL_WIELD_SPECS: ReadonlySet<SpecId> = new Set<SpecId>(['rogue', 'enh', 'warrior', 'hunter']);

/**
 * Whether an item can go in the given sim slot. The off hand is an allowlist (one-hander
 * or dedicated off-hand item): excluding only two-handers lets a `HandTypeMainHand` item
 * through, which the equip logic rejects with "No slots left to equip", failing the whole
 * run. The main hand takes all but a dedicated off-hand item. An item with no hand type
 * (every non-weapon in items.ts) passes.
 */
function itemFitsSimSlot(itemId: number, slotName: SimSlotName): boolean {
	if (slotName !== 'mainhand' && slotName !== 'offhand') return true;
	const handType = getItem(itemId)?.handType;
	if (handType == null) return true;
	if (slotName === 'offhand') {
		return handType === HandType.HandTypeOneHand || handType === HandType.HandTypeOffHand;
	}
	return handType !== HandType.HandTypeOffHand;
}

/**
 * Pool slot → sim slot names. Rings and trinkets try both; a dual-wield spec's one-handers
 * try both hands; a dedicated off-hand item goes to the off hand. The off hand is a
 * placement, like `finger2`, not an `ItemSlot` member, which would split every one-hander
 * into two pool rows. With `itemId`, only the sim slots that item fits are returned.
 */
export function simSlotsForPoolSlot(slot: ItemSlot, spec?: SpecId, itemId?: number): readonly SimSlotName[] {
	const simSlots: readonly SimSlotName[] = ((): readonly SimSlotName[] => {
		switch (slot) {
			case 'finger':
				return ['finger1', 'finger2'];
			case 'trinket':
				return ['trinket1', 'trinket2'];
			case 'weapon':
				if (itemId !== undefined && getItem(itemId)?.handType === HandType.HandTypeOffHand) {
					return ['offhand'];
				}
				return spec !== undefined && DUAL_WIELD_SPECS.has(spec) ? ['mainhand', 'offhand'] : ['mainhand'];
			default:
				return [slot];
		}
	})();

	if (itemId === undefined) return simSlots;
	return simSlots.filter(slotName => itemFitsSimSlot(itemId, slotName));
}

/**
 * Whether the worn main hand leaves the off hand usable: false only for a two-hander. An
 * empty main hand counts as usable, so a character with no weapon still sees off-hand rows.
 */
export function mainHandLeavesOffHandFree(wornMainHandId: number | undefined): boolean {
	if (!wornMainHandId) return true;
	return getItem(wornMainHandId)?.handType !== HandType.HandTypeTwoHand;
}

/**
 * Off-hand-only entries while a two-hander is worn, as placing one is a two-item swap. A
 * run holds them out before ordering (rank-setup.ts) and the tab's candidate count does the same.
 */
export function offHandBlockedEntries(pool: readonly PoolEntry[], spec: SpecId | undefined, wornMainHandId: number | undefined): PoolEntry[] {
	if (mainHandLeavesOffHandFree(wornMainHandId)) return [];
	return pool.filter(e => {
		const simSlots = simSlotsForPoolSlot(e.slot, spec, e.itemId);
		return simSlots.length === 1 && simSlots[0] === 'offhand';
	});
}

/**
 * One-handed weapons while a two-hander is worn: priced alone, one leaves the off hand
 * empty, a build nobody wears. Held out like `offHandBlockedEntries`. Two-handers and items
 * with no hand type stay.
 */
export function oneHandBlockedEntries(pool: readonly PoolEntry[], spec: SpecId | undefined, wornMainHandId: number | undefined): PoolEntry[] {
	if (mainHandLeavesOffHandFree(wornMainHandId)) return [];
	return pool.filter(e => {
		if (e.slot !== 'weapon') return false;
		const handType = getItem(e.itemId)?.handType;
		if (handType == null || handType === HandType.HandTypeTwoHand) {
			return false;
		}
		const simSlots = simSlotsForPoolSlot(e.slot, spec, e.itemId);
		return !(simSlots.length === 1 && simSlots[0] === 'offhand');
	});
}
