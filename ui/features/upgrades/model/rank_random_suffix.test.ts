/**
 * A worn item's random suffix ("of the Beast" and the like) reaches the tab's
 * sim requests, on the real adapters.
 *
 * The page sends `ItemSpec.random_suffix` (`proto/common.proto`) with each worn
 * item that has one, and its database carries that suffix's
 * `randomSuffixes` row (`Gear.toDatabase`, `ui/sim/proto/gear.ts`). Without
 * both, the sim gives the item only its base stats (armor, for the Karazhan
 * trash epics), so the baseline and every row's change would be wrong for a
 * player wearing one.
 *
 * The seams are the page gear adapter (`PlayerGearSource`) and the module
 * interface `rankUpgrades` with the real per-request database resolver. Real
 * ids from db.json are used as values: Ravager's Bracers (30687) "of the
 * Beast" (-41: strength, agility, stamina).
 */

import { ItemSpec } from '@generated/proto/common';
import type { Player } from '@sim/player/player';
import { Database } from '@sim/proto/database';
import { ItemSwapGear } from '@sim/proto/gear';
import type { IndividualSimHost } from '@sim/sim_host';
import { describe, expect, it, vi } from 'vitest';

import { statsOnlyItemEp, zeroHitStats } from '../testing/engine_fakes';
import { characterFightKey, fightGearKey, RecordedGearSource } from '../testing/recorded_gear_source';
import retSkeleton from '../testing/ret_p2.skeleton.json';
import { CURRENT_PAGE_FIGHT, PlayerGearSource } from './adapters/player_gear_source';
import { simDatabaseResolverFor } from './adapters/sim_database';
import { epWeightsFor } from './data/data';
import { type PartialRanking, type Ranking, rankUpgrades } from './engine/rank';
import type { RaidSimRequest, SimRunner } from './engine/seams/sim-runner';
import { MemoryStore } from './engine/seams/store';
import { SIM_ORDER } from './engine/slots';

// The engine reads items and gems through `Database.getSync()`; the real class over the test database stands in for the page's.
vi.mock('@sim/proto/database', importOriginal => import('../testing/database_mock').then(m => m.withTestDatabase(importOriginal)));

const RAVAGERS_BRACERS = 30687;
const OF_THE_BEAST = -41;
// The bracers' best suffix for ret's P2 weights: strength and crit outweigh
// "of the Beast"'s strength, agility and stamina (computed by hand from
// db.json and `data/ret-p2.ep-weights.json`: 11665.5 against 9203.25,
// before the item's random property points scale both alike).
const OF_THE_TIGER = -14;
const WRIST = SIM_ORDER.indexOf('wrist');
const SIM_VERSION = 'v0.0.101';

type Json = Record<string, unknown>;
type ItemSpecJson = {
	id?: number;
	randomSuffix?: number;
	enchant?: number;
	gems?: number[];
};
type DbJson = { randomSuffixes?: Array<{ id?: number }> };

const playerOf = (request: Json | RaidSimRequest): Json => (request.raid as { parties: [{ players: [Json] }] }).parties[0].players[0];

const equipmentOf = (request: RaidSimRequest): ItemSpecJson[] =>
	((playerOf(request).equipment as { items?: ItemSpecJson[] }).items ?? []).map(item => ({ ...item }));

const stubPlayer = () => ({ itemSwapSettings: { getGear: () => new ItemSwapGear({}) } }) as unknown as Player<any>;

const skeleton = (): RaidSimRequest => structuredClone(retSkeleton) as RaidSimRequest;

/** The page's equipped item for a spec, as `Database.lookupItemSpec` builds it. */
function equipped(spec: ItemSpecJson): unknown {
	const item = Database.getSync().lookupItemSpec(ItemSpec.create(spec));
	expect(item).not.toBeNull();
	return item;
}

describe('a worn random suffix reaches the sim', () => {
	it("the page gear adapter reads the worn item's suffix, and gives an item without one no suffix field", async () => {
		const gear = SIM_ORDER.map((_, i) =>
			i === WRIST
				? equipped({
						id: RAVAGERS_BRACERS,
						randomSuffix: OF_THE_BEAST,
						enchant: 2647,
					})
				: i === 0
					? equipped({ id: 29073, enchant: 3003, gems: [24027, 32409] })
					: null,
		);
		const simUI = {
			player: {
				getGear: () => ({ getEquippedItems: () => gear }),
				getTalentTreePoints: () => [5, 11, 45],
			},
		} as unknown as IndividualSimHost<any>;

		const logged = await new PlayerGearSource(simUI).readGear(CURRENT_PAGE_FIGHT);

		expect(logged.items[WRIST]).toEqual({
			id: RAVAGERS_BRACERS,
			slot: 'wrist',
			randomSuffix: OF_THE_BEAST,
			enchant: 2647,
		});
		// No suffix, no field: logged gear without suffixes keeps its old shape,
		// so the requests built from it stay byte for byte the same.
		expect(logged.items[0]).toEqual({
			id: 29073,
			slot: 'head',
			enchant: 3003,
			gems: [24027, 32409],
		});
	});

	it("every request that keeps the worn suffix item sends its suffix and the suffix's database row; a candidate in that slot sends none", async () => {
		const presetWrist = equipmentOf(skeleton())[WRIST]!;
		expect(presetWrist.id).toBe(28795); // Bladespire Warbands, the candidate
		const { requests, ranking } = await runRanking(presetWrist.id!);

		const keeps = requests.filter(req => equipmentOf(req)[WRIST]?.id === RAVAGERS_BRACERS);
		const swaps = requests.filter(req => equipmentOf(req)[WRIST]?.id === presetWrist.id);
		// The baseline and the head candidate keep the bracers.
		expect(keeps.length).toBeGreaterThanOrEqual(2);
		expect(swaps.length).toBeGreaterThanOrEqual(1);

		for (const req of keeps) {
			expect(equipmentOf(req)[WRIST]).toEqual({
				id: RAVAGERS_BRACERS,
				randomSuffix: OF_THE_BEAST,
				enchant: 2647,
			});
			const db = (playerOf(req).database ?? {}) as DbJson;
			expect((db.randomSuffixes ?? []).map(row => row.id)).toEqual([OF_THE_BEAST]);
		}
		for (const req of swaps) {
			expect(equipmentOf(req)[WRIST]).not.toHaveProperty('randomSuffix');
			const db = (playerOf(req).database ?? {}) as DbJson;
			expect(db.randomSuffixes ?? []).toEqual([]);
		}
		// The bracers' own row puts the same item back in its own slot: with the
		// suffix kept, that is the baseline request, so the store answers it and
		// the change is exactly 0.
		const wornRow = ranking.items.find(row => row.itemId === RAVAGERS_BRACERS);
		expect(wornRow?.deltaDps).toBe(0);
		// The worn row is the player's own copy, named with the suffix they wear,
		// not the spec's best one ("of the Tiger").
		expect(wornRow?.name).toBe("Ravager's Bracers of the Beast");
		expect(wornRow?.randomSuffix).toBe(OF_THE_BEAST);
	});

	it('a random-suffix candidate the player does not wear is simmed with its best suffix for the spec, and its row names that suffix', async () => {
		const { requests, ranking } = await runRanking(28795, {
			wornSuffix: 'none',
		});

		const swaps = requests.filter(req => equipmentOf(req)[WRIST]?.id === RAVAGERS_BRACERS);
		expect(swaps.length).toBeGreaterThanOrEqual(1);
		for (const req of swaps) {
			expect(equipmentOf(req)[WRIST]?.randomSuffix).toBe(OF_THE_TIGER);
			const db = (playerOf(req).database ?? {}) as DbJson;
			expect((db.randomSuffixes ?? []).map(row => row.id)).toEqual([OF_THE_TIGER]);
		}
		// Requests without the bracers carry no suffix row.
		for (const req of requests.filter(r => !swaps.includes(r))) {
			const db = (playerOf(req).database ?? {}) as DbJson;
			expect(db.randomSuffixes ?? []).toEqual([]);
		}
		const row = ranking.items.find(r => r.itemId === RAVAGERS_BRACERS);
		// wowsims' own name for a suffixed item: the item's name, a space, the
		// suffix's name (`ItemDetailCell`, ui/features/gear/components/ItemCell).
		expect(row?.name).toBe("Ravager's Bracers of the Tiger");
		expect(row?.randomSuffix).toBe(OF_THE_TIGER);
		// A candidate with no suffix options keeps its plain name and no field.
		const helm = ranking.items.find(r => r.itemId === 30131);
		expect(helm?.name).toBe('item 30131');
		expect(helm).not.toHaveProperty('randomSuffix');
	});

	it("a run after the worn suffix changes is simmed again, not answered from the previous run's saved ranking", async () => {
		const store = new MemoryStore();
		await runRanking(28795, { store });
		const second = await runRanking(28795, {
			store,
			wornSuffix: OF_THE_TIGER,
		});

		expect(second.requests.length).toBeGreaterThan(0);
		expect(equipmentOf(second.requests[0]!)[WRIST]?.randomSuffix).toBe(OF_THE_TIGER);
		const wornRow = second.ranking.items.find(row => row.itemId === RAVAGERS_BRACERS);
		expect(wornRow?.name).toBe("Ravager's Bracers of the Tiger");
	});

	it('the same holds when the pool leaves the worn suffix item out (an excluded source, Prune, a later phase)', async () => {
		const store = new MemoryStore();
		await runRanking(28795, { store, wornInPool: false });
		const second = await runRanking(28795, {
			store,
			wornSuffix: OF_THE_TIGER,
			wornInPool: false,
		});

		expect(second.requests.length).toBeGreaterThan(0);
		expect(equipmentOf(second.requests[0]!)[WRIST]?.randomSuffix).toBe(OF_THE_TIGER);
	});
});

/**
 * Ranks ret P2 gear and returns every request. The wrist holds Ravager's
 * Bracers with `wornSuffix` (default "of the Beast"), or with `"none"` the
 * preset's own wrist item.
 */
async function runRanking(
	wristCandidate: number,
	{ wornSuffix = OF_THE_BEAST, store, wornInPool = true }: { wornSuffix?: number | 'none'; store?: MemoryStore; wornInPool?: boolean } = {},
): Promise<{ requests: RaidSimRequest[]; ranking: Ranking | PartialRanking }> {
	const raidSimSkeleton = skeleton();
	const character = { region: 'US' as const, realm: 'test', name: 'suffix' };
	const summary = {
		reportCode: 'suffix1',
		fightId: 1,
		encounterName: 'Test Dummy',
		killedAt: '2026-10-01T00:00:00.000Z',
		route: 'ranked' as const,
		confidence: 1,
	};
	const fightRef = { reportCode: summary.reportCode, fightId: summary.fightId };
	const worn = equipmentOf(raidSimSkeleton);
	const loggedGear = {
		items: SIM_ORDER.map((slot, i) =>
			i === WRIST && wornSuffix !== 'none'
				? {
						id: RAVAGERS_BRACERS,
						slot,
						randomSuffix: wornSuffix,
						enchant: 2647,
					}
				: {
						id: worn[i]?.id ?? 0,
						slot,
						...(worn[i]?.enchant ? { enchant: worn[i]!.enchant } : {}),
						gems: worn[i]?.gems ?? [],
					},
		),
		talentPointsByTree: [5, 11, 45] as [number, number, number],
		provenance: { ...fightRef, sourceID: 1 },
	};
	const gearSource = new RecordedGearSource({
		fights: new Map([[characterFightKey(character, 'ret'), [summary]]]),
		gear: new Map([[fightGearKey(fightRef), loggedGear]]),
	});

	const requests: RaidSimRequest[] = [];
	const sim: SimRunner = {
		version: () => Promise.resolve(SIM_VERSION),
		computeStats: zeroHitStats,
		run: (req, opts) => {
			requests.push(req);
			return Promise.resolve({
				dps: 2000 + requests.length,
				stdev: 30,
				iterationsDone: opts.iterations,
				simVersion: SIM_VERSION,
			});
		},
	};
	const weights = epWeightsFor('ret');

	const ranking = await rankUpgrades(
		{
			character,
			spec: 'ret',
			maxPhase: 5,
			fight: fightRef,
			iterations: 5000,
			seeds: [11],
			candidateCap: 100,
		},
		{
			gear: gearSource,
			sim,
			store: store ?? new MemoryStore(),
			clock: () => new Date('2026-10-01T12:00:00.000Z'),
			raidSimSkeleton,
			epWeights: weights,
			itemEp: statsOnlyItemEp(weights),
			pool: [
				{ itemId: wristCandidate, slot: 'wrist' as const },
				{ itemId: 30131, slot: 'head' as const }, // Crystalforge War-Helm
				{ itemId: RAVAGERS_BRACERS, slot: 'wrist' as const }, // worn: the pool holds it
			]
				.filter(p => wornInPool || p.itemId !== RAVAGERS_BRACERS)
				.map(p => ({
					...p,
					// The bracers keep their db.json name, as the tab's pool does, so the
					// row's suffixed name can be checked whole.
					name: p.itemId === RAVAGERS_BRACERS ? "Ravager's Bracers" : `item ${p.itemId}`,
					phase: 1,
					source: { kind: 'badge' as const, cost: 1 },
				})),
			simDatabaseFor: simDatabaseResolverFor(stubPlayer(), raidSimSkeleton),
		},
	);
	return { requests, ranking };
}
