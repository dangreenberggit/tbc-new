/**
 * The tab's per-request database includes the page's consumable rows, on the
 * real resolver.
 *
 * The page's own sim request names the player's consumables and sends their
 * `consumables` and `spellEffects` rows beside the item rows. The tab's
 * requests are composed from a skeleton of that same request, but `compose()`
 * replaces `player.database` as a whole with the resolver's result. If the
 * resolver drops those rows, a backend that has not seen them sims without
 * consumables: Go skips a named consumable that has no row (a zero-value row
 * adds nothing, `sim/core/database.go` `GetConsumableByID`), and it panics on
 * a consumable row whose effect row is missing (`sim/core/consumes.go`, the
 * potion and conjured-item `GetSpellEffectByID` reads). So every case checks
 * the rows equal the skeleton's, and that every effect id has its row.
 *
 * The seams are the resolver (`simDatabaseResolverFor`, an adapter) and the
 * module interface `rankUpgrades`. Cases stand for kinds of consumable mix,
 * not for specs: neither the resolver nor
 * `extendPlayerProtoWithMissingEffects` branches on class or spec. Real item
 * ids are used as values.
 */

import { Player as PlayerProto } from '@generated/proto/api';
import { ItemSlot, ItemSpec } from '@generated/proto/common';
import { SimDatabase } from '@generated/proto/db';
import type { Player } from '@sim/player/player';
import { Database } from '@sim/proto/database';
import { ItemSwapGear } from '@sim/proto/gear';
import { extendPlayerProtoWithMissingEffects } from '@sim/proto/proto_migration';
import { describe, expect, it, vi } from 'vitest';

import { statsOnlyItemEp, zeroHitStats } from '../../testing/engine_fakes';
import feralSkeleton from '../../testing/feral_p2.skeleton.json';
import { characterFightKey, fightGearKey, RecordedGearSource } from '../../testing/recorded_gear_source';
import retSkeleton from '../../testing/ret_p2.skeleton.json';
import { epWeightsFor } from '../data/data';
import { rankUpgrades } from '../engine/rank';
import type { RaidSimRequest, SimRunner } from '../engine/seams/sim-runner';
import { MemoryStore } from '../engine/seams/store';
import { SIM_ORDER, type SimItemSpec, type SimOrderName } from '../engine/slots';
import { simDatabaseResolverFor } from './sim_database';

// The resolver reads items through `Database.getSync()`; the real class over the test database stands in for the page's.
vi.mock('@sim/proto/database', importOriginal => import('../../testing/database_mock').then(m => m.withTestDatabase(importOriginal)));

type Json = Record<string, unknown>;
type Row = { id?: number; effectIds?: number[] };
type DbJson = {
	items?: Row[];
	consumables?: Row[];
	spellEffects?: Row[];
};
type ItemSpecJson = { id?: number };

const playerOf = (request: Json | RaidSimRequest): Json => (request.raid as { parties: [{ players: [Json] }] }).parties[0].players[0];

/**
 * A skeleton as the page's own request would send it: the player's database
 * holds the rows for its named consumables. This is the step
 * `ui/sim/sim.ts:292` runs on the page's request.
 */
function pageSkeleton(source: object, consumes?: Json): RaidSimRequest {
	const skeleton = structuredClone(source) as Json;
	const playerJson = playerOf(skeleton);
	if (consumes !== undefined) playerJson.consumables = consumes;
	const player = PlayerProto.fromJson(playerJson as never, { ignoreUnknownFields: true });
	player.database = SimDatabase.create();
	extendPlayerProtoWithMissingEffects(player, Database.getSync());
	const raid = skeleton.raid as { parties: [{ players: [unknown] }] };
	raid.parties[0].players[0] = PlayerProto.toJson(player);
	return skeleton;
}

const skeletonDb = (skeleton: RaidSimRequest): DbJson => (playerOf(skeleton).database ?? {}) as DbJson;

const equipmentOf = (skeleton: RaidSimRequest): ItemSpecJson[] => (playerOf(skeleton).equipment as { items: ItemSpecJson[] }).items.map(item => ({ ...item }));

const stubPlayer = (swap?: ItemSwapGear) => ({ itemSwapSettings: { getGear: () => swap ?? new ItemSwapGear({}) } }) as unknown as Player<any>;

/** The resolver the tab builds for `skeleton`, with its rows read as JSON. */
function resolverFor(skeleton: RaidSimRequest, swap?: ItemSwapGear): (equipment: readonly ItemSpecJson[]) => DbJson | undefined {
	const resolve = simDatabaseResolverFor(stubPlayer(swap), skeleton);
	return equipment => resolve(equipment as readonly SimItemSpec[]) as DbJson | undefined;
}

const ids = (rows: readonly Row[] | undefined): number[] => (rows ?? []).map(row => row.id ?? 0).sort((a, b) => a - b);

/** Every effect id of every consumable row has a spell-effect row. */
function covered(db: DbJson): boolean {
	const effects = new Set(ids(db.spellEffects));
	return (db.consumables ?? []).every(row => (row.effectIds ?? []).every(id => effects.has(id)));
}

const wornIds = (skeleton: RaidSimRequest): number[] =>
	equipmentOf(skeleton)
		.map(item => item.id ?? 0)
		.filter(id => id !== 0);

/**
 * The assertions every consumable mix shares: the rows are the skeleton's,
 * not empty, include at least one consumable with effects, cover every
 * effect id, and sit beside a row for each worn item.
 */
function expectPageRows(db: DbJson | undefined, skeleton: RaidSimRequest, counts: { consumables: number; spellEffects: number }): void {
	const want = skeletonDb(skeleton);
	expect(ids(db?.consumables)).toEqual(ids(want.consumables));
	expect(ids(db?.consumables)).toHaveLength(counts.consumables);
	expect(ids(db?.spellEffects)).toEqual(ids(want.spellEffects));
	expect(ids(db?.spellEffects)).toHaveLength(counts.spellEffects);
	expect((db?.consumables ?? []).some(row => (row.effectIds ?? []).length > 0)).toBe(true);
	expect(covered(db ?? {})).toBe(true);
	const items = new Set(ids(db?.items));
	for (const id of wornIds(skeleton)) expect(items.has(id)).toBe(true);
}

describe("tab requests carry the page's consumables", () => {
	it('an agility melee mix (feral P2 consumables on ret P2 gear) is sent with its rows', () => {
		// Scenario kind: battle and guardian elixirs, agility food, an imbue,
		// drums, and potion and conjured lists with multi-effect rows. Stands
		// for feral, rogue, enhancement and hunter. The feral skeleton has no
		// gear, so the ret gear supplies the item rows.
		const feralConsumes = playerOf(feralSkeleton as Json).consumables as Json;
		const skeleton = pageSkeleton(retSkeleton, feralConsumes);
		const db = resolverFor(skeleton)(equipmentOf(skeleton));
		expectPageRows(db, skeleton, { consumables: 18, spellEffects: 14 });
	});

	it('a strength melee mix with a flask and explosives (ret P2 skeleton) is sent with its rows', () => {
		// Scenario kind: ret and warrior.
		const skeleton = pageSkeleton(retSkeleton);
		const db = resolverFor(skeleton)(equipmentOf(skeleton));
		expectPageRows(db, skeleton, { consumables: 20, spellEffects: 14 });
	});

	it('a caster mix (ret P2 gear) is sent with the effect rows Go reads', () => {
		// Scenario kind: a spell flask, caster food, mana potions with effect
		// rows, Demonic Rune and a Healthstone. Stands for mage, warlock,
		// shadow, balance and elemental; the class does not matter here.
		const skeleton = pageSkeleton(retSkeleton, {
			flaskId: 22866,
			foodId: 27657,
			potId: 22839,
			conjuredId: 12662,
			potions: [22832, 31677, 22839],
			conjuredItems: [12662, 22105],
		});
		const db = resolverFor(skeleton)(equipmentOf(skeleton));
		// Seven distinct ids: the flask, the food, three potions and two
		// conjured items (22839 and 12662 are named twice).
		expectPageRows(db, skeleton, { consumables: 7, spellEffects: 6 });
		// Super Mana, Fel Mana, Demonic Rune and Master Healthstone: the rows
		// the potion and conjured-item paths in consumes.go read.
		expect(ids(db?.spellEffects)).toEqual(expect.arrayContaining([847151, 858752, 858753, 858755, 694074, 846788]));
	});

	it('nothing selected (ret P2 gear) sends no consumable rows', () => {
		const skeleton = pageSkeleton(retSkeleton, {});
		const db = resolverFor(skeleton)(equipmentOf(skeleton));
		expect(ids(db?.consumables)).toEqual([]);
		expect(ids(db?.spellEffects)).toEqual([]);
		const items = new Set(ids(db?.items));
		expect(wornIds(skeleton)).toHaveLength(16);
		for (const id of wornIds(skeleton)) expect(items.has(id)).toBe(true);
	});

	it('the rows follow the skeleton, not the equipment (ret P2 skeleton)', () => {
		const skeleton = pageSkeleton(retSkeleton);
		const resolve = resolverFor(skeleton);
		const worn = equipmentOf(skeleton);
		expect(worn[0]?.id).toBe(29073); // Justicar Crown
		const swapped = worn.map((item, slot) => (slot === 0 ? { id: 30131 } : item)); // Crystalforge War-Helm
		const want = skeletonDb(skeleton);
		const results = [resolve(worn), resolve(swapped)];
		for (const db of results) {
			expect(ids(db?.consumables)).toEqual(ids(want.consumables));
			expect(ids(db?.consumables).length).toBeGreaterThan(0);
			expect(ids(db?.spellEffects)).toEqual(ids(want.spellEffects));
			expect(ids(db?.spellEffects).length).toBeGreaterThan(0);
		}
		const [wornItems, swappedItems] = results.map(db => ids(db?.items));
		expect(wornItems).toContain(29073);
		expect(wornItems).not.toContain(30131);
		expect(swappedItems).toContain(30131);
		expect(swappedItems).not.toContain(29073);
	});

	it('item-swap rows are still merged (ret P2 skeleton)', () => {
		const skeleton = pageSkeleton(retSkeleton);
		const gorehowl = Database.getSync().lookupItemSpec(ItemSpec.create({ id: 28773 }));
		expect(gorehowl).not.toBeNull();
		const swap = new ItemSwapGear({ [ItemSlot.ItemSlotMainHand]: gorehowl! });
		const db = resolverFor(skeleton, swap)(equipmentOf(skeleton));
		expect(ids(db?.items)).toContain(28773);
	});

	it('every request of a ranking with a worn set, set-bonus copies included, carries the rows (feral P2 skeleton, worn Malorne)', async () => {
		// Scenario kind: the set-less and set-kept copy requests. Only the feral
		// skeleton's consumables matter: compose puts the gear source's worn
		// gear in place of its empty equipment.
		const skeleton = pageSkeleton(feralSkeleton);
		const want = skeletonDb(skeleton);
		const requests = await runRanking(skeleton);

		const equipped = requests.map(req => ((playerOf(req).equipment as { items?: ItemSpecJson[] }).items ?? []).map(item => item?.id ?? 0));
		expect(equipped.some(list => list.some(id => id >= 1_000_000 && id < 2_000_000))).toBe(true);
		expect(equipped.some(list => list.some(id => id >= 2_000_000))).toBe(true);

		for (const [i, req] of requests.entries()) {
			const db = (playerOf(req).database ?? {}) as DbJson;
			expect(ids(db.consumables)).toEqual(ids(want.consumables));
			expect(ids(db.consumables).length).toBeGreaterThan(0);
			expect(ids(db.spellEffects)).toEqual(ids(want.spellEffects));
			expect(ids(db.spellEffects).length).toBeGreaterThan(0);
			const items = new Set(ids(db.items));
			for (const id of (equipped[i] ?? []).filter(id => id !== 0)) {
				expect(items.has(id)).toBe(true);
			}
		}
	});
});

/* ------------------------------------------------------------------ *
 * The worn-set ranking above
 * ------------------------------------------------------------------ */

const SIM_VERSION = 'v0.0.101';
const ITERATIONS = 5000;

const WORN_MALORNE: Partial<Record<SimOrderName, number>> = {
	head: 29098, // Stag-Helm of Malorne
	shoulder: 29100, // Mantle of Malorne
	hands: 29097, // Gauntlets of Malorne
};
const POOL = [
	{ itemId: 31039, slot: 'head' }, // Thunderheart Cover
	{ itemId: 31048, slot: 'shoulder' }, // Thunderheart Pauldrons
] as const;

const CHAR = { region: 'US' as const, realm: 'test', name: 'consumables' };
const SUMMARY = {
	reportCode: 'con522',
	fightId: 1,
	encounterName: 'Test Dummy',
	killedAt: '2026-10-01T00:00:00.000Z',
	route: 'ranked' as const,
	confidence: 1,
};

/** Ranks with a stub sim and returns every request the ranking sent. */
async function runRanking(skeleton: RaidSimRequest): Promise<RaidSimRequest[]> {
	const fightRef = { reportCode: SUMMARY.reportCode, fightId: SUMMARY.fightId };
	const loggedGear = {
		items: SIM_ORDER.map(slot => ({
			id: WORN_MALORNE[slot] ?? 0,
			slot,
			gems: [],
		})),
		talentPointsByTree: [0, 45, 16] as [number, number, number],
		provenance: { ...fightRef, sourceID: 1 },
	};
	const gearSource = new RecordedGearSource({
		fights: new Map([[characterFightKey(CHAR, 'feral'), [SUMMARY]]]),
		gear: new Map([[fightGearKey(fightRef), loggedGear]]),
	});

	const requests: RaidSimRequest[] = [];
	const sim: SimRunner = {
		version: () => Promise.resolve(SIM_VERSION),
		computeStats: zeroHitStats,
		run: (req, opts) => {
			requests.push(req);
			const equipped = ((playerOf(req).equipment as { items?: ItemSpecJson[] }).items ?? []).filter(item => (item?.id ?? 0) !== 0).length;
			return Promise.resolve({
				dps: 2000 + 10 * equipped,
				stdev: 30,
				iterationsDone: opts.iterations,
				simVersion: SIM_VERSION,
			});
		},
	};

	const weights = epWeightsFor('feral');

	await rankUpgrades(
		{
			character: CHAR,
			spec: 'feral',
			maxPhase: 5,
			fight: fightRef,
			iterations: ITERATIONS,
			seeds: [11],
			candidateCap: 100,
		},
		{
			gear: gearSource,
			sim,
			store: new MemoryStore(),
			clock: () => new Date('2026-10-01T12:00:00.000Z'),
			raidSimSkeleton: skeleton,
			epWeights: weights,
			itemEp: statsOnlyItemEp(weights),
			pool: POOL.map(p => ({
				itemId: p.itemId,
				name: `item ${p.itemId}`,
				slot: p.slot,
				phase: 1,
				source: { kind: 'badge' as const, cost: 1 },
			})),
			simDatabaseFor: simDatabaseResolverFor(stubPlayer(), skeleton),
			measureSetBonuses: true,
		},
	);
	return requests;
}
