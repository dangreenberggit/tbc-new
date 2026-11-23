import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import type { PoolEntry } from './pool';
import { withCandidateSuffixes } from './random-suffix';
import { SIM_ORDER, type SimItemSpec } from './slots';

// The real item and suffix rows from db.json, through the page's own Database class.
vi.mock('@sim/proto/database', async importOriginal => {
	const actual = await importOriginal<typeof import('@sim/proto/database')>();
	const { UIDatabase } = await import('@generated/proto/ui');
	const dbPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../assets/database/db.json');
	const proto = UIDatabase.fromJson(JSON.parse(readFileSync(dbPath, 'utf8')), { ignoreUnknownFields: true });
	const db = new (actual.Database as unknown as new (proto: unknown) => unknown)(proto);
	return { ...actual, Database: { getSync: () => db } };
});

const RAVAGERS_BRACERS = 30687;
const LURKERS_CORD = 30675; // cloth: every option is a caster suffix
const OF_STRENGTH = -17;
const OF_THE_BEAST = -41;
const STRENGTH_ONLY = { '0': 1 };

const entry = (itemId: number, name: string, slot: PoolEntry['slot']): PoolEntry => ({ itemId, name, slot, phase: 1, source: { kind: 'unknown' } });
const wearing = (worn: SimItemSpec | undefined): SimItemSpec[] => SIM_ORDER.map(slot => (slot === 'wrist' && worn ? worn : { gems: [] }));

describe('withCandidateSuffixes', () => {
	it('gives a suffix item its highest-EP option and names the row with it', () => {
		const [out] = withCandidateSuffixes([entry(RAVAGERS_BRACERS, "Ravager's Bracers", 'wrist')], wearing(undefined), STRENGTH_ONLY);
		// Strength only: "of Strength" carries the most (10000 per 10000 points, against 6666 for "of the Tiger").
		expect(out).toMatchObject({ randomSuffix: OF_STRENGTH, name: "Ravager's Bracers of Strength" });
	});

	it('leaves an item bare when no option is worth anything to the spec, as the gear picker offers it none', () => {
		const cord = entry(LURKERS_CORD, "Lurker's Cord", 'waist');
		const [out] = withCandidateSuffixes([cord], wearing(undefined), STRENGTH_ONLY);
		expect(out).toBe(cord);
	});

	it('keeps the suffix the player wears on that item, even when another option scores higher', () => {
		const worn = { id: RAVAGERS_BRACERS, randomSuffix: OF_THE_BEAST, gems: [] };
		const [out] = withCandidateSuffixes([entry(RAVAGERS_BRACERS, "Ravager's Bracers", 'wrist')], wearing(worn), STRENGTH_ONLY);
		expect(out).toMatchObject({ randomSuffix: OF_THE_BEAST, name: "Ravager's Bracers of the Beast" });
	});

	it('leaves a worn copy with no suffix bare, so its row is the gear the player wears', () => {
		const bracers = entry(RAVAGERS_BRACERS, "Ravager's Bracers", 'wrist');
		const [out] = withCandidateSuffixes([bracers], wearing({ id: RAVAGERS_BRACERS, gems: [] }), STRENGTH_ONLY);
		expect(out).toBe(bracers);
	});
});
