import { describe, expect, it } from 'vitest';

import { dbPoolFor } from '../testing/db_pool';
import type { PoolEntry } from './engine/pool';
import {
	DEFAULT_OFF_SOURCE_KEYS,
	defaultSetKeys,
	effectiveExcludedSources,
	effectivePool,
	eligibleCount,
	eligibleCountOf,
	rowTagIndex,
	rowTags,
	runSettingsOf,
	selectedSetItemIds,
	type SetOption,
	setOptions,
	setSelection,
	settingsOffer,
	sourceKeyOf,
	sourceOptions,
	splitSetChips,
	validSourceKeysOf,
} from './settings_pool';
import { afterScopeChange, initialSettings, withPrune, withSetToggled, withSourceToggled } from './settings_state';

const entry = (itemId: number, source: PoolEntry['source'], extra: Partial<PoolEntry> = {}): PoolEntry => ({
	itemId,
	name: `item ${itemId}`,
	slot: 'head',
	phase: 3,
	source,
	...extra,
});

const BT = { kind: 'raid', zone: 'Black Temple' } as const;
const HYJAL = { kind: 'raid', zone: 'Hyjal Summit' } as const;

// Two raids, an item that drops in both, a zoneless badge item, a crafted item
// (filed under Crafted), and a Kael legendary.
const POOL: PoolEntry[] = [
	entry(1, BT, { bisTags: ['BiS'] }),
	entry(2, BT, { sources: [BT, HYJAL] }),
	entry(3, HYJAL, { bisTags: ['BiS'] }),
	entry(4, { kind: 'badge', cost: 75 }),
	entry(5, { kind: 'crafted', profession: 'Blacksmithing' }, { bisTags: ['Alt'] }),
	entry(30318, { kind: 'raid', zone: 'Tempest Keep' }, { phase: 2 }),
	entry(6, BT, { phase: 4 }),
];

// An item from Hyjal Summit and Zul'Aman where no item has Zul'Aman first, as no real pool has (tickets 647, 649).
const ZUL_AMAN = { kind: 'raid', zone: "Zul'Aman" } as const;
const TWO_ZONE_POOL: PoolEntry[] = [
	entry(7, HYJAL, { sources: [HYJAL, ZUL_AMAN] }),
	entry(8, { kind: 'raid', zone: 'Tempest Keep' }),
	entry(9, { kind: 'badge', cost: 75 }),
];

const gear = (...ids: number[]) => ({ items: ids.map(id => ({ id })) });

/** No main hand worn, so the off-hand rule holds nothing out; `settings_pool.offhand.test.ts` covers the rule. */
const NO_WEAPON = { spec: undefined, wornMainHandId: undefined };

describe('sourceKeyOf', () => {
	it('files an entry under its first zone, else under its source bucket', () => {
		expect(POOL.map(sourceKeyOf)).toEqual(['Black Temple', 'Black Temple', 'Hyjal Summit', 'Badge vendor', 'Crafted', 'Tempest Keep', 'Black Temple']);
	});
});

describe('sourceOptions', () => {
	it('lists raid zones first, then zoneless buckets, each in first-seen order with its entry count', () => {
		expect(sourceOptions(POOL)).toEqual({
			raids: [
				{ key: 'Black Temple', count: 3 },
				{ key: 'Hyjal Summit', count: 2 },
				{ key: 'Tempest Keep', count: 1 },
			],
			other: [
				{ key: 'Badge vendor', count: 1 },
				{ key: 'Crafted', count: 1 },
			],
		});
	});

	it('leaves out an empty section', () => {
		expect(sourceOptions([entry(4, { kind: 'badge', cost: 75 })]).raids).toEqual([]);
	});
});

describe('validSourceKeysOf', () => {
	it('lists raid zones first, then zoneless buckets, which are the keys the Sources dialog lists', () => {
		expect(validSourceKeysOf(POOL)).toEqual(['Black Temple', 'Hyjal Summit', 'Tempest Keep', 'Badge vendor', 'Crafted']);
		const { raids, other } = sourceOptions(POOL);
		expect([...raids, ...other].map(o => o.key)).toEqual(validSourceKeysOf(POOL));
	});

	// Tickets 647 and 649: an entry's second zone is offered though no entry has it first, after the first zones.
	it('offers every zone an entry matches, each zone that is some entry’s first in its old place', () => {
		expect(validSourceKeysOf(TWO_ZONE_POOL)).toEqual(['Hyjal Summit', 'Tempest Keep', "Zul'Aman", 'Badge vendor']);
		expect(sourceOptions(TWO_ZONE_POOL).raids).toEqual([
			{ key: 'Hyjal Summit', count: 1 },
			{ key: 'Tempest Keep', count: 1 },
			{ key: "Zul'Aman", count: 1 },
		]);
	});
});

const ids = (pool: readonly PoolEntry[]) => pool.map(e => e.itemId);
const NO_FILTER = { excludedSources: [], selectedSetItemIds: [], prune: false };

describe('effectivePool', () => {
	it('keeps the whole pool when nothing is excluded', () => {
		expect(ids(effectivePool(POOL, NO_FILTER))).toEqual(ids(POOL));
	});

	it('keeps an item from two raids while one of them is still ticked, and drops it when both are excluded', () => {
		expect(ids(effectivePool(POOL, { ...NO_FILTER, excludedSources: ['Black Temple'] }))).toEqual([2, 3, 4, 5, 30318]);
		expect(ids(effectivePool(POOL, { ...NO_FILTER, excludedSources: ['Black Temple', 'Hyjal Summit'] }))).toEqual([4, 5, 30318]);
	});

	it('keeps an item from two raids while its second is ticked, though no item has that raid first', () => {
		expect(ids(effectivePool(TWO_ZONE_POOL, { ...NO_FILTER, excludedSources: ['Hyjal Summit'] }))).toEqual([7, 8, 9]);
		expect(ids(effectivePool(TWO_ZONE_POOL, { ...NO_FILTER, excludedSources: ['Hyjal Summit', "Zul'Aman"] }))).toEqual([8, 9]);
	});

	it('files a crafted item under Crafted, whatever zone its recipe drops in', () => {
		expect(ids(effectivePool(POOL, { ...NO_FILTER, excludedSources: ['Crafted'] }))).not.toContain(5);
		expect(ids(effectivePool(POOL, { ...NO_FILTER, excludedSources: ['Black Temple'] }))).toContain(5);
	});

	it('with prune, keeps only the selected sets’ items', () => {
		expect(ids(effectivePool(POOL, { ...NO_FILTER, selectedSetItemIds: [1, 4, 99], prune: true }))).toEqual([1, 4]);
	});

	it('never adds a set item back past the Sources filter', () => {
		expect(ids(effectivePool(POOL, { excludedSources: ['Badge vendor'], selectedSetItemIds: [1, 4], prune: true }))).toEqual([1]);
		expect(ids(effectivePool(POOL, { excludedSources: ['Badge vendor'], selectedSetItemIds: [1, 4], prune: false }))).not.toContain(4);
	});
});

describe('eligibleCount', () => {
	it('counts what the run would sim: the phase filter applied and the Kael legendaries left out', () => {
		expect(eligibleCount(POOL, 3, NO_WEAPON)).toBe(5);
		expect(eligibleCount(POOL, 4, NO_WEAPON)).toBe(6);
	});

	// Measured once under include-unticked by the independent script `pool_source.cells.fixture.json`'s _comment
	// describes, which no checkout holds; re-pin as that _comment says.
	it('matches the measured ret pool sizes (1175 at phase 4, 1441 at phase 5)', () => {
		expect(eligibleCount(effectivePool(dbPoolFor('ret', 4), NO_FILTER), 4, NO_WEAPON)).toBe(1175);
		expect(eligibleCount(effectivePool(dbPoolFor('ret', 5), NO_FILTER), 5, NO_WEAPON)).toBe(1441);
	});
});

describe('setOptions', () => {
	const options = setOptions({
		presets: [
			{ name: 'P2', phase: 2, gear: gear(1, 4, 0) },
			{ name: 'P3', phase: 3, gear: gear(1, 3, 77) },
			{ name: 'Bulwark', phase: 3, gear: gear(5) },
			{ name: 'Pre-raid', gear: gear(88) },
		],
		savedSets: [{ name: 'Mine', gear: gear(2, 3) }, { name: 'Empty' }],
		pool: POOL,
	});

	it('lists presets then saved sets, with keys, labels, item ids and the in-pool count', () => {
		expect(options).toEqual([
			{ key: 'preset:2:P2', name: 'P2', label: 'P2', phase: 2, kind: 'preset', itemIds: [1, 4], inPool: 2 },
			{ key: 'preset:3:P3', name: 'P3', label: 'P3', phase: 3, kind: 'preset', itemIds: [1, 3, 77], inPool: 2 },
			{ key: 'preset:3:Bulwark', name: 'Bulwark', label: 'P3 - Bulwark', phase: 3, kind: 'preset', itemIds: [5], inPool: 1 },
			{ key: 'preset::Pre-raid', name: 'Pre-raid', label: 'Pre-raid', phase: undefined, kind: 'preset', itemIds: [88], inPool: 0 },
			{ key: 'saved:Mine', name: 'Mine', label: 'Mine', kind: 'saved', itemIds: [2, 3], inPool: 2 },
			{ key: 'saved:Empty', name: 'Empty', label: 'Empty', kind: 'saved', itemIds: [], inPool: 0 },
		]);
	});

	it('defaults to the presets of the BiS-tag phase whose in-pool items are all BiS-tagged', () => {
		// P3's in-pool items 1 and 3 are BiS; Bulwark's 5 is only Alt; P2 is another phase.
		expect(defaultSetKeys(options, POOL, 3)).toEqual(['preset:3:P3']);
		expect(defaultSetKeys(options, POOL, undefined)).toEqual([]);
	});

	it('shows current-phase, phaseless and selected chips, and puts the rest behind the disclosure', () => {
		const { main, other } = splitSetChips(options, ['preset:2:P2'], 3);
		expect(main.map(o => o.key)).toEqual(['preset:2:P2', 'preset:3:P3', 'preset:3:Bulwark', 'preset::Pre-raid', 'saved:Mine', 'saved:Empty']);
		expect(other).toEqual([]);
		expect(splitSetChips(options, [], 3).other.map(o => o.key)).toEqual(['preset:2:P2']);
	});

	it('unions the selected sets’ item ids', () => {
		expect(selectedSetItemIds(options, ['preset:2:P2', 'preset:3:P3'])).toEqual([1, 4, 3, 77]);
	});
});

// Ticket 690: hunter's "DW - 6% hit" exists once per wowsims group in a phase.
describe('setOptions over presets that share a phase and a name', () => {
	const options = setOptions({
		presets: [
			{ name: 'DW - 6% hit', phase: 2, group: 'Beast Mastery', gear: gear(1) },
			{ name: 'DW - 6% hit', phase: 2, group: 'Survival', gear: gear(3) },
			{ name: 'DW - 6% hit', phase: 3, group: 'Beast Mastery', gear: gear(4) },
		],
		savedSets: [],
		pool: POOL,
	});

	it('keys each by its group and names the group only on the twins', () => {
		expect(options.map(o => [o.key, o.label])).toEqual([
			['preset:2:Beast Mastery/DW - 6% hit', 'P2 - DW - 6% hit (Beast Mastery)'],
			['preset:2:Survival/DW - 6% hit', 'P2 - DW - 6% hit (Survival)'],
			['preset:3:Beast Mastery/DW - 6% hit', 'P3 - DW - 6% hit'],
		]);
	});

	it('selects only the twin that was ticked', () => {
		const offer = settingsOffer({ pool: POOL, presets: [], savedSets: [], bisTagPhase: undefined });
		const selection = setSelection({ ...offer, options }, ['preset:2:Survival/DW - 6% hit'], 2);
		expect(selection.selectedOptions.map(o => o.itemIds)).toEqual([[3]]);
	});

	it('restores a saved pick of an ungrouped preset by its old key', () => {
		const offer = settingsOffer({ pool: POOL, presets: [{ name: 'P3', phase: 3, gear: gear(1, 3) }], savedSets: [], bisTagPhase: 3 });
		expect(setSelection(offer, ['preset:3:P3'], 3).selectedKeys).toEqual(['preset:3:P3']);
	});
});

describe('rowTags', () => {
	const option = (key: string, name: string, phase: number | undefined, itemIds: number[]): SetOption => ({
		key,
		name,
		label: name,
		phase,
		kind: phase === undefined ? 'saved' : 'preset',
		itemIds,
		inPool: itemIds.length,
	});

	it('names each selected set that holds the item', () => {
		const selected = [option('preset:3:P3', 'P3', 3, [1, 2]), option('saved:Mine', 'Mine', undefined, [2])];
		expect(rowTags(2, selected)).toEqual([
			{ key: 'preset:3:P3', label: 'P3' },
			{ key: 'saved:Mine', label: 'Mine' },
		]);
		expect(rowTags(1, selected)).toEqual([{ key: 'preset:3:P3', label: 'P3' }]);
		expect(rowTags(9, selected)).toEqual([]);
	});

	it('prefixes the phase when two selected sets share a name', () => {
		const selected = [option('preset:2:BiS 9%', 'BiS 9%', 2, [1]), option('preset:3:BiS 9%', 'BiS 9%', 3, [1])];
		expect(rowTags(1, selected).map(tag => tag.label)).toEqual(['P2 BiS 9%', 'P3 BiS 9%']);
	});

	it('adds the group when two selected sets also share the phase', () => {
		const selected = [
			{ ...option('preset:2:Beast Mastery/DW - 6% hit', 'DW - 6% hit', 2, [1]), group: 'Beast Mastery' },
			{ ...option('preset:2:Survival/DW - 6% hit', 'DW - 6% hit', 2, [1]), group: 'Survival' },
		];
		expect(rowTags(1, selected).map(tag => tag.label)).toEqual(['P2 DW - 6% hit (Beast Mastery)', 'P2 DW - 6% hit (Survival)']);
	});
});

describe('rowTagIndex', () => {
	const selected: SetOption[] = [
		{ key: 'preset:3:P3', name: 'P3', label: 'P3', phase: 3, kind: 'preset', itemIds: [1, 2], inPool: 2 },
		{ key: 'saved:Mine', name: 'Mine', label: 'Mine', kind: 'saved', itemIds: [2], inPool: 1 },
	];

	it('gives each item the tags rowTags gives it', () => {
		const tagsOf = rowTagIndex(selected);
		expect(tagsOf(2)).toEqual(rowTags(2, selected));
		expect(tagsOf(1)).toEqual(rowTags(1, selected));
		expect(tagsOf(9)).toEqual([]);
	});

	it('returns the same array for an item on every call, so a memoised cell is not rendered again', () => {
		const tagsOf = rowTagIndex(selected);
		expect(tagsOf(2)).toBe(tagsOf(2));
		expect(tagsOf(9)).toBe(tagsOf(8));
	});
});

describe('setSelection, runSettingsOf and eligibleCountOf', () => {
	const offer = settingsOffer({
		pool: POOL,
		presets: [
			{ name: 'P2', phase: 2, gear: gear(1, 4) },
			{ name: 'P3', phase: 3, gear: gear(1, 3) },
		],
		savedSets: [{ name: 'Mine', gear: gear(2) }],
		bisTagPhase: 3,
	});
	const fresh = initialSettings({ iterations: 500 });
	const viewOf = (state: typeof fresh) => {
		const selection = setSelection(offer, state.selectedSetKeys, 3);
		const runSettings = runSettingsOf(selection, state);
		const filter = { excludedSources: state.excludedSources, selectedSetItemIds: selection.selectedItemIds, prune: runSettings.prune ?? false };
		return { ...selection, runSettings, eligibleCount: eligibleCountOf(offer, filter, 3, NO_WEAPON) };
	};

	it('offers the pool’s sources and sets, and the BiS-tag phase’s preset as the default', () => {
		expect(offer.sourceKeys).toEqual(['Black Temple', 'Hyjal Summit', 'Tempest Keep', 'Badge vendor', 'Crafted']);
		expect(offer.options.map(o => o.key)).toEqual(['preset:2:P2', 'preset:3:P3', 'saved:Mine']);
		expect(offer.defaultKeys).toEqual(['preset:3:P3']);
	});

	it('runs the whole phase pool with nothing picked', () => {
		const view = viewOf(fresh);
		expect(view.runSettings).toEqual({
			iterations: 500,
			candidateCap: undefined,
			excludedSources: [],
			guaranteedSetKeys: [],
			guaranteedSetItemIds: [],
			prune: false,
		});
		expect(view.eligibleCount).toBe(5);
		expect(view.chips.other.map(o => o.key)).toEqual(['preset:2:P2']);
	});

	it('narrows the count when a source is excluded and, with prune, to the selected sets’ items', () => {
		const excluded = withSourceToggled(fresh, 'Badge vendor');
		expect(viewOf(excluded).eligibleCount).toBe(4);

		const pruned = withPrune(withSetToggled(fresh, 'preset:3:P3'), true);
		const view = viewOf(pruned);
		expect(view.selectedOptions.map(o => o.key)).toEqual(['preset:3:P3']);
		expect(view.runSettings).toMatchObject({ guaranteedSetKeys: ['preset:3:P3'], guaranteedSetItemIds: [1, 3], prune: true });
		expect(view.eligibleCount).toBe(2);
	});

	it('drops a picked set the offer no longer has, such as a deleted saved set', () => {
		const picked = withSetToggled(fresh, 'saved:Gone');
		expect(viewOf(picked).runSettings.guaranteedSetKeys).toEqual([]);
	});
});

describe('sources that start unticked (Q-heroic, include-unticked)', () => {
	const HEROIC = 'Heroic dungeon';

	it('is the "Heroic dungeon" bucket under the include-unticked policy', () => {
		expect(DEFAULT_OFF_SOURCE_KEYS).toEqual([HEROIC]);
	});

	it('excludes a default-off key the pool offers until the user ticks it, and leaves other keys to the stored toggles', () => {
		const offered = ['Black Temple', HEROIC];
		expect(effectiveExcludedSources([], offered)).toEqual([HEROIC]);
		expect(effectiveExcludedSources(['Black Temple'], offered)).toEqual(['Black Temple', HEROIC]);
		// A stored default-off key is the user's tick.
		expect(effectiveExcludedSources([HEROIC], offered)).toEqual([]);
		expect(effectiveExcludedSources([], ['Black Temple'])).toEqual([]);
	});

	it('keeps a tick through a phase change whose pool still offers the key, and starts the key unticked after a phase without it', () => {
		const ticked = withSourceToggled(initialSettings({ iterations: 500 }), HEROIC);
		const kept = afterScopeChange(ticked, ['Zul’Aman', HEROIC]);
		expect(effectiveExcludedSources(kept.excludedSources, ['Zul’Aman', HEROIC])).toEqual([]);
		const gone = afterScopeChange(ticked, ['Zul’Aman']);
		expect(effectiveExcludedSources(gone.excludedSources, ['Zul’Aman', HEROIC])).toEqual([HEROIC]);
	});
});
