import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { UIDatabase } from '@generated/proto/ui';
import { describe, expect, it, vi } from 'vitest';

import { epWeightsFor } from './data/data';
import type { PoolEntry } from './engine/pool';
import { rankUpgrades } from './engine/rank';
import { characterFightKey, fightGearKey, type FightSummary, type LoggedGear, RecordedGearSource } from './engine/seams/gear-source';
import type { RaidSimRequest, SimObservation, SimRunner } from './engine/seams/sim-runner';
import { MemoryStore } from './engine/seams/store';
import { SIM_ORDER } from './engine/slots';

/**
 * The candidate cap at the fork's own `rankUpgrades`: a worn item the EP order
 * puts inside the first N takes no cap place, so a cap of N still sims N items
 * the player does not wear. The page's database is the fork's real
 * `assets/database/db.json`; the sim is a synthetic one.
 */

vi.mock('@sim/proto/database', async importOriginal => {
	const actual = await importOriginal<typeof import('@sim/proto/database')>();
	const { UIDatabase } = await import('@generated/proto/ui');
	const dbPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../assets/database/db.json');
	const proto = UIDatabase.fromJson(JSON.parse(readFileSync(dbPath, 'utf8')), { ignoreUnknownFields: true });
	const db = new (actual.Database as unknown as new (proto: UIDatabase) => unknown)(proto);
	return { ...actual, Database: { getSync: () => db } };
});

const FORK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
/** Wowsims' mage P3 sword set: neck 30015, trinket1 30720, trinket2 29370. */
const GEAR = JSON.parse(readFileSync(path.join(FORK_ROOT, 'ui/specs/mage/dps/gear_sets/p3ArcaneSword.gear.json'), 'utf8')) as {
	items: Array<{ id?: number; enchant?: number; gems?: number[] }>;
};

const ref = { region: 'US' as const, realm: 'synthetic', name: 'syn-mage' };
const summary: FightSummary = { reportCode: 'synthetic-mage', fightId: 1, encounterName: 'Synthetic mage', route: 'ranked', confidence: 1 };
const logged: LoggedGear = {
	items: GEAR.items.map((item, i) => ({
		id: item.id ?? 0,
		slot: SIM_ORDER[i]!,
		gems: item.gems ?? [],
		...(item.enchant ? { enchant: item.enchant } : {}),
	})),
	talentPointsByTree: [51, 0, 0],
	provenance: { reportCode: summary.reportCode, fightId: summary.fightId, sourceID: -1 },
};

const skeleton = {
	raid: {
		parties: [{ players: [{ name: 'synthetic', class: 'ClassMage', talentsString: '0-0-0', equipment: { items: GEAR.items.map(i => ({ ...i })) } }] }],
	},
	encounter: { duration: 180, targets: [{ level: 73 }] },
} as unknown as RaidSimRequest;

const sim: SimRunner = {
	version: async () => 'synthetic-1',
	run: async (): Promise<SimObservation> => ({
		dps: 1000,
		stdev: 1.5,
		iterationsDone: 3000,
		simVersion: 'synthetic-1',
		spellDamageBySchool: { 64: 1 },
	}),
	computeStats: async () => ({ stats: [], pseudoStats: new Array<number>(25).fill(0) }),
};

describe('SimRunner', () => {
	it('must read stats, so a hit-budget spec never repairs at full weight unannounced (ticket 830)', () => {
		// @ts-expect-error computeStats is required; the fork's tsc fails here if it turns optional again.
		const noStatsReader: SimRunner = { version: sim.version, run: sim.run };
		expect(noStatsReader.computeStats).toBeUndefined();
	});
});

const entry = (itemId: number, slot: 'neck' | 'trinket'): PoolEntry => ({
	itemId,
	name: `item ${itemId}`,
	slot,
	phase: 3,
	source: { kind: 'raid', zone: 'Black Temple' },
});

const WORN_TRINKET = 29370;
// Scores that put the worn trinket first: in the trinket1 slot it beats the worn 30720 (score 0).
const SCORES: Record<number, number> = { [WORN_TRINKET]: 50, 32349: 40, 32589: 30, 28762: 20 };

describe('rankUpgrades: candidate cap', () => {
	it('gives a worn item inside the first N no cap place', async () => {
		const ranking = await rankUpgrades(
			{ spec: 'mage', character: ref, maxPhase: 3, candidateCap: 2 },
			{
				gear: new RecordedGearSource({
					fights: new Map([[characterFightKey(ref, 'mage'), [summary]]]),
					gear: new Map([[fightGearKey(summary), logged]]),
				}),
				sim,
				store: new MemoryStore(),
				clock: () => new Date('2026-11-07T00:00:00Z'),
				raidSimSkeleton: skeleton,
				epWeights: epWeightsFor('mage'),
				itemEp: itemId => SCORES[itemId] ?? 0,
				pool: [entry(WORN_TRINKET, 'trinket'), entry(32349, 'neck'), entry(32589, 'neck'), entry(28762, 'neck')],
				concurrency: 1,
			},
		);

		expect(ranking.items.map(i => i.itemId).sort((a, b) => a - b)).toEqual([WORN_TRINKET, 32349, 32589].sort((a, b) => a - b));
	});
});
