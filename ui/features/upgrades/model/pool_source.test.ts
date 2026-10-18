import { describe, expect, it } from 'vitest';

import { dbPoolFor, PROTO_SPEC, TEST_MISSING_IDS, TEST_PRESETS, testItem, testItemPhase } from '../testing/db_pool';
import type { SpecId } from './engine/types';
import { bisSetsFor, hasEffectRecord, type HeroicFiveManPolicy, isHeroicFiveManOnly, presetPhase, type PresetSet } from './pool_source';
import cellsFixture from './pool_source.cells.fixture.json';

// JSON values only: the fixture's shape is asserted here, never derived from the import (AGENTS.md, Types from JSON).
const CELLS = (cellsFixture as { cells: Record<string, { exclude: number; include: number; bisRows: number }> }).cells;
const poolOf = (spec: SpecId, phase: number, policy: HeroicFiveManPolicy) => dbPoolFor(spec, phase, policy);

const CELL_NAMES = Object.keys(CELLS);

describe('selectPool over the fork db.json and the wowsims presets', () => {
	it('covers 11 specs at phases 2-5', () => {
		expect(CELL_NAMES).toHaveLength(44);
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

	it('totals the measured 36,945 / 38,897 rows and 842 BiS rows', () => {
		const sum = (key: 'exclude' | 'include' | 'bisRows') => CELL_NAMES.reduce((n, name) => n + CELLS[name]![key], 0);
		expect([sum('exclude'), sum('include'), sum('bisRows')]).toEqual([36945, 38897, 842]);
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
	it('takes the newest named sets at or below the phase and skips pre-raid, alt, realistic and Bulwark sets', () => {
		const sets: PresetSet[] = [
			{ name: 'Pre-Raid', phase: 1, itemIds: [1] },
			{ name: 'P2', phase: 2, itemIds: [2] },
			{ name: 'P3', phase: 3, itemIds: [3] },
			{ name: 'P3 - Bulwark', phase: 3, itemIds: [4] },
			{ name: 'P3 Alt', phase: 3, itemIds: [5] },
			{ name: 'P4', phase: 4, itemIds: [6] },
		];
		expect(bisSetsFor(sets, 3, () => undefined)).toEqual({ phase: 3, sets: [sets[2]] });
		expect(bisSetsFor(sets, 1, () => undefined)).toBeUndefined();
	});

	it('tags ret p3 from its P3 preset and gives no badge to the Bulwark shield 28485', () => {
		const pool = poolOf('ret', 3, 'include');
		const tagged = pool.filter(e => e.bisTags?.includes('BiS'));
		expect(new Set(tagged.flatMap(e => e.bisSets ?? []))).toEqual(new Set(bisSetsFor(TEST_PRESETS.ret!, 3, testItemPhase)!.sets.map(s => s.name)));
		expect(tagged.some(e => e.itemId === 28485)).toBe(false);
	});
});
