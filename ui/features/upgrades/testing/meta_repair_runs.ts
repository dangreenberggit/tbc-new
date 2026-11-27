/**
 * `rankUpgrades` runs for the meta repair tests: ret's worn P3 gear on a fake sim
 * whose DPS and stats reads the test scripts. Each test module that imports this
 * also mocks `@sim/proto/database` with `database_mock.ts`.
 */

import { expect } from 'vitest';

import { epWeightsFor } from '../model/data/data';
import { type GemContext, gemContext } from '../model/engine/candidate-gems';
import { capProfileFor, hitCapBudgetFrom } from '../model/engine/cap-profile';
import { gearHitRating } from '../model/engine/caps';
import { candidateSwapPreRepair } from '../model/engine/gear-swap';
import { gemsForPhase } from '../model/engine/gems';
import { getItem } from '../model/engine/items';
import type { ItemSlot } from '../model/engine/pool';
import { rankUpgrades } from '../model/engine/rank';
import type { PlayerStatsObservation, RaidSimRequest, SimRunner, SpellDamageBySchool } from '../model/engine/seams/sim-runner';
import { MemoryStore } from '../model/engine/seams/store';
import type { SetScreenMode } from '../model/engine/set-screen';
import { SIM_ORDER, type SimItemSpec } from '../model/engine/slots';
import { Stat } from '../model/engine/stats';
import type { SpecId } from '../model/engine/types';
import { statsOnlyItemEp } from './engine_fakes';
import {
	BASELINE_HIT_PERCENT,
	BOLD,
	budgetRequest,
	changesBetween,
	CHEST,
	HANDS,
	HEAD,
	metaOf,
	NIGHTSEYE,
	pairsOf,
	pseudoStatsWithHit,
	RAGESTEEL_BREASTPLATE,
	RAGESTEEL_SHOULDERS,
	retP3Worn,
	retWeights,
	SCHOOL,
	SHOULDER,
	socketedOf,
} from './meta_repair_inputs';
import { characterFightKey, fightGearKey, RecordedGearSource } from './recorded_gear_source';
import retP2Skeleton from './ret_p2.skeleton.json';

/** A fresh copy of the ret P2 raid sim skeleton. */
export const retSkeleton = (): RaidSimRequest => structuredClone(retP2Skeleton) as RaidSimRequest;

/** The ret P2 skeleton with every target's level set to `level`. */
export function skeletonAtLevel(level: number, skeleton: RaidSimRequest = retSkeleton()): RaidSimRequest {
	for (const t of (skeleton as { encounter: { targets: Array<{ level: number }> } }).encounter.targets) t.level = level;
	return skeleton;
}

/** The ret P2 skeleton with the player's talents replaced. */
export function skeletonWithTalents(talentsString: string): RaidSimRequest {
	const skeleton = retSkeleton() as { raid: { parties: Array<{ players: Array<{ talentsString: string }> }> } };
	skeleton.raid.parties[0]!.players[0]!.talentsString = talentsString;
	return skeleton as unknown as RaidSimRequest;
}

const RET_CHAR = { region: 'US' as const, realm: 'test', name: 'repaircase' };
const RET_FIGHT = {
	reportCode: 'rep535',
	fightId: 1,
	encounterName: 'Test Dummy',
	killedAt: '2026-10-03T00:00:00.000Z',
	route: 'ranked' as const,
	confidence: 1,
};
const SIM_VERSION = 'v0.0.535';

/** The first player's equipment items of a composed request. */
export function requestItems(req: RaidSimRequest): SimItemSpec[] {
	const raid = req.raid as {
		parties?: Array<{ players?: Array<{ equipment?: { items?: unknown[] } }> }>;
	};
	return (raid.parties?.[0]?.players?.[0]?.equipment?.items ?? []).map(raw => {
		const it = raw as { id?: number; enchant?: number; gems?: number[] };
		return {
			...(it.id ? { id: it.id } : {}),
			...(it.enchant ? { enchant: it.enchant } : {}),
			gems: [...(it.gems ?? [])],
		};
	});
}

/** A stats request's item ids, enchants and gems in every slot. */
export const gearKey = (req: RaidSimRequest) => JSON.stringify(requestItems(req).map(s => [s.id ?? 0, s.enchant ?? 0, s.gems]));

export type SpecRun = {
	/** The worn gear; defaults to ret's worn P3 gear. */
	worn?: SimItemSpec[];
	pool: ReadonlyArray<{ itemId: number; slot: ItemSlot }>;
	/** Left out, the runner has no `computeStats`, which breaks `SimRunner`. */
	computeStats?: (req: RaidSimRequest) => Promise<PlayerStatsObservation>;
	/** The DPS of a request; defaults to a flat 2000. */
	dps?: (req: RaidSimRequest) => number;
	store?: MemoryStore;
	measureSetBonuses?: boolean;
	setScreenMode?: SetScreenMode;
	controller?: AbortController;
	/** The raid sim skeleton; defaults to ret P2's. */
	skeleton?: RaidSimRequest;
	/** Called with each request `run` receives, before it answers. */
	onRun?: (req: RaidSimRequest) => void;
	/** The spec the run ranks for; defaults to ret. */
	spec?: SpecId;
	/** Every sim's `spellDamageBySchool`; defaults to all damage in Shadow. `null` leaves the field out. */
	castDamage?: SpellDamageBySchool | null;
	/** The EP weights; defaults to ret's. */
	epWeights?: Readonly<Record<string, number>>;
	/** The run's `simDatabaseFor`, which `composeFor` calls for every request. */
	simDatabaseFor?: (equipment: readonly SimItemSpec[]) => Readonly<Record<string, unknown>> | undefined;
};

export async function runSpec(o: SpecRun) {
	const spec = o.spec ?? 'ret';
	const worn = o.worn ?? retP3Worn();
	const fightRef = { reportCode: RET_FIGHT.reportCode, fightId: RET_FIGHT.fightId };
	const loggedGear = {
		items: worn.map((item, i) => ({
			// An empty slot logs id 0, which `equipmentFromLoggedGear` reads as bare.
			id: item.id ?? 0,
			slot: SIM_ORDER[i]!,
			...(item.enchant ? { enchant: item.enchant } : {}),
			gems: [...item.gems],
		})),
		talentPointsByTree: [5, 11, 45] as [number, number, number],
		provenance: { ...fightRef, sourceID: 1 },
	};
	const gear = new RecordedGearSource({
		fights: new Map([[characterFightKey(RET_CHAR, spec), [RET_FIGHT]]]),
		gear: new Map([[fightGearKey(fightRef), loggedGear]]),
	});
	const pool = o.pool.map(p => ({
		itemId: p.itemId,
		name: `item ${p.itemId}`,
		slot: p.slot,
		phase: 1,
		source: { kind: 'badge' as const, cost: 1 },
	}));

	const requests: RaidSimRequest[] = [];
	const statsRequests: RaidSimRequest[] = [];
	const read = o.computeStats;
	const sim = {
		version: () => Promise.resolve(SIM_VERSION),
		run: (req: RaidSimRequest, opts: { iterations: number; saveAllValues?: boolean }) => {
			requests.push(structuredClone(req));
			o.onRun?.(req);
			const dps = o.dps ? o.dps(req) : 2000;
			const castDamage = o.castDamage === undefined ? { [SCHOOL.shadow]: 1 } : o.castDamage;
			return Promise.resolve({
				dps,
				stdev: 30,
				iterationsDone: opts.iterations,
				simVersion: SIM_VERSION,
				...(castDamage === null ? {} : { spellDamageBySchool: castDamage }),
				...(opts.saveAllValues === true ? { allValues: new Array<number>(opts.iterations).fill(dps) } : {}),
			});
		},
		...(read
			? {
					computeStats: (req: RaidSimRequest) => {
						statsRequests.push(structuredClone(req));
						return read(req);
					},
				}
			: {}),
	} as SimRunner;

	const weights = o.epWeights ?? retWeights;
	const ranking = await rankUpgrades(
		{
			character: RET_CHAR,
			spec,
			maxPhase: 3,
			fight: fightRef,
			iterations: 1000,
			seeds: [11],
			candidateCap: 100,
		},
		{
			gear,
			sim,
			store: o.store ?? new MemoryStore(),
			clock: () => new Date('2026-10-03T12:00:00.000Z'),
			raidSimSkeleton: o.skeleton ?? retSkeleton(),
			epWeights: weights,
			itemEp: statsOnlyItemEp(weights),
			pool,
			...(o.measureSetBonuses ? { measureSetBonuses: true } : {}),
			...(o.setScreenMode ? { setScreenMode: o.setScreenMode } : {}),
			...(o.controller ? { signal: o.controller.signal } : {}),
			...(o.simDatabaseFor ? { simDatabaseFor: o.simDatabaseFor } : {}),
		},
	);
	return { ranking, requests, statsRequests, worn };
}

export const SET_LESS_OFFSET = 1_000_000;
export const SET_KEPT_OFFSET = 2_000_000;
const RATING_PER_HIT_PERCENT = 15.769233;
export const SPELL_HIT_RATING_PER_PERCENT = 12.615385;

/** The real item id behind a set-less or set-kept copy id. */
export const realId = (id: number) => id % SET_LESS_OFFSET;

/**
 * A scripted `computeStats`: the request's gear hit by `gearHitRating`, with
 * copies mapped back to their items, plus `bonusHit[setId]` for each set
 * that counts at least two pieces (a real piece or a set-kept copy; a
 * set-less copy counts toward no set). The baseline reads
 * `baselineHitPercent`, so the hit percent moves with the gear from there.
 * `hit` names the rating, the pseudo-stat slot and the rating per percent;
 * the default is melee hit in slot 12.
 */
export function scriptedStats(o: {
	baselineGearHit: number;
	baselineHitPercent: number;
	bonusHit: Readonly<Record<number, number>>;
	hit?: { stat: Stat; slot: number; ratingPerPercent: number };
	/**
	 * For a slot-13 read, each school slot's extra hit over slot 13; the
	 * school slots 6-11 read slot 13 plus it, as `FillPlayerStats` writes them.
	 */
	schoolBonus?: Readonly<Record<number, number>>;
}) {
	const hit = o.hit ?? { stat: Stat.StatMeleeHitRating, slot: 12, ratingPerPercent: RATING_PER_HIT_PERCENT };
	return (req: RaidSimRequest): PlayerStatsObservation => {
		const items = requestItems(req);
		const mapped = items.map(spec => (spec.id ? { ...spec, id: realId(spec.id) } : spec));
		const counts = new Map<number, number>();
		for (const spec of items) {
			if (!spec.id) continue;
			if (spec.id >= SET_LESS_OFFSET && spec.id < SET_KEPT_OFFSET) continue;
			const setId = getItem(realId(spec.id))?.setId;
			if (setId) counts.set(setId, (counts.get(setId) ?? 0) + 1);
		}
		let bonus = 0;
		for (const [setId, n] of counts) {
			if (n >= 2) bonus += o.bonusHit[setId] ?? 0;
		}
		const rating = gearHitRating(mapped, hit.stat) + bonus;
		const percent = (rating - o.baselineGearHit) / hit.ratingPerPercent + o.baselineHitPercent;
		const pseudoStats = pseudoStatsWithHit(percent, hit.slot);
		if (hit.slot === 13) {
			for (let slot = 6; slot <= 11; slot++) {
				pseudoStats[slot] = percent + (o.schoolBonus?.[slot] ?? 0);
			}
		}
		return { stats: [], pseudoStats };
	};
}

/** A `computeStats` that reads the baseline's hit once and fails a second call. */
export function baselineReadOnce(): (req: RaidSimRequest) => Promise<PlayerStatsObservation> {
	let calls = 0;
	return () => {
		calls += 1;
		if (calls > 1) {
			return Promise.reject(new Error('computeStats called twice in one run'));
		}
		return Promise.resolve({ stats: [], pseudoStats: pseudoStatsWithHit(BASELINE_HIT_PERCENT) });
	};
}

/**
 * A `computeStats` that reads hit from the request's gear, with no set
 * bonus: the baseline reads `BASELINE_HIT_PERCENT`, and each candidate's own
 * read moves from there with its gear hit.
 */
export function gearHitReads(): (req: RaidSimRequest) => Promise<PlayerStatsObservation> {
	const stats = scriptedStats({ baselineGearHit: 52, baselineHitPercent: BASELINE_HIT_PERCENT, bonusHit: {} });
	return req => Promise.resolve(stats(req));
}

/**
 * A caster's stats read: `shared` spell hit in slot 13 and in each school
 * slot 6-11, plus each school's talent bonus, as `FillPlayerStats` writes
 * them (`sim/core/character_sheet.go:110-116`).
 */
export function casterRead(shared: number, schoolBonus: Readonly<Record<number, number>> = {}): () => Promise<PlayerStatsObservation> {
	const pseudoStats = pseudoStatsWithHit(shared, 13);
	for (let slot = 6; slot <= 11; slot++) {
		pseudoStats[slot] = shared + (schoolBonus[slot] ?? 0);
	}
	return () => Promise.resolve({ stats: [], pseudoStats: [...pseudoStats] });
}

/** The (from, to) pairs of every request whose chest is `chestId`. */
export function chestRequestChanges(requests: readonly RaidSimRequest[], baseline: readonly SimItemSpec[], chestId: number): string[][] {
	return requests
		.map(requestItems)
		.filter(items => items[CHEST]?.id === chestId)
		.map(items => pairsOf(changesBetween(baseline, items, CHEST)));
}

export const S_POOL = [
	{ itemId: 32365, slot: 'chest' }, // Heartshatter Breastplate, over the cap
	{ itemId: 30907, slot: 'chest' }, // Mail of Fevered Pursuit, under it
] as const;

/** The notes that say repair could not use the hit cap. */
export const isHitCapNote = (s: { field: string }) => s.field === 'Meta gem swaps and the hit cap';

/** How a run fails when a stats read fails: as a failed sim, with the sim's own message. */
export const SIM_FAILED_WORKER_DIED = {
	name: 'RankError',
	kind: 'sim-failed',
	message: 'worker died',
};

/**
 * ret's worn P3 gear with the chest's Enscribed Fire Opal (30584) swapped for
 * Bold, so the meta is off by one yellow and the worn-gear repair runs. With
 * no hit cap it puts Rigid in; with the baseline's budget, Inscribed.
 */
export function wornWithMetaOff(): SimItemSpec[] {
	const worn = retP3Worn();
	const chest = worn[CHEST]!;
	chest.gems = chest.gems.map(g => (g === 30584 ? BOLD : g));
	expect(chest.gems).toEqual([BOLD, BOLD, 28363]);
	expect(metaOf(socketedOf(worn)).status.kind).toBe('inactive');
	return worn;
}

export const BURNING_RAGE = 566;

// Justicar Battlegear 626 (ret plate), Burning Rage 566's worn pieces, and
// Crystalforge Greaves (629) holding a yellow the meta needs.
export const JUSTICAR = {
	shoulder: 29075,
	chest: 29071,
	hands: 29072,
	legs: 29074,
} as const;
const CRYSTALFORGE_GREAVES = 30132;
const ENSCRIBED_FIRE_OPAL = 30584; // orange, counts yellow
const INSCRIBED_ORNATE_TOPAZ = 28363; // orange, counts yellow
const JUSTICAR_SET = 626;

/** Justicar 2pc's scripted hit, large enough that a rebuild changes a gem. */
export const V_BONUS_HIT = 40;

/**
 * The set phase's DPS: 2000, each piece's own value (a copy counts as its
 * item), and each set's bonus by counted pieces (a real piece or a set-kept
 * copy): Justicar 2pc 50 and 4pc 80, Burning Rage 2pc 90. The pieces' own
 * values: Pauldrons 8, Chestguard 12, Gauntlets 6, Leggings −12.
 */
function incrementScenarioDps() {
	const value = new Map<number, number>([
		[JUSTICAR.shoulder, 8],
		[JUSTICAR.chest, 12],
		[JUSTICAR.hands, 6],
		[JUSTICAR.legs, -12],
	]);
	const bonuses: Record<number, Record<number, number>> = {
		[JUSTICAR_SET]: { 2: 50, 4: 80 },
		[BURNING_RAGE]: { 2: 90 },
	};
	return (req: RaidSimRequest): number => {
		let dps = 2000;
		const counts = new Map<number, number>();
		for (const spec of requestItems(req)) {
			if (!spec.id) continue;
			dps += value.get(realId(spec.id)) ?? 0;
			if (spec.id >= SET_LESS_OFFSET && spec.id < SET_KEPT_OFFSET) continue;
			const setId = getItem(realId(spec.id))?.setId;
			if (setId) counts.set(setId, (counts.get(setId) ?? 0) + 1);
		}
		for (const [setId, n] of counts) {
			for (const [at, bonus] of Object.entries(bonuses[setId] ?? {})) {
				if (n >= Number(at)) dps += bonus;
			}
		}
		return dps;
	};
}

/**
 * ret's worn P3 gear with Burning Rage 2pc worn (Ragesteel Shoulders holding
 * the Fire Opal, the Breastplate) and Crystalforge Greaves holding the Ornate
 * Topaz, so the meta's two yellows sit in the shoulder and legs. V6 ranks all
 * four Justicar pieces; V7 also wears the Justicar Gauntlets, so the Greaves
 * row completes Justicar 2pc. The baseline reads 31.5 rating under the cap,
 * so a default repair places Rigid where the Justicar 2pc rebuild does not.
 */
export async function incrementScenario(kind: 'V6' | 'V7') {
	const worn = retP3Worn();
	worn[SHOULDER] = { id: RAGESTEEL_SHOULDERS, gems: [ENSCRIBED_FIRE_OPAL, BOLD] };
	worn[CHEST] = { id: RAGESTEEL_BREASTPLATE, gems: [] };
	worn[SIM_ORDER.indexOf('legs')] = { id: CRYSTALFORGE_GREAVES, gems: [INSCRIBED_ORNATE_TOPAZ] };
	if (kind === 'V7') worn[HANDS] = { id: JUSTICAR.hands, gems: [] };
	expect(metaOf(socketedOf(worn)).status.kind).toBe('active');

	const baselineGearHit = gearHitRating(worn, Stat.StatMeleeHitRating);
	const baselineHitPercent = 4;
	const stats = scriptedStats({
		baselineGearHit,
		baselineHitPercent,
		bonusHit: { [JUSTICAR_SET]: V_BONUS_HIT },
	});
	const budget = hitCapBudgetFrom(capProfileFor('ret'), budgetRequest('TristateEffectImproved'), pseudoStatsWithHit(baselineHitPercent))!;
	const gems: GemContext = {
		...gemContext(gemsForPhase(3), retWeights, 'ret'),
		repairHitBudget: {
			stat: Stat.StatMeleeHitRating,
			baselineRemaining: budget.remaining,
			baselineGearHit,
		},
	};
	const pool: Array<{ itemId: number; slot: ItemSlot }> = [
		{ itemId: JUSTICAR.shoulder, slot: 'shoulder' },
		{ itemId: JUSTICAR.chest, slot: 'chest' },
		...(kind === 'V6' ? [{ itemId: JUSTICAR.hands, slot: 'hands' as const }] : []),
		{ itemId: JUSTICAR.legs, slot: 'legs' },
	];
	const run = await runSpec({
		worn,
		pool,
		measureSetBonuses: true,
		dps: incrementScenarioDps(),
		controller: new AbortController(),
		computeStats: req => Promise.resolve(stats(req)),
	});
	return { worn, gems, run };
}

export const MANA_ETCHED = { set: 658, crown: 28193, gloves: 27465 } as const;
/** Mana-Etched Regalia 2pc: +35 spell hit rating (`sim/common/tbc/items_sets.go:83-88`). */
export const MANA_ETCHED_HIT = 35;
/** ret's worn hands, 29947: no sockets, no set. */
const RET_HANDS = 29947;
export const GREAT_DAWNSTONE = 31861; // 8 spell hit, yellow
const RUNED = 24030; // Runed Living Ruby, spell damage, red

/**
 * ret's worn P3 gear with Mana-Etched Crown (holding the ret meta) and the
 * Gloves, whose Nightseye is the meta's second blue: a warlock wearing the
 * 2pc. The ret hands as a candidate break the set and turn the meta off, and
 * with warlock weights the repair puts Great Dawnstone in the boots when 8
 * spell hit rating fits the budget and a no-hit yellow when it does not.
 */
export async function warlockRun(o: {
	bonusHit: number;
	/** The candidate's budget on the run's baseline budget moved by gear hit. */
	localBudget: number;
	/** The caster ranked; defaults to warlock. */
	spec?: SpecId;
	/** See `scriptedStats`. */
	schoolBonus?: Readonly<Record<number, number>>;
	/** See `SpecRun.castDamage`. */
	castDamage?: SpellDamageBySchool;
	/** Whose EP weights repair uses; defaults to the spec's. */
	weightsOf?: SpecId;
}) {
	const spec = o.spec ?? 'warlock';
	const worn = retP3Worn();
	worn[HEAD] = { id: MANA_ETCHED.crown, gems: [RUNED, 32409] };
	worn[HANDS] = { id: MANA_ETCHED.gloves, gems: [RUNED, NIGHTSEYE] };
	expect(metaOf(socketedOf(worn)).status.kind).toBe('active');
	const weights = epWeightsFor(o.weightsOf ?? spec);
	const gems = gemContext(gemsForPhase(3), weights, spec);
	const pre = candidateSwapPreRepair(worn, HANDS, RET_HANDS, gems);
	expect(metaOf(pre.socketed).status.kind).toBe('inactive');
	const wornGearHit = gearHitRating(worn, Stat.StatSpellHitRating);
	const gearChange = gearHitRating(pre.swapped, Stat.StatSpellHitRating) - wornGearHit;
	// (16 − baseline %) × rating per % − gear change = localBudget.
	const baselineHitPercent = 16 - (o.localBudget + gearChange) / SPELL_HIT_RATING_PER_PERCENT;
	const stats = scriptedStats({
		// The baseline wears the 2pc, so its read holds the bonus.
		baselineGearHit: wornGearHit + o.bonusHit,
		baselineHitPercent,
		bonusHit: { [MANA_ETCHED.set]: o.bonusHit },
		hit: { stat: Stat.StatSpellHitRating, slot: 13, ratingPerPercent: SPELL_HIT_RATING_PER_PERCENT },
		...(o.schoolBonus ? { schoolBonus: o.schoolBonus } : {}),
	});
	const run = await runSpec({
		worn,
		pool: [{ itemId: RET_HANDS, slot: 'hands' }],
		spec,
		epWeights: weights,
		computeStats: req => Promise.resolve(stats(req)),
		...(o.castDamage ? { castDamage: o.castDamage } : {}),
	});
	const rows = run.requests.map(requestItems).filter(items => items[HANDS]?.id === RET_HANDS);
	expect(rows.length).toBeGreaterThan(0);
	return { run, rows };
}
