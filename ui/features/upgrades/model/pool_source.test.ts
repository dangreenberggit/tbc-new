import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Spec } from '@generated/proto/common';
import { UIDatabase, type UIItem } from '@generated/proto/ui';
import { MISSING_ITEM_EFFECTS } from '@sim/constants/missing_effects_auto_gen';
import { PlayerSpecs } from '@sim/player/specs';
import { canEquipItem } from '@sim/proto/items';
import { describe, expect, it } from 'vitest';

import type { SpecId } from './engine/types';
import cellsFixture from './pool_source.cells.fixture.json';
import presetsFixture from './pool_source.presets.fixture.json';
import { bisSetsFor, type HeroicFiveManPolicy, hasEffectRecord, isHeroicFiveManOnly, type PresetSet, presetPhase, selectPool } from './pool_source';

const FORK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const db = UIDatabase.fromJson(JSON.parse(readFileSync(path.join(FORK_ROOT, 'assets/database/db.json'), 'utf8')), { ignoreUnknownFields: true });
const byId = new Map(db.items.map(item => [item.id, item]));
const itemPhaseOf = (id: number) => byId.get(id)?.phase;
const missingIds = new Set(MISSING_ITEM_EFFECTS.keys());

const PROTO_SPEC: Record<SpecId, Spec> = {
	balance: Spec.SpecBalanceDruid,
	feral: Spec.SpecFeralCatDruid,
	hunter: Spec.SpecHunter,
	mage: Spec.SpecMage,
	ret: Spec.SpecRetributionPaladin,
	shadow: Spec.SpecDpsPriest,
	rogue: Spec.SpecRogue,
	ele: Spec.SpecElementalShaman,
	enh: Spec.SpecEnhancementShaman,
	warlock: Spec.SpecWarlock,
	warrior: Spec.SpecDpsWarrior,
};

// JSON values only: the fixture's shape is asserted here, never derived from the import (AGENTS.md, Types from JSON).
const PRESETS = (presetsFixture as { specs: Record<string, PresetSet[]> }).specs;
const CELLS = (cellsFixture as { cells: Record<string, { exclude: number; include: number; bisRows: number }> }).cells;

const canEquipFor = (spec: SpecId) => {
	const playerSpec = PlayerSpecs.fromProto(PROTO_SPEC[spec]);
	return (item: UIItem) => canEquipItem(item, playerSpec, undefined);
};

const poolOf = (spec: SpecId, phase: number, policy: HeroicFiveManPolicy) =>
	selectPool(db.items, canEquipFor(spec), PRESETS[spec]!, missingIds, phase, policy);

const CELL_NAMES = Object.keys(CELLS);

describe('selectPool over the fork db.json and the wowsims presets', () => {
	it('covers 11 specs at phases 2-5', () => {
		expect(CELL_NAMES).toHaveLength(44);
		expect(Object.keys(PRESETS).sort()).toEqual(Object.keys(PROTO_SPEC).sort());
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
		const heroicOnly = [...include].filter(id => isHeroicFiveManOnly(byId.get(id)!));
		expect(heroicOnly.sort()).toEqual([...include].filter(id => !exclude.has(id)).sort());
		expect(heroicOnly.length).toBeGreaterThan(0);
	});

	it('keeps Magisters’ Terrace heroic epics such as 34472 Shard of Contempt under exclude', () => {
		expect(poolOf('feral', 5, 'exclude').some(e => e.itemId === 34472)).toBe(true);
	});

	it('drops 19019 Thunderfury: below item level 100 and no effect record in db.json', () => {
		expect(hasEffectRecord(byId.get(19019)!, missingIds)).toBe(false);
		expect(poolOf('ret', 5, 'include').some(e => e.itemId === 19019)).toBe(false);
	});

	it('keeps both Mark of the Champion items on their effect record', () => {
		const ids = new Set(poolOf('ret', 5, 'include').map(e => e.itemId));
		expect([ids.has(23206), ids.has(23207)]).toEqual([true, true]);
	});
});

describe('presetPhase', () => {
	it('takes the declared phase, else the newest item phase, else none', () => {
		expect(presetPhase({ phase: 2, itemIds: [34472] }, itemPhaseOf)).toBe(2);
		expect(presetPhase({ itemIds: [28963, 34472] }, itemPhaseOf)).toBe(Math.max(itemPhaseOf(28963)!, itemPhaseOf(34472)!));
		expect(presetPhase({ itemIds: [] }, itemPhaseOf)).toBeUndefined();
	});

	it('reads warlock’s tier-named sets as phases 1-5', () => {
		const phases = Object.fromEntries(PRESETS.warlock!.map(p => [p.name, presetPhase(p, itemPhaseOf)]));
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
		expect(new Set(tagged.flatMap(e => e.bisSets ?? []))).toEqual(new Set(bisSetsFor(PRESETS.ret!, 3, itemPhaseOf)!.sets.map(s => s.name)));
		expect(tagged.some(e => e.itemId === 28485)).toBe(false);
	});
});
