/**
 * The pool rules behind the tab's settings: which sources a pool offers, which
 * gear sets can be selected and which are selected by default, the pool a run
 * then sims, and the count of candidates in it. Pure, and ported from the old
 * tab (cb561067 `upgrades_tab.tsx`), where they were private methods.
 */

import { isKaelTempLegendary } from './engine/kael-temp';
import { filterPoolByPhase, type ItemSource, offHandBlockedEntries, type PoolEntry } from './engine/pool';
import type { SpecId } from './engine/types';
import { SOURCE_LABELS } from './engine/view';
import { HEROIC_FIVE_MAN } from './pool_source';
import type { RunSettings } from './run_state';
import { type SettingsState, toRunSettings } from './settings_state';

/** A source the Sources dialog lists. The page names it from its key (`utils/format.ts` `sourceKeyLabel`). */
export type SourceOption = { key: string; count: number };

/** A gear set as the settings need it: anything with item ids, which a preset's `gear` and a saved set's `gear` both are. */
type GearItems = { items: readonly { id: number }[] };

export type SetOption = {
	key: string;
	name: string;
	label: string;
	phase?: number;
	/** wowsims' preset `group`, which tells apart two presets of one phase that share a name (ticket 690). */
	group?: string;
	kind: 'preset' | 'saved';
	itemIds: readonly number[];
	/** How many of `itemIds` are in this spec and phase's pool. */
	inPool: number;
};

export type PoolFilter = {
	excludedSources: readonly string[];
	selectedSetItemIds: readonly number[];
	prune: boolean;
};

/** What the source rules read of an entry; a ranked row has the same two fields, so the results view's source filter shares them. */
export type SourcedEntry = Pick<PoolEntry, 'source' | 'sources'>;

/** Every source of an entry: its `sources` list when it has one, else its one `source`. */
export const sourcesOf = (entry: SourcedEntry): readonly ItemSource[] => entry.sources ?? [entry.source];

/** The key of a zoneless source bucket: the engine's label for the kind, else the raw kind, as the engine's label falls back. */
export const bucketKeyOf = (kind: string): string => SOURCE_LABELS[kind] ?? kind;

/**
 * The source key an entry files under: its first zone, else its source
 * bucket. Mirrors the engine's module-private `zoneKeyOf` (view.ts) over a
 * pool entry; the engine does not export it, so this is a copy and must
 * change with it.
 */
export function sourceKeyOf(entry: SourcedEntry): string {
	for (const s of sourcesOf(entry)) {
		if ('zone' in s) return s.zone;
	}
	return bucketKeyOf(entry.source.kind);
}

/** A zone matches any entry that drops there; a zoneless bucket matches only entries with no zone. */
export function sourceMatches(entry: SourcedEntry, key: string): boolean {
	const sources = sourcesOf(entry);
	if (sources.some(s => 'zone' in s && s.zone === key)) return true;
	return sourceKeyOf(entry) === key && !sources.some(s => 'zone' in s);
}

/** Every key `sourceMatches` matches an entry by: each of its zones, else its source bucket. */
export function sourceKeysMatching(entry: SourcedEntry): string[] {
	const zones = sourcesOf(entry).flatMap(s => ('zone' in s ? [s.zone] : []));
	return zones.length > 0 ? [...new Set(zones)] : [sourceKeyOf(entry)];
}

const ZONELESS_KEYS = new Set(Object.values(SOURCE_LABELS));

/**
 * Source keys that start unticked wherever a pool offers them: the "Heroic dungeon" bucket under the
 * `include-unticked` policy (`pool_source.ts` `HEROIC_FIVE_MAN`, which the owner chose on 2026-10-18).
 */
export const DEFAULT_OFF_SOURCE_KEYS: readonly string[] = HEROIC_FIVE_MAN === 'include-unticked' ? [bucketKeyOf('heroic')] : [];

/**
 * The sources a run excludes, from the stored toggles and the keys the pool offers. For a key that starts unticked,
 * a stored entry is the user's tick, so the key is excluded unless it is stored. The stored list keeps a key only
 * while the pool offers it (`settings_state.ts`), so a tick stays through a phase change that still offers the key,
 * and a key that comes back after a phase without it starts unticked again.
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
 * Every source key the pool offers, raid zones first, then zoneless buckets,
 * each in first-seen order. These are the keys the Sources dialog lists and the
 * only ones a scope's exclusions may name; the offer and the phase reset
 * (`follow_phase.ts`) both read them, so a reset never keeps or drops a source
 * the dialog disagrees on.
 *
 * Every key an entry matches is offered, so each one can be unticked and a
 * Hide all hides every row (tickets 647, 649). A zone that is no entry's first
 * comes after every first zone, so the first zones keep their order.
 */
export function validSourceKeysOf(pool: readonly SourcedEntry[]): string[] {
	const keys = [...new Set([...pool.map(sourceKeyOf), ...pool.flatMap(sourceKeysMatching)])];
	return [...keys.filter(k => !ZONELESS_KEYS.has(k)), ...keys.filter(k => ZONELESS_KEYS.has(k))];
}

export function sourceOptions(pool: readonly SourcedEntry[]): { raids: SourceOption[]; other: SourceOption[] } {
	const options = validSourceKeysOf(pool).map(key => ({ key, count: pool.filter(e => sourceMatches(e, key)).length }));
	return { raids: options.filter(o => !ZONELESS_KEYS.has(o.key)), other: options.filter(o => ZONELESS_KEYS.has(o.key)) };
}

const itemIdsOf = (gear: GearItems | undefined): number[] => [...new Set((gear?.items ?? []).map(i => i.id).filter(id => id > 0))];

/**
 * A preset's label leads with "P{phase} - " unless its name already starts
 * with that P-token (ret's presets are named "P2", "P3"), so ret shows "P2"
 * and "P3 - Bulwark", not "P2 - P2".
 */
function presetLabel(name: string, phase: number | undefined): string {
	if (phase === undefined || new RegExp(`^p${phase}($|[^0-9])`, 'i').test(name)) return name;
	return `P${phase} - ${name}`;
}

/** A grouped option that another option of the same phase and name would read the same as, so its group is shown. */
const sharesPhaseAndName = (o: SetOption, options: readonly SetOption[]): boolean =>
	o.group !== undefined && options.some(other => other !== o && other.phase === o.phase && other.name === o.name);

export function setOptions({
	presets,
	savedSets,
	pool,
}: {
	presets: readonly PresetSet[];
	savedSets: readonly { name: string; gear?: GearItems }[];
	pool: readonly PoolEntry[];
}): SetOption[] {
	const poolIds = new Set(pool.map(e => e.itemId));
	const inPool = (itemIds: readonly number[]) => itemIds.filter(id => poolIds.has(id)).length;
	// The group enters the key only where wowsims gives one, so the saved picks of ungrouped presets still match.
	const presetOptions = presets.map(({ name, phase, group, gear }): SetOption => {
		const itemIds = itemIdsOf(gear);
		return {
			key: `preset:${phase ?? ''}:${group ? `${group}/` : ''}${name}`,
			name,
			label: presetLabel(name, phase),
			phase,
			...(group ? { group } : {}),
			kind: 'preset',
			itemIds,
			inPool: inPool(itemIds),
		};
	});
	const fromPresets = presetOptions.map(o => (sharesPhaseAndName(o, presetOptions) ? { ...o, label: `${o.label} (${o.group})` } : o));
	const fromSaved = savedSets.map(({ name, gear }): SetOption => {
		const itemIds = itemIdsOf(gear);
		return { key: `saved:${name}`, name, label: name, kind: 'saved', itemIds, inPool: inPool(itemIds) };
	});
	return [...fromPresets, ...fromSaved];
}

/**
 * The sets selected by default: the presets of the phase the pool's BiS tags
 * come from (`bisTagPhaseFor().tagsFromPhase`) whose in-pool items are all
 * BiS-tagged, with at least one in the pool. The phase test is needed: the ids
 * alone over-select (feral P3's ids also satisfy the P4 BiS pair). Since
 * every preset of the tag phase is a BiS set (ticket 686), the ids test
 * passes for each of them that has an item in the pool, ret's "Bulwark"
 * included.
 */
export function defaultSetKeys(options: readonly SetOption[], pool: readonly PoolEntry[], bisTagPhase: number | undefined): string[] {
	if (bisTagPhase === undefined) return [];
	const poolIds = new Set(pool.map(e => e.itemId));
	const bisIds = new Set(pool.filter(e => e.bisTags?.includes('BiS')).map(e => e.itemId));
	return options
		.filter(o => o.kind === 'preset' && o.phase === bisTagPhase)
		.filter(o => {
			const inPool = o.itemIds.filter(id => poolIds.has(id));
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
	...new Set(options.filter(o => selectedKeys.includes(o.key)).flatMap(o => o.itemIds)),
];

/**
 * The pool a run sims. An entry stays while some source it matches is still
 * ticked, so an item from two raids survives one being excluded. With prune
 * on, only the selected sets' items stay; the sets never add an item back
 * past the Sources filter (ticket 456).
 */
export function effectivePool(pool: readonly PoolEntry[], { excludedSources, selectedSetItemIds, prune }: PoolFilter): PoolEntry[] {
	const excluded = new Set(excludedSources);
	const ticked = validSourceKeysOf(pool).filter(key => !excluded.has(key));
	const inSets = new Set(selectedSetItemIds);
	return pool.filter(e => ticked.some(key => sourceMatches(e, key)) && (!prune || inSets.has(e.itemId)));
}

/** What the engine's off-hand rule reads of the page: the spec, and the id of the worn main hand (undefined when empty). */
export type MainHandContext = { spec: SpecId | undefined; wornMainHandId: number | undefined };

/**
 * The candidates an uncapped run sims: the engine's own phase filter and Kael exclusion, applied to the effective
 * pool, less the off-hand-only items a worn two-hander holds out.
 */
export const eligibleCount = (pool: readonly PoolEntry[], maxPhase: number, { spec, wornMainHandId }: MainHandContext): number => {
	const phaseEligible = filterPoolByPhase(pool, maxPhase).filter(e => !isKaelTempLegendary(e.itemId));
	return phaseEligible.length - offHandBlockedEntries(phaseEligible, spec, wornMainHandId).length;
};

/** A row's badge for a selected set: the set's key, and its name as the gear tab names it. */
export type RowTag = { key: string; label: string };

/**
 * One badge per selected set that holds the item (ticket 430). Two selected
 * sets with the same name get their phase in front so the badges do not read
 * the same; two that also share the phase get their wowsims group after it
 * (ticket 690).
 */
export function rowTags(itemId: number, selectedOptions: readonly SetOption[]): RowTag[] {
	const holding = selectedOptions.filter(o => o.itemIds.includes(itemId));
	return holding.map(o => {
		const shared = holding.some(other => other !== o && other.name === o.name);
		const label = shared && o.phase !== undefined ? `P${o.phase} ${o.name}` : o.name;
		return { key: o.key, label: sharesPhaseAndName(o, holding) ? `${label} (${o.group})` : label };
	});
}

const NO_TAGS: readonly RowTag[] = [];

/**
 * `rowTags` for every item at once. Each item keeps one array for as long as
 * the selection stands, so a memoised name cell given its tags does not render
 * again when only its row's position moves.
 */
export function rowTagIndex(selectedOptions: readonly SetOption[]): (itemId: number) => readonly RowTag[] {
	const byItem = new Map<number, readonly RowTag[]>();
	for (const itemId of new Set(selectedOptions.flatMap(o => o.itemIds))) byItem.set(itemId, rowTags(itemId, selectedOptions));
	return itemId => byItem.get(itemId) ?? NO_TAGS;
}

type PresetSet = { name: string; phase?: number; group?: string; gear: GearItems };
type SavedSet = { name: string; gear?: GearItems };

/** What a spec and phase offer the settings: everything that does not depend on what the user picked. */
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
}: {
	pool: readonly PoolEntry[];
	presets: readonly PresetSet[];
	savedSets: readonly SavedSet[];
	bisTagPhase: number | undefined;
}): SettingsOffer {
	const options = setOptions({ presets, savedSets, pool });
	return { pool, sources: sourceOptions(pool), sourceKeys: validSourceKeysOf(pool), options, defaultKeys: defaultSetKeys(options, pool, bisTagPhase) };
}

/** What the user's picks make of an offer: the chips, the run they ask for and its candidate count. */
/** The sets the user picked, as the offer has them. Apart from `SettingsView` so it can outlive changes to the other settings. */
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

/** What one click of Run asks for, with the selection as the offer has it. */
export const runSettingsOf = (selection: SetSelection, state: SettingsState): RunSettings =>
	toRunSettings({ ...state, selectedSetKeys: selection.selectedKeys }, selection.selectedItemIds);

/** The candidates an uncapped run would sim under the pool filters; apart from `runSettingsOf`, so an iterations edit does not refilter the pool. */
export const eligibleCountOf = (offer: SettingsOffer, filter: PoolFilter, maxPhase: number, mainHand: MainHandContext): number =>
	eligibleCount(effectivePool(offer.pool, filter), maxPhase, mainHand);
