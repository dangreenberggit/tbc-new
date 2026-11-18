/**
 * The candidate pool, built at run time from wowsims' item database and the spec's
 * presets. `pool_source.cells.fixture.json` pins the per-cell sizes; its `_comment`
 * says how to re-pin them.
 */

import { ItemQuality, ItemType, type Spec } from '@generated/proto/common';
import { UIItem } from '@generated/proto/ui';
import { MISSING_ITEM_EFFECTS } from '@sim/constants/missing_effects_auto_gen';
import { canEquipItem } from '@sim/proto/items';
import type { IndividualSimHost } from '@sim/sim_host';

import { type ExchangeIndex, indexExchange, isHeroicFiveManDrop, sourcesOf, type TierExchange } from '../utils/item_sources';
import tierExchange from './data/tier-exchange.json';
import { isKaelTempLegendary } from './engine/kael-temp';
import type { ItemSlot, ItemSource, PoolEntry } from './engine/pool';

/**
 * Heroic five-man drops outside Magisters' Terrace. `exclude` drops an item
 * whose every source is such a drop; `include` keeps it; `include-unticked`
 * keeps it and starts the Sources dialog's "Heroic dungeon" entry unticked, so
 * a default run ranks what `exclude` would.
 */
export type HeroicFiveManPolicy = 'exclude' | 'include' | 'include-unticked';

/** Heroic five-man drops are in the pool, with their Sources entry unticked. */
export const HEROIC_FIVE_MAN: HeroicFiveManPolicy = 'include-unticked';

/**
 * A preset gear set as the pool reads it: its name, its declared phase if any, its wowsims `group` if any (hunter's
 * Beast Mastery/Survival, warrior's Fury/Arms, which reuse a name within a phase), and its item ids.
 */
export type PresetSet = { name: string; phase?: number; group?: string; itemIds: readonly number[] };

/**
 * The floor every non-preset candidate meets: epic or better, and item level 100
 * or more unless wowsims records an effect for it. It bounds run cost, since the
 * tab sims every candidate.
 */
const MIN_QUALITY = ItemQuality.ItemQualityEpic;
const MIN_ILVL = 100;

const SLOT_BY_ITEM_TYPE: Partial<Record<ItemType, ItemSlot>> = {
	[ItemType.ItemTypeHead]: 'head',
	[ItemType.ItemTypeNeck]: 'neck',
	[ItemType.ItemTypeShoulder]: 'shoulder',
	[ItemType.ItemTypeBack]: 'back',
	[ItemType.ItemTypeChest]: 'chest',
	[ItemType.ItemTypeWrist]: 'wrist',
	[ItemType.ItemTypeHands]: 'hands',
	[ItemType.ItemTypeWaist]: 'waist',
	[ItemType.ItemTypeLegs]: 'legs',
	[ItemType.ItemTypeFeet]: 'feet',
	[ItemType.ItemTypeFinger]: 'finger',
	[ItemType.ItemTypeTrinket]: 'trinket',
	[ItemType.ItemTypeWeapon]: 'weapon',
	[ItemType.ItemTypeRanged]: 'ranged',
};

export const poolSlotOf = (item: Pick<UIItem, 'type'>): ItemSlot | undefined => SLOT_BY_ITEM_TYPE[item.type];

/** An item's phase, or undefined where db.json leaves `phase` out (the proto then reads 0). */
const knownPhase = (item: Pick<UIItem, 'phase'>): number | undefined => item.phase || undefined;

/** For the floor: an item with no phase is in no phase, so it never meets one. */
const phaseOf = (item: Pick<UIItem, 'phase'>): number => knownPhase(item) ?? Infinity;

/** The base item level, as the gear picker and db.json's `scalingOptions` key 0 give it. */
export const ilvlOf = (item: Pick<UIItem, 'scalingOptions' | 'ilvl'>): number => item.scalingOptions[0]?.ilvl ?? item.ilvl;

/**
 * db.json gives the item an `itemEffects` record and the missing-effects list does
 * not name it. Not "simulated": the page cannot see Go's id-keyed registrations, and
 * a few old epics have a record but no registration.
 */
export const hasEffectRecord = (item: Pick<UIItem, 'id' | 'itemEffects'>, missingIds: ReadonlySet<number>): boolean =>
	item.itemEffects.length > 0 && !missingIds.has(item.id);

/** Every source is a heroic five-man drop outside Magisters' Terrace. An item with no sources is not. */
export function isHeroicFiveManOnly(item: Pick<UIItem, 'sources'>): boolean {
	return item.sources.length > 0 && item.sources.every(s => s.source.oneofKind === 'drop' && isHeroicFiveManDrop(s.source.drop));
}

/**
 * A preset's phase: its declared `phase`, else the highest phase among its
 * items that the database knows. A set with no known item has no phase and is
 * never a phase's set.
 */
export function presetPhase(preset: Pick<PresetSet, 'phase' | 'itemIds'>, itemPhaseOf: (id: number) => number | undefined): number | undefined {
	if (preset.phase !== undefined) return preset.phase;
	const phases = preset.itemIds.map(itemPhaseOf).filter((p): p is number => p !== undefined);
	return phases.length > 0 ? Math.max(...phases) : undefined;
}

/**
 * The BiS sets at `maxPhase`: every preset whose phase is the newest preset
 * phase at or below `maxPhase`, with that phase. wowsims' `PresetGear` has no
 * BiS field, and a pre-raid or alternative set ("Bulwark", "Alt 6%") counts like
 * any other preset, so no preset is told apart by its name.
 */
export function bisSetsFor(
	presets: readonly PresetSet[],
	maxPhase: number,
	itemPhaseOf: (id: number) => number | undefined,
): { phase: number; sets: PresetSet[] } | undefined {
	const phased = presets
		.map(p => ({ preset: p, phase: presetPhase(p, itemPhaseOf) }))
		.filter((p): p is { preset: PresetSet; phase: number } => p.phase !== undefined && p.phase <= maxPhase);
	if (phased.length === 0) return undefined;
	const phase = Math.max(...phased.map(p => p.phase));
	return { phase, sets: phased.filter(p => p.phase === phase).map(p => p.preset) };
}

/**
 * The pool for one spec at `maxPhase`: every item the spec can equip in a pool slot
 * that meets the floor or is in a preset of that phase or earlier, less Kael's
 * temporary legendaries, items missing an effect and, per `policy`, heroic five-mans.
 */
export function selectPool(
	items: readonly UIItem[],
	canEquip: (item: UIItem) => boolean,
	presets: readonly PresetSet[],
	missingIds: ReadonlySet<number>,
	maxPhase: number,
	policy: HeroicFiveManPolicy,
	sourcesFor: (item: UIItem) => ItemSource[] = () => [{ kind: 'unknown' }],
	wornIds: ReadonlySet<number> = new Set(),
): PoolEntry[] {
	const byId = new Map(items.map(item => [item.id, item]));
	const itemPhaseOf = (id: number): number | undefined => {
		const item = byId.get(id);
		return item === undefined ? undefined : knownPhase(item);
	};
	const presetIds = new Set(presets.filter(p => (presetPhase(p, itemPhaseOf) ?? Infinity) <= maxPhase).flatMap(p => p.itemIds));
	const meetsFloor = (item: UIItem) =>
		phaseOf(item) <= maxPhase && item.quality >= MIN_QUALITY && (ilvlOf(item) >= MIN_ILVL || hasEffectRecord(item, missingIds));

	const bis = bisSetsFor(presets, maxPhase, itemPhaseOf);
	const setNamesHolding = (sets: readonly PresetSet[], id: number) => sets.filter(s => s.itemIds.includes(id)).map(s => s.name);

	const pool: PoolEntry[] = [];
	for (const item of items) {
		const slot = poolSlotOf(item);
		if (slot === undefined || isKaelTempLegendary(item.id) || missingIds.has(item.id) || !canEquip(item)) continue;
		if (!meetsFloor(item) && !presetIds.has(item.id)) continue;
		if (policy === 'exclude' && isHeroicFiveManOnly(item)) continue;
		const bisSets = bis ? setNamesHolding(bis.sets, item.id) : [];
		const curatedSets = setNamesHolding(presets, item.id);
		const sources = sourcesFor(item);
		pool.push({
			itemId: item.id,
			name: item.name,
			slot,
			phase: item.phase,
			source: sources[0] ?? { kind: 'unknown' },
			sources,
			...(bisSets.length > 0 ? { bisTags: ['BiS' as const], bisSets } : {}),
			...(curatedSets.length > 0 ? { curatedSets } : {}),
		});
	}
	return offerTwinsOnce(pool, byId, wornIds);
}

/** db.json describes `a` and `b` the same in every field but the id. */
const sameButId = (a: UIItem, b: UIItem): boolean => UIItem.equals(a, { ...b, id: a.id });

/** `entries` grouped by `sameButId` over their items, groups in first-seen order. Equal records share a name, so only same-name entries are compared. */
function groupTwins<T>(entries: readonly T[], itemOf: (entry: T) => UIItem): T[][] {
	const groups: T[][] = [];
	const groupsByName = new Map<string, T[][]>();
	for (const entry of entries) {
		const item = itemOf(entry);
		const sameName = groupsByName.get(item.name) ?? [];
		groupsByName.set(item.name, sameName);
		const twins = sameName.find(group => sameButId(itemOf(group[0]!), item));
		if (twins) twins.push(entry);
		else {
			const group = [entry];
			sameName.push(group);
			groups.push(group);
		}
	}
	return groups;
}

/**
 * One entry per group of items db.json describes the same but the id (Sergeant's
 * Heavy Cape 28378 and 28379), which would show as identical rows. It keeps the
 * worn id, else one a preset holds, else the lowest, with every member's tags.
 */
function offerTwinsOnce(pool: readonly PoolEntry[], byId: ReadonlyMap<number, UIItem>, wornIds: ReadonlySet<number>): PoolEntry[] {
	const groups = groupTwins(pool, entry => byId.get(entry.itemId)!);
	return groups.map(group => (group.length === 1 ? group[0]! : mergeTwins(group, wornIds)));
}

/**
 * Each id `offerTwinsOnce` would group, with every id of its group. The pool offers
 * one of them, so the settings match set items through this (`settings_pool.ts`)
 * and a set naming another id still holds the item.
 */
export function twinIdsOf(items: readonly UIItem[]): ReadonlyMap<number, readonly number[]> {
	const twins = new Map<number, readonly number[]>();
	for (const group of groupTwins(items, item => item)) {
		if (group.length < 2) continue;
		const ids = group.map(item => item.id);
		for (const id of ids) twins.set(id, ids);
	}
	return twins;
}

function mergeTwins(group: readonly PoolEntry[], wornIds: ReadonlySet<number>): PoolEntry {
	const lowest = group.reduce((a, b) => (b.itemId < a.itemId ? b : a));
	const kept = group.find(e => wornIds.has(e.itemId)) ?? group.find(e => (e.curatedSets?.length ?? 0) > 0) ?? lowest;
	const union = (sets: (e: PoolEntry) => string[] | undefined) => [...new Set(group.flatMap(e => sets(e) ?? []))];
	const { bisTags: _bisTags, bisSets: _bisSets, curatedSets: _curatedSets, ...rest } = kept;
	const bisSets = union(e => e.bisSets);
	const curatedSets = union(e => e.curatedSets);
	return {
		...rest,
		...(bisSets.length > 0 ? { bisTags: ['BiS' as const], bisSets } : {}),
		...(curatedSets.length > 0 ? { curatedSets } : {}),
	};
}

let missingIdsCache: ReadonlySet<number> | undefined;
const missingIds = (): ReadonlySet<number> => (missingIdsCache ??= new Set(MISSING_ITEM_EFFECTS.keys()));

// The file's shape is stated by `TierExchange`, never derived from the JSON import.
let exchangeCache: ExchangeIndex | undefined;
const exchange = () => (exchangeCache ??= indexExchange(tierExchange as TierExchange));

/** A wowsims preset as the page holds it, read down to what the pool needs. */
export const presetSetOf = ({
	name,
	phase,
	group,
	gear,
}: {
	name: string;
	phase?: number;
	group?: string;
	gear: { items: readonly { id: number }[] };
}): PresetSet => ({
	name,
	...(phase !== undefined ? { phase } : {}),
	...(group !== undefined ? { group } : {}),
	itemIds: [...new Set(gear.items.map(i => i.id).filter(id => id > 0))],
});

export type PoolHost = Pick<IndividualSimHost<Spec>, 'player' | 'sim'>;

/** The phase of an item as the page's database gives it, for `presetPhase`; undefined before the database has loaded. */
export const itemPhaseLookup =
	(host: PoolHost) =>
	(id: number): number | undefined => {
		const item = host.sim.db?.getItemById(id);
		return item === undefined ? undefined : knownPhase(item);
	};

/** The page's pool: its database, its spec's equip rule and its presets. Empty until the sim's database has loaded. */
export function buildPool(host: PoolHost, presets: readonly PresetSet[], maxPhase: number): PoolEntry[] {
	const db = host.sim.db;
	if (!db) return [];
	const playerSpec = host.player.getPlayerSpec();
	const wornIds = new Set(
		host.player
			.getGear()
			.getEquippedItems()
			.flatMap(eq => (eq ? [eq.id] : [])),
	);
	return selectPool(
		db.getAllItems(),
		item => canEquipItem(item, playerSpec, undefined),
		presets,
		missingIds(),
		maxPhase,
		HEROIC_FIVE_MAN,
		item => sourcesOf(item, db, exchange()),
		wornIds,
	);
}
