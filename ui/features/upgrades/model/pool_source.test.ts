import { UIItem } from '@generated/proto/ui';
import { describe, expect, it } from 'vitest';

import { dbPoolFor, PROTO_SPEC, TEST_DB, TEST_MISSING_IDS, TEST_PRESETS, testItem, testItemPhase } from '../testing/db_pool';
import type { SpecId } from './engine/types';
import { bisSetsFor, hasEffectRecord, type HeroicFiveManPolicy, isHeroicFiveManOnly, presetPhase, type PresetSet, selectPool, twinIdsOf } from './pool_source';
import cellsFixture from './pool_source.cells.fixture.json';
import { effectiveExcludedSources, effectivePool, validSourceKeysOf } from './settings_pool';

// JSON values only: the fixture's shape is asserted here, never derived from the import (AGENTS.md, Types from JSON).
const CELLS = (cellsFixture as { cells: Record<string, { exclude: number; include: number; bisRows: number }> }).cells;
const poolOf = (spec: SpecId, phase: number, policy: HeroicFiveManPolicy) => dbPoolFor(spec, phase, policy);

const CELL_NAMES = Object.keys(CELLS);

describe('selectPool over the fork db.json and the wowsims presets', () => {
	it('covers 11 specs at phases 1-5', () => {
		expect(CELL_NAMES).toHaveLength(55);
		expect(Object.keys(TEST_PRESETS).sort()).toEqual(Object.keys(PROTO_SPEC).sort());
	});

	it.each(CELL_NAMES)('%s has the measured pool sizes and BiS rows', name => {
		const [spec, phase] = name.split('-p') as [SpecId, string];
		const expected = CELLS[name]!;
		const excluded = poolOf(spec, Number(phase), 'exclude');
		const included = poolOf(spec, Number(phase), 'include');
		expect({
			exclude: excluded.length,
			include: included.length,
			bisRows: included.filter(e => e.bisTags?.includes('BiS')).length,
		}).toEqual(expected);
	});

	// 41,318 / 43,758 before ticket 753 took one Sergeant's cape and one cloak out of each of the 55 cells.
	it('totals the measured 41,208 / 43,648 rows and 1,182 BiS rows', () => {
		const sum = (key: 'exclude' | 'include' | 'bisRows') => CELL_NAMES.reduce((n, name) => n + CELLS[name]![key], 0);
		expect([sum('exclude'), sum('include'), sum('bisRows')]).toEqual([41208, 43648, 1182]);
	});

	it.each(['ret-p5', 'feral-p5'])('%s: exclude is inside include, include-unticked is include, and the difference is the heroic-only items', name => {
		const [spec, phase] = name.split('-p') as [SpecId, string];
		const ids = (policy: HeroicFiveManPolicy) => new Set(poolOf(spec, Number(phase), policy).map(e => e.itemId));
		const exclude = ids('exclude');
		const include = ids('include');
		expect([...exclude].filter(id => !include.has(id))).toEqual([]);
		expect(ids('include-unticked')).toEqual(include);
		const heroicOnly = [...include].filter(id => isHeroicFiveManOnly(testItem(id)!));
		expect(heroicOnly.sort()).toEqual([...include].filter(id => !exclude.has(id)).sort());
		expect(heroicOnly.length).toBeGreaterThan(0);
	});

	// What a default run ranks under `include-unticked`: the Sources dialog starts "Heroic dungeon" unticked, and the
	// pool's sources (`utils/item_sources.ts`) must then leave exactly the `exclude` pool.
	it.each(CELL_NAMES)('%s: the default source ticks rank exactly the exclude pool', name => {
		const [spec, phase] = name.split('-p') as [SpecId, string];
		const pool = poolOf(spec, Number(phase), 'include-unticked');
		const excluded = effectiveExcludedSources([], validSourceKeysOf(pool));
		const ranked = effectivePool(pool, { excludedSources: excluded, selectedSetItemIds: [], prune: false }).map(e => e.itemId);
		const exclude = poolOf(spec, Number(phase), 'exclude').map(e => e.itemId);
		expect(ranked.sort()).toEqual(exclude.sort());
	});

	it('keeps Magisters’ Terrace heroic epics such as 34472 Shard of Contempt under exclude', () => {
		expect(poolOf('feral', 5, 'exclude').some(e => e.itemId === 34472)).toBe(true);
	});

	it('drops 19019 Thunderfury: below item level 100 and no effect record in db.json', () => {
		expect(hasEffectRecord(testItem(19019)!, TEST_MISSING_IDS)).toBe(false);
		expect(poolOf('ret', 5, 'include').some(e => e.itemId === 19019)).toBe(false);
	});

	it('keeps both Mark of the Champion items on their effect record', () => {
		const ids = new Set(poolOf('ret', 5, 'include').map(e => e.itemId));
		expect([ids.has(23206), ids.has(23207)]).toEqual([true, true]);
	});

	// Ticket 753: db.json gives 28378/28379 and 28377/28380 the same record but the id, so the tab showed each item
	// twice. The two Marks differ in effect (attack power or spell damage), so both stay.
	it('offers each Sergeant’s cape and cloak once and keeps both Mark of the Champion items', () => {
		const pool = poolOf('ret', 5, 'include');
		const count = (name: string) => pool.filter(e => e.name === name).length;
		expect([count("Sergeant's Heavy Cape"), count("Sergeant's Heavy Cloak"), count('Mark of the Champion')]).toEqual([1, 1, 2]);
	});

	it.each(CELL_NAMES)('%s offers no two items db.json describes the same but the id', name => {
		const [spec, phase] = name.split('-p') as [SpecId, string];
		const items = poolOf(spec, Number(phase), 'include').map(e => testItem(e.itemId)!);
		// Equal records share a name, so only same-name pairs need the full comparison.
		const twins = items.flatMap((a, i) =>
			items
				.slice(i + 1)
				.filter(b => b.name === a.name && UIItem.equals(a, { ...b, id: a.id }))
				.map(b => [a.id, b.id]),
		);
		expect(twins).toEqual([]);
	});

	it('maps each id db.json describes the same as another but the id to every id of the group, and leaves the Marks apart', () => {
		const twins = twinIdsOf(TEST_DB.items);
		expect([28377, 28380, 28378, 28379, 23206, 23207].map(id => twins.get(id))).toEqual([
			[28377, 28380],
			[28377, 28380],
			[28378, 28379],
			[28378, 28379],
			undefined,
			undefined,
		]);
	});

	describe('keeps the id the player wears, else one a preset holds, with the group’s tags', () => {
		const capes = [testItem(28378)!, testItem(28379)!];
		const cloaks = [testItem(28377)!, testItem(28380)!];
		const presets: PresetSet[] = [{ name: 'P1', phase: 1, itemIds: [28380] }];
		const kept = (items: UIItem[], wornIds: number[], sets: PresetSet[] = []) =>
			selectPool(items, () => true, sets, TEST_MISSING_IDS, 5, 'include', undefined, new Set(wornIds)).map(e => ({
				itemId: e.itemId,
				bisSets: e.bisSets,
				curatedSets: e.curatedSets,
			}));

		it('a worn 28379 over the lower 28378', () => {
			expect(kept(capes, [28379])).toEqual([{ itemId: 28379 }]);
		});

		it('with nothing worn, the preset’s 28380 over the lower 28377', () => {
			expect(kept(cloaks, [], presets)).toEqual([{ itemId: 28380, bisSets: ['P1'], curatedSets: ['P1'] }]);
		});

		it('a worn 28380 over the preset’s 28377, keeping the preset’s tags', () => {
			const lowInPreset: PresetSet[] = [{ name: 'P1', phase: 1, itemIds: [28377] }];
			expect(kept(cloaks, [28380], lowInPreset)).toEqual([{ itemId: 28380, bisSets: ['P1'], curatedSets: ['P1'] }]);
		});
	});
});

describe('presetPhase', () => {
	it('takes the declared phase, else the newest item phase, else none', () => {
		expect(presetPhase({ phase: 2, itemIds: [34472] }, testItemPhase)).toBe(2);
		expect(presetPhase({ itemIds: [28963, 34472] }, testItemPhase)).toBe(Math.max(testItemPhase(28963)!, testItemPhase(34472)!));
		expect(presetPhase({ itemIds: [] }, testItemPhase)).toBeUndefined();
	});

	it('reads warlock’s tier-named sets as phases 1-5', () => {
		const phases = Object.fromEntries(TEST_PRESETS.warlock!.map(p => [p.name, presetPhase(p, testItemPhase)]));
		expect(phases).toMatchObject({ T4: 1, T5: 2, T6: 3, "Zul'Aman": 4, 'Sunwell Plateau': 5 });
	});
});

describe('bisSetsFor', () => {
	it('takes every set of the newest preset phase at or below the phase, whatever its name', () => {
		const sets: PresetSet[] = [
			{ name: 'Pre-Raid', phase: 1, itemIds: [1] },
			{ name: 'P2', phase: 2, itemIds: [2] },
			{ name: 'P3', phase: 3, itemIds: [3] },
			{ name: 'P3 - Bulwark', phase: 3, itemIds: [4] },
			{ name: 'P3 Alt', phase: 3, itemIds: [5] },
			{ name: 'P4', phase: 4, itemIds: [6] },
		];
		expect(bisSetsFor(sets, 3, () => undefined)).toEqual({ phase: 3, sets: [sets[2], sets[3], sets[4]] });
		expect(bisSetsFor(sets, 1, () => undefined)).toEqual({ phase: 1, sets: [sets[0]] });
		expect(bisSetsFor(sets.slice(1), 1, () => undefined)).toBeUndefined();
	});

	// The items each cell gained when the name rule went (ticket 686); the cells fixture's _comment lists them too.
	it.each([
		['ret', 3, [28485]],
		['feral', 2, [30222, 30223, 30229, 30230, 30834]],
		['shadow', 2, [25295, 28245, 28555, 30832, 31166, 31199, 31201, 31225]],
	] as const)('%s p%i tags the items of its pre-raid and alternative sets', (spec, phase, ids) => {
		const tagged = new Set(
			poolOf(spec, phase, 'include')
				.filter(e => e.bisTags?.includes('BiS'))
				.map(e => e.itemId),
		);
		expect(ids.filter(id => !tagged.has(id))).toEqual([]);
	});

	it('tags ret p3 from its P3 and Bulwark presets', () => {
		const pool = poolOf('ret', 3, 'include');
		const tagged = pool.filter(e => e.bisTags?.includes('BiS'));
		expect(new Set(tagged.flatMap(e => e.bisSets ?? []))).toEqual(new Set(['P3', 'Bulwark']));
	});
});
