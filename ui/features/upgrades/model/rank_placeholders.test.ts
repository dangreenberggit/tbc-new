import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { UIDatabase } from '@generated/proto/ui';
import { describe, expect, it, vi } from 'vitest';

import { epWeightsFor } from './data/data';
import type { PoolEntry } from './engine/pool';
import { simSlotsForPoolSlot } from './engine/pool';
import { rankUpgrades } from './engine/rank';
import { characterFightKey, fightGearKey, type FightSummary, type LoggedGear, RecordedGearSource } from './engine/seams/gear-source';
import type { RaidSimRequest, SimObservation, SimRunner } from './engine/seams/sim-runner';
import { MemoryStore } from './engine/seams/store';
import { SIM_ORDER } from './engine/slots';

/**
 * Ticket 701 at the fork's own `rankUpgrades`: a Stop placeholder for a ring or
 * trinket worn in its second slot names that slot, as its simmed row would.
 * The page's database is the fork's real `assets/database/db.json`; the sim is
 * a synthetic one, and nothing here asserts on a DPS number.
 */

// The engine reads items and gems through `Database.getSync()`; the real class over the test database stands in for the page's.
vi.mock('@sim/proto/database', async importOriginal => {
	const actual = await importOriginal<typeof import('@sim/proto/database')>();
	// Read here, not through `testing/db_pool`: that module imports this one, and the mock would wait on itself.
	const { UIDatabase } = await import('@generated/proto/ui');
	const dbPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../assets/database/db.json');
	const proto = UIDatabase.fromJson(JSON.parse(readFileSync(dbPath, 'utf8')), { ignoreUnknownFields: true });
	const db = new (actual.Database as unknown as new (proto: UIDatabase) => unknown)(proto);
	return { ...actual, Database: { getSync: () => db } };
});

const FORK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
/** Wowsims' mage P3 sword set: finger1 29305, finger2 32527, trinket1 30720, trinket2 29370. */
const GEAR = JSON.parse(readFileSync(path.join(FORK_ROOT, 'ui/specs/mage/dps/gear_sets/p3ArcaneSword.gear.json'), 'utf8')) as {
	items: Array<{ id?: number; enchant?: number; gems?: number[] }>;
};
const WORN = { 29305: 'finger1', 32527: 'finger2', 30720: 'trinket1', 29370: 'trinket2' } as const;

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

/** A DPS from the equipped ids, so swaps differ; calls `onRun` with the call count. */
class SyntheticSimRunner implements SimRunner {
	calls = 0;
	constructor(private readonly onRun: (calls: number) => void) {}
	async version(): Promise<string> {
		return 'synthetic-1';
	}
	async run(req: RaidSimRequest): Promise<SimObservation> {
		this.calls++;
		this.onRun(this.calls);
		const items =
			(req as { raid?: { parties?: Array<{ players?: Array<{ equipment?: { items?: Array<{ id?: number }> } }> }> } }).raid?.parties?.[0]?.players?.[0]
				?.equipment?.items ?? [];
		const acc = items.reduce((sum, item, i) => sum + ((item?.id ?? 0) % 977) * (i + 1), 0);
		return { dps: 1000 + (acc % 5000) / 10, stdev: 1.5, iterationsDone: 3000, simVersion: 'synthetic-1' };
	}
}

const entry = (itemId: number, slot: 'finger' | 'trinket'): PoolEntry => ({
	itemId,
	name: `item ${itemId}`,
	slot,
	phase: 3,
	source: { kind: 'raid', zone: 'Black Temple' },
});

describe('rankUpgrades: Stop placeholders for rings and trinkets', () => {
	it('name the slot the item is worn in, as its simmed row would', async () => {
		const controller = new AbortController();
		const ranking = await rankUpgrades(
			{ spec: 'mage', character: ref, maxPhase: 3 },
			{
				gear: new RecordedGearSource({
					fights: new Map([[characterFightKey(ref, 'mage'), [summary]]]),
					gear: new Map([[fightGearKey(summary), logged]]),
				}),
				// Run 1 is the baseline; stopping on run 2 leaves every candidate but the first unsimmed.
				sim: new SyntheticSimRunner(calls => {
					if (calls === 2) controller.abort();
				}),
				store: new MemoryStore(),
				clock: () => new Date('2026-10-20T00:00:00Z'),
				raidSimSkeleton: skeleton,
				epWeights: epWeightsFor('mage'),
				pool: [
					entry(29305, 'finger'),
					entry(32527, 'finger'),
					entry(30720, 'trinket'),
					entry(29370, 'trinket'),
					{ ...entry(32349, 'finger'), slot: 'neck' },
				],
				concurrency: 1,
				signal: controller.signal,
			},
		);

		expect(ranking.complete).toBe(false);
		const rows = Object.keys(WORN).map(id => ranking.items.find(i => i.itemId === Number(id))!);
		expect(rows.map(row => row.simmed)).toEqual([false, false, false, false]);
		// The slot each row names, read as the tab reads it (`effectiveSlot`, `slotLabel`).
		const named = Object.fromEntries(rows.map(row => [row.itemId, row.slotChoice ?? simSlotsForPoolSlot(row.slot)[0]]));
		expect(named).toEqual(WORN);
	});
});
