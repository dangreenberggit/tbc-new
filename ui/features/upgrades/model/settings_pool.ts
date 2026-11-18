/**
 * The pool rules behind the tab's settings: which sources a pool offers, which
 * gear sets can be selected and which are selected by default, the pool a run
 * then sims, and the count of candidates in it. Pure.
 */

import type { PagePreset } from './data/data';
import { isKaelTempLegendary } from './engine/kael-temp';
import { filterPoolByPhase, type ItemSource, offHandBlockedEntries, oneHandBlockedEntries, type PoolEntry } from './engine/pool';
import type { SpecId } from './engine/types';
import { zoneKeyOf, ZONELESS_SOURCE_LABELS } from './engine/view';
import { HEROIC_FIVE_MAN } from './pool_source';
import type { RunSettings } from './run_state';
import { type SettingsState, toRunSettings } from './settings_state';

/** The page turns the key into a label with `sourceKeyLabel` (`utils/format.ts`). */
export type SourceOption = { key: string; count: number };

/** Both a preset's `gear` and a saved set's `gear` fit this. */
type GearItems = { items: readonly { id: number }[] };

export type SetOption = {
	key: string;
	name: string;
	label: string;
	phase?: number;
	/** wowsims' preset `group`, which tells apart two presets of one phase that share a name. */
	group?: string;
	/**
	 * The heading wowsims' gear tab shows over the set (its `group`). Set only on a page with more than one heading,
	 * such as warrior's Fury and Arms, where every badge for the set names it.
	 */
	heading?: string;
	kind: 'preset' | 'saved';
	itemIds: readonly number[];
	/** The pool offers only one id of an item with twins (`twinIdsOf`), and it may not be the one the set names. */
	twinIds?: readonly number[];
	/** Counts an item as in the pool under any of its ids. */
	inPool: number;
};

const heldIds = (o: Pick<SetOption, 'itemIds' | 'twinIds'>): readonly number[] => (o.twinIds ? [...o.itemIds, ...o.twinIds] : o.itemIds);

const NO_TWINS: ReadonlyMap<number, readonly number[]> = new Map();

export type PoolFilter = {
	excludedSources: readonly string[];
	selectedSetItemIds: readonly number[];
	prune: boolean;
};

/** A ranked row has these two fields too, so the results view's source filter uses the same rules. */
export type SourcedEntry = Pick<PoolEntry, 'source' | 'sources'>;

export const sourcesOf = (entry: SourcedEntry): readonly ItemSource[] => entry.sources ?? [entry.source];

/** Falls back to the raw kind, as the engine's label does. */
export const zonelessSourceKey = (kind: string): string => ZONELESS_SOURCE_LABELS[kind] ?? kind;

/** Its first zone, else its source kind. */
export const sourceKeyOf: (entry: SourcedEntry) => string = zoneKeyOf;

/** A zone key matches any entry that drops there; a key with no zone matches only entries with no zone. */
export function sourceMatches(entry: SourcedEntry, key: string): boolean {
	const sources = sourcesOf(entry);
	if (sources.some(s => 'zone' in s && s.zone === key)) return true;
	return sourceKeyOf(entry) === key && !sources.some(s => 'zone' in s);
}

export function sourceKeysMatching(entry: SourcedEntry): string[] {
	const zones = sourcesOf(entry).flatMap(s => ('zone' in s ? [s.zone] : []));
	return zones.length > 0 ? [...new Set(zones)] : [sourceKeyOf(entry)];
}

const ZONELESS_KEYS = new Set(Object.values(ZONELESS_SOURCE_LABELS));

/** "Heroic dungeon" starts unticked under the `include-unticked` policy (`HEROIC_FIVE_MAN` in `pool_source.ts`). */
export const DEFAULT_OFF_SOURCE_KEYS: readonly string[] = HEROIC_FIVE_MAN === 'include-unticked' ? [zonelessSourceKey('heroic')] : [];

/**
 * For a key that starts unticked, a stored entry means the user ticked it. The stored list keeps a key only while
 * the pool offers it (`settings_state.ts`), so a key that returns after a phase without it starts unticked again.
 */
export function effectiveExcludedSources(
	stored: readonly string[],
	offered: readonly string[],
	defaultOff: readonly string[] = DEFAULT_OFF_SOURCE_KEYS,
): string[] {
	const off = defaultOff.filter(key => offered.includes(key));
	return [...stored.filter(key => !off.includes(key)), ...off.filter(key => !stored.includes(key))];
}

/**
 * Zones first, then other sources. The Sources dialog and the phase reset both read
 * this list, so they agree. Every key an entry matches is offered, so Hide all hides
 * every row.
 */
export function poolSourceKeysOf(pool: readonly SourcedEntry[]): string[] {
	const keys = [...new Set([...pool.map(sourceKeyOf), ...pool.flatMap(sourceKeysMatching)])];
	return [...keys.filter(k => !ZONELESS_KEYS.has(k)), ...keys.filter(k => ZONELESS_KEYS.has(k))];
}

export function sourceOptions(pool: readonly SourcedEntry[]): { raids: SourceOption[]; other: SourceOption[] } {
	const options = poolSourceKeysOf(pool).map(key => ({ key, count: pool.filter(e => sourceMatches(e, key)).length }));
	return { raids: options.filter(o => !ZONELESS_KEYS.has(o.key)), other: options.filter(o => ZONELESS_KEYS.has(o.key)) };
}

const itemIdsOf = (gear: GearItems | undefined): number[] => [...new Set((gear?.items ?? []).map(i => i.id).filter(id => id > 0))];

/** Adds "P{phase} - " unless the name already starts with the phase, so ret's preset "P2" reads "P2", not "P2 - P2". */
function presetLabel(name: string, phase: number | undefined): string {
	if (phase === undefined || new RegExp(`^p${phase}($|[^0-9])`, 'i').test(name)) return name;
	return `P${phase} - ${name}`;
}

/** True when another option has the same phase and name, so this one needs its group to tell them apart. */
const sharesPhaseAndName = (o: SetOption, options: readonly SetOption[]): boolean =>
	o.group !== undefined && options.some(other => other !== o && other.phase === o.phase && other.name === o.name);

export function setOptions({
	presets,
	savedSets,
	pool,
	twins = NO_TWINS,
}: {
	presets: readonly PagePreset[];
	savedSets: readonly { name: string; gear?: GearItems }[];
	pool: readonly PoolEntry[];
	/** `twinIdsOf` over the page's database. */
	twins?: ReadonlyMap<number, readonly number[]>;
}): SetOption[] {
	const poolIds = new Set(pool.map(e => e.itemId));
	const inPool = (itemIds: readonly number[]) => itemIds.filter(id => (twins.get(id) ?? [id]).some(t => poolIds.has(t))).length;
	const withTwinIds = (itemIds: readonly number[]) => {
		const same = [...new Set(itemIds.flatMap(id => twins.get(id) ?? []))].filter(id => !itemIds.includes(id));
		return same.length > 0 ? { itemIds, twinIds: same } : { itemIds };
	};
	const headed = new Set(presets.flatMap(p => (p.group ? [p.group] : []))).size > 1;
	// The group enters the key only where wowsims gives one, so the saved picks of ungrouped presets still match.
	const presetOptions = presets.map(({ name, phase, group, gear }): SetOption => {
		const itemIds = itemIdsOf(gear);
		return {
			key: `preset:${phase ?? ''}:${group ? `${group}/` : ''}${name}`,
			name,
			label: presetLabel(name, phase),
			phase,
			...(group ? { group } : {}),
			...(group && headed ? { heading: group } : {}),
			kind: 'preset',
			...withTwinIds(itemIds),
			inPool: inPool(itemIds),
		};
	});
	const fromPresets = presetOptions.map(o => (sharesPhaseAndName(o, presetOptions) ? { ...o, label: `${o.label} (${o.group})` } : o));
	const fromSaved = savedSets.map(({ name, gear }): SetOption => {
		const itemIds = itemIdsOf(gear);
		return { key: `saved:${name}`, name, label: name, kind: 'saved', ...withTwinIds(itemIds), inPool: inPool(itemIds) };
	});
	return [...fromPresets, ...fromSaved];
}

/**
 * The sets selected by default: presets of `bisTagPhase` with at least one item in
 * the pool and every such item tagged BiS. The phase check is needed: by ids alone,
 * feral's P3 set would also pass against the P4 BiS tags.
 */
export function defaultSetKeys(options: readonly SetOption[], pool: readonly PoolEntry[], bisTagPhase: number | undefined): string[] {
	if (bisTagPhase === undefined) return [];
	const poolIds = new Set(pool.map(e => e.itemId));
	const bisIds = new Set(pool.filter(e => e.bisTags?.includes('BiS')).map(e => e.itemId));
	return options
		.filter(o => o.kind === 'preset' && o.phase === bisTagPhase)
		.filter(o => {
			const inPool = heldIds(o).filter(id => poolIds.has(id));
			return inPool.length > 0 && inPool.every(id => bisIds.has(id));
		})
		.map(o => o.key);
}

/** Current-phase, phaseless and selected chips are always shown; the rest sit behind "Other phases (n)". */
export function splitSetChips(options: readonly SetOption[], selectedKeys: readonly string[], maxPhase: number): { main: SetOption[]; other: SetOption[] } {
	const shown = (o: SetOption) => o.phase === undefined || o.phase === maxPhase || selectedKeys.includes(o.key);
	return { main: options.filter(shown), other: options.filter(o => !shown(o)) };
}

export const selectedSetItemIds = (options: readonly SetOption[], selectedKeys: readonly string[]): number[] => [
	...new Set(options.filter(o => selectedKeys.includes(o.key)).flatMap(heldIds)),
];

/**
 * An entry stays while any of its sources is ticked, so an item from two raids
 * survives one being excluded. `prune` keeps only the selected sets' items; the
 * sets never add back an item the Sources filter removed.
 */
export function effectivePool(pool: readonly PoolEntry[], { excludedSources, selectedSetItemIds, prune }: PoolFilter): PoolEntry[] {
	const excluded = new Set(excludedSources);
	const ticked = poolSourceKeysOf(pool).filter(key => !excluded.has(key));
	const inSets = new Set(selectedSetItemIds);
	return pool.filter(e => ticked.some(key => sourceMatches(e, key)) && (!prune || inSets.has(e.itemId)));
}

export type MainHandContext = { spec: SpecId | undefined; wornMainHandId: number | undefined };

/**
 * The candidates an uncapped run sims. It uses the engine's own filters so the count matches the run: phase, Kael's
 * temporary legendaries, and the off-hand and one-hand items a worn two-hander rules out.
 */
export const eligibleCount = (pool: readonly PoolEntry[], maxPhase: number, { spec, wornMainHandId }: MainHandContext): number => {
	const phaseEligible = filterPoolByPhase(pool, maxPhase).filter(e => !isKaelTempLegendary(e.itemId));
	return (
		phaseEligible.length -
		offHandBlockedEntries(phaseEligible, spec, wornMainHandId).length -
		oneHandBlockedEntries(phaseEligible, spec, wornMainHandId).length
	);
};

export type RowTag = { key: string; label: string };

export const withHeading = (label: string, heading: string): string => `${label} (${heading})`;

/**
 * One badge per selected set that holds the item. The heading is added so a
 * Fury-only item reads "BIS (Fury)", not a "BIS" that Arms could take for its own.
 * Badges that would still read the same get their phase in front; without a
 * heading, those that share the phase too get their group.
 */
export function rowTags(itemId: number, selectedOptions: readonly SetOption[]): RowTag[] {
	const holding = selectedOptions.filter(o => heldIds(o).includes(itemId));
	return holding.map(o => {
		const shared = holding.some(other => other !== o && other.name === o.name && other.heading === o.heading);
		const label = shared && o.phase !== undefined ? `P${o.phase} ${o.name}` : o.name;
		if (o.heading !== undefined) return { key: o.key, label: withHeading(label, o.heading) };
		return { key: o.key, label: sharesPhaseAndName(o, holding) ? `${label} (${o.group})` : label };
	});
}

const NO_HEADINGS: readonly string[] = [];

/** Lets the pool's "BiS" badge on a row in no selected set name the build it is BiS for, on a page with headings. */
export function bisHeadingIndex(options: readonly SetOption[], bisTagPhase: number | undefined): (itemId: number) => readonly string[] {
	const byItem = new Map<number, string[]>();
	if (bisTagPhase === undefined) return () => NO_HEADINGS;
	for (const o of options) {
		if (o.kind !== 'preset' || o.phase !== bisTagPhase || o.heading === undefined) continue;
		for (const itemId of heldIds(o)) {
			const headings = byItem.get(itemId) ?? [];
			if (!headings.includes(o.heading)) headings.push(o.heading);
			byItem.set(itemId, headings);
		}
	}
	return itemId => byItem.get(itemId) ?? NO_HEADINGS;
}

const NO_TAGS: readonly RowTag[] = [];

/** Each item keeps one array while the selection stands, so a memoised name cell does not re-render when its row moves. */
export function rowTagIndex(selectedOptions: readonly SetOption[]): (itemId: number) => readonly RowTag[] {
	const byItem = new Map<number, readonly RowTag[]>();
	for (const itemId of new Set(selectedOptions.flatMap(heldIds))) byItem.set(itemId, rowTags(itemId, selectedOptions));
	return itemId => byItem.get(itemId) ?? NO_TAGS;
}

type SavedSet = { name: string; gear?: GearItems };

/** Everything a spec and phase offer that does not depend on what the user picked. */
export type SettingsOffer = {
	pool: readonly PoolEntry[];
	sources: { raids: SourceOption[]; other: SourceOption[] };
	sourceKeys: readonly string[];
	options: readonly SetOption[];
	defaultKeys: readonly string[];
};

export function settingsOffer({
	pool,
	presets,
	savedSets,
	bisTagPhase,
	twins,
}: {
	pool: readonly PoolEntry[];
	presets: readonly PagePreset[];
	savedSets: readonly SavedSet[];
	bisTagPhase: number | undefined;
	/** `twinIdsOf` over the page's database, so a set naming another id of an item the pool offers once still holds it. */
	twins?: ReadonlyMap<number, readonly number[]>;
}): SettingsOffer {
	const options = setOptions({ presets, savedSets, pool, twins });
	return {
		pool,
		sources: sourceOptions(pool),
		sourceKeys: poolSourceKeysOf(pool),
		options,
		defaultKeys: defaultSetKeys(options, pool, bisTagPhase),
	};
}

/** Kept apart from the other settings so it can outlive changes to them. */
export type SetSelection = {
	selectedOptions: readonly SetOption[];
	selectedKeys: readonly string[];
	selectedItemIds: readonly number[];
	chips: { main: SetOption[]; other: SetOption[] };
};

export function setSelection(offer: SettingsOffer, selectedSetKeys: readonly string[], maxPhase: number): SetSelection {
	// A saved set deleted since it was picked is no longer a pick.
	const selectedOptions = offer.options.filter(o => selectedSetKeys.includes(o.key));
	const selectedKeys = selectedOptions.map(o => o.key);
	return {
		selectedOptions,
		selectedKeys,
		selectedItemIds: selectedSetItemIds(selectedOptions, selectedKeys),
		chips: splitSetChips(offer.options, selectedKeys, maxPhase),
	};
}

export const runSettingsOf = (selection: SetSelection, state: SettingsState): RunSettings =>
	toRunSettings({ ...state, selectedSetKeys: selection.selectedKeys }, selection.selectedItemIds);

/** Separate from `runSettingsOf`, so an iterations edit does not filter the pool again. */
export const eligibleCountOf = (offer: SettingsOffer, filter: PoolFilter, maxPhase: number, mainHand: MainHandContext): number =>
	eligibleCount(effectivePool(offer.pool, filter), maxPhase, mainHand);
