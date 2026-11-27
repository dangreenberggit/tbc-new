/**
 * A fully controlled sim for set-bonus tests, and `runScenario`, which ranks feral gear on it.
 *
 * The fake sim's DPS is `BASE + Σ itemValue[id] + active set bonuses by piece count`, plus any
 * interaction terms and id effects a scenario adds. A set-less copy is valued as its original
 * and counts toward no set; a set-kept copy is valued as its original and keeps its set.
 * Because the model is exact, tests assert set values against literals derived from it by
 * hand, not recomputed the way the engine does. Real item ids are used as values so
 * `getItem` resolves them.
 *
 * A test module that imports this one must mock `@sim/proto/database` with
 * `database_mock.ts`, since `getItem` and the engine read items through `Database.getSync()`:
 *
 *     vi.mock('@sim/proto/database', importOriginal => import('../testing/database_mock').then(m => m.withTestDatabase(importOriginal)));
 */

import { expect } from 'vitest';

import { epWeightsFor } from '../model/data/data';
import { compose } from '../model/engine/compose';
import { getItem } from '../model/engine/items';
import type { ItemSlot } from '../model/engine/pool';
import { type PartialRanking, type Ranking, rankUpgrades } from '../model/engine/rank';
import type { RankedItem } from '../model/engine/rank-types';
import type { RaidSimRequest, SimObservation, SimRunner, SimRunOpts } from '../model/engine/seams/sim-runner';
import { MemoryStore, type Store } from '../model/engine/seams/store';
import { setPotentialIncrements } from '../model/engine/set-potential';
import type { SetScreenMode } from '../model/engine/set-screen';
import { SIM_ORDER, type SimItemSpec, type SimOrderName } from '../model/engine/slots';
import { statsOnlyItemEp, zeroHitStats } from './engine_fakes';
import feralSkeletonJson from './feral_p2.skeleton.json';
import { characterFightKey, fightGearKey, RecordedGearSource } from './recorded_gear_source';

/* ------------------------------------------------------------------ *
 * The controlled fixture
 * ------------------------------------------------------------------ */

export const SIM_VERSION = 'v0.0.101';
export const ITERATIONS = 5000;
export const BASE_DPS = 3000;

// Real set-piece ids (Thunderheart Harness 676, Malorne Harness 640), each in a
// distinct SIM_ORDER slot so a package can add several at once.
export const THUNDERHEART = {
	head: 31039, // Thunderheart Cover
	shoulder: 31048, // Thunderheart Pauldrons
	chest: 31042, // Thunderheart Chestguard
	hands: 31034, // Thunderheart Gauntlets
	legs: 31044, // Thunderheart Leggings
	wrist: 34444, // Thunderheart Wristguards
	waist: 34556, // Thunderheart Waistguard
	feet: 34573, // Thunderheart Treads
} as const;
export const MALORNE = {
	head: 29098, // Stag-Helm of Malorne
	shoulder: 29100, // Mantle of Malorne
	hands: 29097, // Gauntlets of Malorne
	legs: 29099, // Greaves of Malorne
	chest: 29096, // Breastplate of Malorne
} as const;
// Nordrassil Harness 641: only its 4pc is implemented in the sim.
export const NORDRASSIL = {
	chest: 30222, // Nordrassil Chestplate
	hands: 30223, // Nordrassil Handgrips
	head: 30228, // Nordrassil Headdress
	legs: 30229, // Nordrassil Feral-Kilt
	shoulder: 30230, // Nordrassil Feral-Mantle
} as const;
// Non-set items for the neutral vacate replacements, per slot.
export const NEUTRAL = {
	head: [10150],
	shoulder: [10153],
	hands: [10140, 10149],
	legs: [8289, 8300],
	chest: [8283, 8290],
} as const;

// The DPS model's per-item values and per-set bonuses.
export const V_TH = 100; // each Thunderheart candidate's own stat value
export const B2_TH = 50; // Thunderheart 2pc bonus
export const B4_TH = 80; // Thunderheart 4pc bonus
export const V_NEUTRAL = 120; // each neutral candidate's own value
export const B2_MAL = 40; // Malorne 2pc bonus == the broken-bonus value B under test
// Malorne 4pc. The first cases wear at most 3 Malorne, so it never fires
// there; the every-lost-threshold cases wear 4 and 5.
export const B4_MAL = 70;

/**
 * A set's model bonuses by piece count. `b3`, `b6` and `b8` are for 3-piece sets and for a
 * set with bonuses above 4 pieces.
 */
export type SetBonusTable = Record<number, { b2: number; b3?: number; b4: number; b6?: number; b8?: number }>;

export const SET_BONUSES: SetBonusTable = {
	676: { b2: B2_TH, b4: B4_TH },
	640: { b2: B2_MAL, b4: B4_MAL },
};
export const ITEM_VALUE = new Map<number, number>([
	...Object.values(THUNDERHEART).map(id => [id, V_TH] as const),
	...Object.values(NEUTRAL)
		.flat()
		.map(id => [id, V_NEUTRAL] as const),
]);

export const feralSkeleton = (): RaidSimRequest => structuredClone(feralSkeletonJson) as RaidSimRequest;
export const feralWeights = epWeightsFor('feral');

/** Equipped item ids of a composed request, in slot order. */
export function equippedIds(req: RaidSimRequest): number[] {
	const raid = (req as { raid?: { parties?: unknown[] } }).raid;
	const party = raid?.parties?.[0] as { players?: unknown[] } | undefined;
	const player = party?.players?.[0] as { equipment?: { items?: Array<{ id?: number }> } } | undefined;
	return (player?.equipment?.items ?? []).map(i => i?.id ?? 0);
}

/**
 * The engine's set-less copy id offset (`SET_LESS_ID_OFFSET`). A literal here so the model
 * does not read the code under test; a copies test checks that the two agree.
 */
export const COPY_OFFSET = 1_000_000;

/** The error a compose that `composeFailsWhen` matches throws. */
export const MODEL_COMPOSE_ERROR = 'the model compose failed on purpose';

/** The error every failed sim of `failWhen` gives (`runScenario`). */
export const MODEL_SIM_ERROR = 'the model sim failed on purpose';

/** The ranking's set-phase lines: a set bonus, or a set the screen kept. */
export const setSkipLines = (ranking: ScenarioRanking) => ranking.substitutions.filter(s => /( set bonus| set)$/.test(s.field));

/** The line for a set the screen kept because its sim failed. */
export const screenFailedLine = {
	field: expect.stringMatching(/ set$/),
	detail: expect.stringMatching(new RegExp(`^The .+ set was kept without the quick check that can skip it, because the check's sim failed\\.$`)),
	error: MODEL_SIM_ERROR,
};

/**
 * The line for a worn-set ladder sim that failed, with any stack trace after the error
 * (`Scenario.failStack`).
 */
export const wornSetFailedLine = {
	field: expect.stringMatching(/ set$/),
	detail: expect.stringMatching(new RegExp(`^The value of the .+ set on your gear was not fully measured, because its sim failed\\.$`)),
	error: expect.stringMatching(new RegExp(`^${MODEL_SIM_ERROR}(\n[\\s\\S]*)?$`)),
};

/** The line for a set bonus the run did not measure because a sim failed. */
export const simFailedLine = (threshold: number, onSomeRows = false) => ({
	field: expect.stringMatching(new RegExp(` ${threshold}-piece set bonus$`)),
	detail: expect.stringMatching(
		new RegExp(
			`^The .+ ${threshold}-piece set bonus was not measured${onSomeRows ? ' on some rows, because their sim failed' : ', because its sim failed'}\\.$`,
		),
	),
	error: MODEL_SIM_ERROR,
});

/**
 * The line for an increment whose bonus-off sim failed: the increment is still measured, but
 * its break is not split from its pieces.
 */
export const breakSplitFailedLine = (threshold: number) => ({
	field: expect.stringMatching(new RegExp(` ${threshold}-piece set bonus$`)),
	detail: expect.stringMatching(
		new RegExp(
			`^On some rows, the cost of breaking the .+ ${threshold}-piece set bonus was not measured apart from the pieces that break it, because their sim failed\\.$`,
		),
	),
	error: MODEL_SIM_ERROR,
});

/**
 * The engine's set-kept copy id offset (`SET_KEPT_ID_OFFSET`): a copy that keeps its set. A
 * literal for the same reason as `COPY_OFFSET`.
 */
export const SET_KEPT_OFFSET = 2_000_000;

/**
 * A term the model adds when every listed item is worn, standing in for stats that are worth
 * more together than apart. Keyed by original ids: a set-less copy counts as its original here.
 */
export type Interaction = { ids: readonly number[]; dps: number };

type SetIdOf = (id: number) => number | null | undefined;

/**
 * The controlled DPS: base + own values + active set bonuses + interaction terms + id
 * effects. A set-less copy (id in [`COPY_OFFSET`, `SET_KEPT_OFFSET`)) has its original's value
 * and belongs to no set. A set-kept copy (id at or above `SET_KEPT_OFFSET`) has its original's
 * value and set. An id effect stands in for a Go effect keyed by item id
 * (`itemEffects[eq.ID]`, `RegisterPvPGloveMod`): only the real id gets it, never a copy.
 */
export function modelDps(
	ids: readonly number[],
	getSetId: SetIdOf,
	itemValue: ReadonlyMap<number, number> = ITEM_VALUE,
	setBonuses: SetBonusTable = SET_BONUSES,
	interactions: readonly Interaction[] = [],
	idEffects: ReadonlyMap<number, number> = new Map(),
): number {
	let dps = BASE_DPS;
	const setCounts = new Map<number, number>();
	const worn = new Set<number>();
	for (const id of ids) {
		if (!id) continue;
		const setKept = id >= SET_KEPT_OFFSET;
		const setLess = !setKept && id >= COPY_OFFSET;
		const original = setKept ? id - SET_KEPT_OFFSET : setLess ? id - COPY_OFFSET : id;
		worn.add(original);
		dps += itemValue.get(original) ?? 0;
		if (!setKept && !setLess) dps += idEffects.get(id) ?? 0;
		const setId = setLess ? undefined : getSetId(original);
		if (setId != null) setCounts.set(setId, (setCounts.get(setId) ?? 0) + 1);
	}
	for (const [setId, count] of setCounts) {
		const bonus = setBonuses[setId];
		if (!bonus) continue;
		if (count >= 2) dps += bonus.b2;
		if (count >= 3) dps += bonus.b3 ?? 0;
		if (count >= 4) dps += bonus.b4;
		if (count >= 6) dps += bonus.b6 ?? 0;
		if (count >= 8) dps += bonus.b8 ?? 0;
	}
	for (const term of interactions) {
		if (term.ids.every(id => worn.has(id))) dps += term.dps;
	}
	return dps;
}

/**
 * The model's active set bonuses in the sim's own form, `<set> (<n>pc)`
 * (`GetActiveSetBonusNames`, sim/core/item_sets.go): a count is a bonus when the set's table
 * names it, whatever its value. Real pieces and set-kept copies count; set-less copies do not.
 */
export function modelSetBonusNames(ids: readonly number[], getSetId: SetIdOf, setBonuses: SetBonusTable = SET_BONUSES): string[] {
	const setCounts = new Map<number, number>();
	for (const id of ids) {
		if (!id) continue;
		const setKept = id >= SET_KEPT_OFFSET;
		if (!setKept && id >= COPY_OFFSET) continue;
		const setId = getSetId(setKept ? id - SET_KEPT_OFFSET : id);
		if (setId != null) setCounts.set(setId, (setCounts.get(setId) ?? 0) + 1);
	}
	const names: string[] = [];
	for (const [setId, count] of [...setCounts].sort((a, b) => a[0] - b[0])) {
		const bonus = setBonuses[setId];
		if (!bonus) continue;
		for (const [n, value] of [
			[2, bonus.b2],
			[3, bonus.b3],
			[4, bonus.b4],
			[6, bonus.b6],
			[8, bonus.b8],
		] as const) {
			if (value !== undefined && count >= n) names.push(`set ${setId} (${n}pc)`);
		}
	}
	return names;
}

export const FERAL_CHAR = { region: 'US' as const, realm: 'test', name: 'netcase' };
export const FERAL_SUMMARY = {
	reportCode: 'net001',
	fightId: 1,
	encounterName: 'Test Dummy',
	killedAt: '2026-09-20T00:00:00.000Z',
	route: 'ranked' as const,
	confidence: 1,
};

export type WornSpec = { id: number; slot: SimOrderName };
export type PoolSpec = { itemId: number; slot: ItemSlot };

/** What a `runScenario` run returns: a full ranking, or a partial one after a Stop. */
export type ScenarioRanking = Ranking | PartialRanking;
export type ScenarioRow = RankedItem;

export type Scenario = {
	worn: WornSpec[];
	pool: PoolSpec[];
	measureSetBonuses?: boolean;
	/** Overrides the model's per-item values for this scenario only. */
	itemValue?: ReadonlyMap<number, number>;
	/** Overrides the model's per-set bonuses for this scenario only. */
	setBonuses?: SetBonusTable;
	/** Interaction terms for this scenario only. */
	interactions?: readonly Interaction[];
	/** Id effects for this scenario only. */
	idEffects?: ReadonlyMap<number, number>;
	/** The fake sim throws for a request whose equipped ids (and options) match. */
	failWhen?: (ids: readonly number[], opts: SimRunOpts) => boolean;
	/** Text after the thrown error, by sim call, as a Go panic's stack trace differs from sim to sim. */
	failStack?: (call: number) => string;
	/** `Deps.setScreenMode`; absent means off. */
	setScreenMode?: SetScreenMode;
	/** A store shared between runs, to see what the ranking cache serves. */
	store?: Store;
	/** The 0-based fake sim call during which the run's Stop fires. */
	stopDuringCall?: number;
	/**
	 * `RankInput.seeds`; absent means one seed, 11. `"engine-default"` sends no `seeds`, so the
	 * engine picks its default.
	 */
	seeds?: number[] | 'engine-default';
	/** `RankInput.iterations`; absent means `ITERATIONS`. */
	iterations?: number;
	/** The fake runner also answers `activeSetBonuses` from the scenario's set table, as the worker runner answers it from the sim. */
	reportsSetBonuses?: boolean;
	/** The 0-based `activeSetBonuses` call during which the run's Stop fires. */
	stopDuringSetBonusRead?: number;
	/** The fake's `activeSetBonuses` rejects for gear whose equipped ids match. */
	failSetBonusReadWhen?: (ids: readonly number[]) => boolean;
	/**
	 * Gives each request a database with a row for every worn item except these, so a copy of
	 * one of them cannot be built.
	 */
	databaseWithout?: readonly number[];
	/**
	 * For gear whose equipped ids are given, the items whose database rows are left out, so a
	 * copy of one of them cannot be built.
	 */
	databaseOmits?: (ids: readonly number[]) => readonly number[];
	/** Composing a request for gear whose equipped ids match throws. */
	composeFailsWhen?: (ids: readonly number[]) => boolean;
	/** `Deps.concurrency`. With it the fake sim answers a macrotask later, so sims the engine sends together are in flight together. */
	concurrency?: number;
	/** With `concurrency`, extra milliseconds before a sim answers, so a test can make one set's sims finish after another's. */
	extraDelayMs?: (ids: number[]) => number;
};

export type ScenarioRun = {
	ranking: ScenarioRanking;
	runCount: number;
	/** The equipped ids of each request the fake sim ran, in call order. */
	calls: number[][];
	/** The options of each of those requests, in the same order. */
	callOpts: SimRunOpts[];
	/** Each of those requests, as the fake sim received it. */
	requests: RaidSimRequest[];
	/** For each `activeSetBonuses` call, how many sims had run before it. */
	setBonusReadRuns: number[];
	/** For each fake sim call, how many sims were in flight once it started. */
	inFlightAtStart: number[];
	/** For each fake sim call, the stack it was made from. */
	stackAtStart: string[];
};

const getSetId = (id: number): number | null | undefined => getItem(id)?.setId;

export async function runScenario(scenario: Scenario): Promise<ScenarioRun> {
	// The fake sim answers in microtasks, so without this the file never gives the event loop
	// back. Since every feral run reads hit, the file runs for minutes, and vitest's worker
	// reported `Timeout calling "onTaskUpdate"`. `setImmediate`, not `setTimeout`: only the
	// former lets the loop read the worker's pending messages first.
	await new Promise(resolve => setImmediate(resolve));

	const loggedGear = {
		items: scenario.worn.map(w => ({ id: w.id, slot: w.slot, gems: [] })),
		talentPointsByTree: [0, 45, 16] as [number, number, number],
		provenance: {
			reportCode: FERAL_SUMMARY.reportCode,
			fightId: FERAL_SUMMARY.fightId,
			sourceID: 1,
		},
	};
	const fightRef = {
		reportCode: FERAL_SUMMARY.reportCode,
		fightId: FERAL_SUMMARY.fightId,
	};
	const gearSource = new RecordedGearSource({
		fights: new Map([[characterFightKey(FERAL_CHAR, 'feral'), [FERAL_SUMMARY]]]),
		gear: new Map([[fightGearKey(fightRef), loggedGear]]),
	});

	const pool = scenario.pool.map(p => ({
		itemId: p.itemId,
		name: `item ${p.itemId}`,
		slot: p.slot,
		phase: 1,
		source: { kind: 'badge' as const, cost: 1 },
	}));

	let runCount = 0;
	let inFlight = 0;
	const inFlightAtStart: number[] = [];
	const stackAtStart: string[] = [];
	const calls: number[][] = [];
	const callOpts: SimRunOpts[] = [];
	const requests: RaidSimRequest[] = [];
	const setBonusReadRuns: number[] = [];
	const controller = scenario.stopDuringCall === undefined && scenario.stopDuringSetBonusRead === undefined ? undefined : new AbortController();
	const sim: SimRunner = {
		version: () => Promise.resolve(SIM_VERSION),
		computeStats: zeroHitStats,
		run: (req: RaidSimRequest, opts: SimRunOpts): Promise<SimObservation> => {
			runCount += 1;
			if (scenario.concurrency !== undefined) {
				inFlight += 1;
				inFlightAtStart.push(inFlight);
				// Which engine step sent the sim: its async callers are in the stack, below
				// more frames than the default limit of 10 keeps.
				const limit = Error.stackTraceLimit;
				Error.stackTraceLimit = 100;
				stackAtStart.push(new Error().stack ?? '');
				Error.stackTraceLimit = limit;
			}
			const ids = equippedIds(req);
			calls.push(ids);
			callOpts.push({ ...opts });
			requests.push(structuredClone(req));
			if (runCount - 1 === scenario.stopDuringCall) controller?.abort();
			// Of each five sims, a later one answers sooner, so sims finish in a different
			// order than they started, as browser workers can.
			const delayMs = 2 * (5 - (runCount % 5)) + (scenario.extraDelayMs?.(ids) ?? 0);
			const answer = <T>(settle: () => T): Promise<T> =>
				scenario.concurrency === undefined
					? new Promise(resolve => resolve(settle()))
					: new Promise((resolve, reject) =>
							setTimeout(() => {
								inFlight -= 1;
								try {
									resolve(settle());
								} catch (err) {
									reject(err);
								}
							}, delayMs),
						);
			if (scenario.failWhen?.(ids, opts)) {
				const error = new Error(MODEL_SIM_ERROR + (scenario.failStack?.(runCount) ?? ''));
				return answer(() => {
					throw error;
				});
			}
			const dps = modelDps(ids, getSetId, scenario.itemValue, scenario.setBonuses, scenario.interactions, scenario.idEffects);
			// Per-iteration values only when asked, as the worker runner does: the model is
			// exact, so every iteration reads the model DPS.
			const observation: SimObservation = {
				dps,
				stdev: 30,
				iterationsDone: opts.iterations,
				simVersion: SIM_VERSION,
				...(opts.saveAllValues === true ? { allValues: new Array<number>(opts.iterations).fill(dps) } : {}),
			};
			return answer(() => observation);
		},
		...(scenario.reportsSetBonuses
			? {
					activeSetBonuses: (req: RaidSimRequest): Promise<string[]> => {
						const ids = equippedIds(req);
						setBonusReadRuns.push(runCount);
						if (setBonusReadRuns.length - 1 === scenario.stopDuringSetBonusRead) controller?.abort();
						if (scenario.failSetBonusReadWhen?.(ids)) {
							return Promise.reject(new Error('the set-bonus read failed on purpose'));
						}
						return Promise.resolve(modelSetBonusNames(ids, getSetId, scenario.setBonuses));
					},
				}
			: {}),
	};

	const input = {
		character: FERAL_CHAR,
		spec: 'feral' as const,
		maxPhase: 5 as const,
		fight: fightRef,
		iterations: scenario.iterations ?? ITERATIONS,
		...(scenario.seeds === 'engine-default' ? {} : { seeds: scenario.seeds ?? [11] }),
		candidateCap: 100,
	};

	const ranking = await rankUpgrades(input, {
		gear: gearSource,
		sim,
		store: scenario.store ?? new MemoryStore(),
		clock: () => new Date('2026-09-20T12:00:00.000Z'),
		raidSimSkeleton: feralSkeleton(),
		epWeights: feralWeights,
		itemEp: statsOnlyItemEp(feralWeights),
		pool,
		...(scenario.measureSetBonuses ? { measureSetBonuses: true } : {}),
		...(scenario.setScreenMode ? { setScreenMode: scenario.setScreenMode } : {}),
		...(controller ? { signal: controller.signal } : {}),
		...(scenario.concurrency === undefined ? {} : { concurrency: scenario.concurrency }),
		...(scenario.databaseWithout || scenario.databaseOmits || scenario.composeFailsWhen
			? {
					simDatabaseFor: (equipment: readonly SimItemSpec[]) => {
						const ids = equipment.map(spec => spec.id ?? 0);
						if (scenario.composeFailsWhen?.(ids)) {
							throw new Error(MODEL_COMPOSE_ERROR);
						}
						const left = [...(scenario.databaseWithout ?? []), ...(scenario.databaseOmits?.(ids) ?? [])];
						return {
							items: equipment.filter(spec => spec.id && !left.includes(spec.id)).map(spec => ({ id: spec.id })),
						};
					},
				}
			: {}),
	});

	return {
		ranking,
		runCount,
		calls,
		callOpts,
		requests,
		setBonusReadRuns,
		inFlightAtStart,
		stackAtStart,
	};
}

/** A full 17-slot worn set, some slots filled by the given specs. */
export function wornGear(filled: Partial<Record<SimOrderName, number>>): WornSpec[] {
	return SIM_ORDER.map(slot => ({ id: filled[slot] ?? 0, slot }));
}

/** The Thunderheart pool candidates for the five slots this fixture uses. */
export const TH_POOL: PoolSpec[] = [
	{ itemId: THUNDERHEART.head, slot: 'head' },
	{ itemId: THUNDERHEART.shoulder, slot: 'shoulder' },
	{ itemId: THUNDERHEART.chest, slot: 'chest' },
	{ itemId: THUNDERHEART.hands, slot: 'hands' },
	{ itemId: THUNDERHEART.legs, slot: 'legs' },
];

export const near = (a: number, b: number, tol = 0.01): boolean => Math.abs(a - b) <= tol;

/** Asserts `actual` is within `tol` of `expected`; a failure prints both numbers. */
export function expectNear(actual: number, expected: number, tol = 0.01): void {
	expect(Math.abs(actual - expected), `expected ${actual} to be within ${tol} of ${expected}`).toBeLessThanOrEqual(tol);
}

export function thRow(ranking: ScenarioRanking, itemId: number): ScenarioRow {
	const row = ranking.items.find(i => i.itemId === itemId);
	if (!row) throw new Error(`row ${itemId} not found`);
	return row;
}

/* ------------------------------------------------------------------ *
 * Helpers that tests in more than one module read
 * ------------------------------------------------------------------ */

/** The view's cutoff in these tests. */
export const FLOOR = { absDps: 5 };

/** The ranking as `applyView` takes it; a scenario never stops, so a partial one is a bug. */
export function completeRanking(ranking: ScenarioRanking): Ranking {
	if (!ranking.complete) throw new Error('the scenario returned a partial ranking');
	return ranking;
}

/** Runs a scenario with the set measurement off and on, for the sim-count invariant. */
export async function runOffOn(scenario: Omit<Scenario, 'measureSetBonuses'>): Promise<{ off: ScenarioRun; on: ScenarioRun }> {
	const off = await runScenario(scenario);
	const on = await runScenario({ ...scenario, measureSetBonuses: true });
	return { off, on };
}

export function bsvDps(ranking: ScenarioRanking, setId: number, threshold: number): number | undefined {
	return (ranking.brokenSetValues ?? []).find(b => b.setId === setId && b.threshold === threshold)?.dps;
}

export function netOf(ranking: ScenarioRanking, setId: number, threshold: number): number | undefined {
	return (ranking.setBonuses ?? []).find(b => b.setId === setId && b.threshold === threshold)?.bonusDpsNet;
}

export function bonusOf(ranking: ScenarioRanking, setId: number, threshold: number) {
	return (ranking.setBonuses ?? []).find(b => b.setId === setId && b.threshold === threshold);
}

export const brk = (b: { setId: number; threshold: number; dps?: number }) => ({
	setId: b.setId,
	threshold: b.threshold,
	dps: b.dps === undefined ? undefined : Math.round(b.dps),
});

export const fut = (f: { threshold: number; piecesNeeded: number; dps?: number }) => ({
	threshold: f.threshold,
	piecesNeeded: f.piecesNeeded,
	dps: f.dps === undefined ? undefined : Math.round(f.dps),
});

export const futB = (f: {
	threshold: number;
	piecesNeeded: number;
	dps?: number;
	breaks?: ReadonlyArray<{ setId: number; threshold: number; dps?: number }>;
}) => ({ ...fut(f), breaks: (f.breaks ?? []).map(brk) });

export const sortedIds = (ids: readonly number[] | undefined) => [...(ids ?? [])].sort((a, b) => a - b);

/** A row's future bonus at `threshold`. */
export const futureOf = (row: ScenarioRow, threshold: number) => (row.setContext?.futureBonuses ?? []).find(f => f.threshold === threshold);

/** A worn gear's equipped ids in slot order, as the fake sim records them. */
export const idsOf = (filled: Partial<Record<SimOrderName, number>>): number[] => SIM_ORDER.map(slot => filled[slot] ?? 0);

/** Item values with the listed overrides. */
export function withValues(pairs: ReadonlyArray<readonly [number, number]>): Map<number, number> {
	const values = new Map(ITEM_VALUE);
	for (const [id, v] of pairs) values.set(id, v);
	return values;
}

/** Item values with each listed id at a Thunderheart piece's value. */
export function withSetValues(ids: readonly number[]): Map<number, number> {
	return withValues(ids.map(id => [id, V_TH] as const));
}

/** A row's set-piece entry as the engine lists it, `dps` only when given. */
export const piece = (itemId: number, name: string, dps?: number) => ({
	itemId,
	name,
	...(dps !== undefined ? { dps } : {}),
});

/** Pool entries for a set's pieces, one per slot. */
export const setPool = (set: Readonly<Partial<Record<ItemSlot, number>>>): PoolSpec[] =>
	(Object.entries(set) as Array<[ItemSlot, number]>).map(([slot, itemId]) => ({ itemId, slot }));

/** A composed 17-slot request wearing `filled`, with an optional database. */
export function composedRequest(filled: Partial<Record<SimOrderName, number>>, database?: Record<string, unknown>): RaidSimRequest {
	return compose(feralSkeleton(), {
		name: 'netcase',
		race: 'RaceTauren',
		equipment: wornGear(filled).map(w => ({ id: w.id, gems: [] })),
		...(database ? { database } : {}),
	});
}

/**
 * Checks that every split increment of the ranking's rows adds up to its increment value, and
 * returns how many split increments there are.
 */
export function expectSplitLinesAddUp(ranking: ScenarioRanking): number {
	let split = 0;
	for (const row of ranking.items) {
		for (const s of setPotentialIncrements(row.setContext, FLOOR) ?? []) {
			if (s.breaksLineDps === undefined) continue;
			split += 1;
			expect(Math.abs(s.breaksLineDps + s.piecesLineDps! - s.dps)).toBeLessThanOrEqual(1e-9);
		}
	}
	return split;
}

export const HANDS_SLOT = SIM_ORDER.indexOf('hands');
export const LEGS_SLOT = SIM_ORDER.indexOf('legs');
export const SHOULDER_SLOT = SIM_ORDER.indexOf('shoulder');
export const CHEST_SLOT = SIM_ORDER.indexOf('chest');

// Worn Malorne head, shoulder, chest, hands; Thunderheart and neutral candidates in exactly
// those four slots.
export const MALORNE_4 = {
	head: MALORNE.head,
	shoulder: MALORNE.shoulder,
	chest: MALORNE.chest,
	hands: MALORNE.hands,
} as const;
export const TH_OVER_MALORNE_POOL: PoolSpec[] = [
	{ itemId: THUNDERHEART.head, slot: 'head' },
	{ itemId: THUNDERHEART.shoulder, slot: 'shoulder' },
	{ itemId: THUNDERHEART.chest, slot: 'chest' },
	{ itemId: THUNDERHEART.hands, slot: 'hands' },
	{ itemId: NEUTRAL.head[0], slot: 'head' },
	{ itemId: NEUTRAL.shoulder[0], slot: 'shoulder' },
	{ itemId: NEUTRAL.chest[0], slot: 'chest' },
	{ itemId: NEUTRAL.hands[0], slot: 'hands' },
];
export const TH_FOUR_IDS = [THUNDERHEART.head, THUNDERHEART.shoulder, THUNDERHEART.chest, THUNDERHEART.hands];

// Thunderheart hands + legs worn (676 at 2); neutral hands and legs so B(676,2) can be measured.
export const TH_HANDS_LEGS = wornGear({
	hands: THUNDERHEART.hands,
	legs: THUNDERHEART.legs,
});
export const NEUTRAL_HANDS_LEGS: PoolSpec[] = [
	{ itemId: NEUTRAL.hands[0], slot: 'hands' },
	{ itemId: NEUTRAL.legs[0], slot: 'legs' },
];

/** Malorne candidates over worn Thunderheart hands and legs, with the set measurement off and on. */
export async function runMalorneOverThunderheart2pc(setBonuses?: SetBonusTable) {
	return runOffOn({
		worn: TH_HANDS_LEGS,
		pool: [...setPool(MALORNE), ...NEUTRAL_HANDS_LEGS],
		itemValue: withSetValues(Object.values(MALORNE)),
		...(setBonuses ? { setBonuses } : {}),
	});
}

// Thunderheart in four slots the meta gem does not touch (the Cover's meta socket cannot be
// activated over this gemless gear, so the engine can drop it).
export const TH_FOUR_POOL: PoolSpec[] = [
	{ itemId: THUNDERHEART.shoulder, slot: 'shoulder' },
	{ itemId: THUNDERHEART.chest, slot: 'chest' },
	{ itemId: THUNDERHEART.hands, slot: 'hands' },
	{ itemId: THUNDERHEART.legs, slot: 'legs' },
];
export const TH_FOUR = [THUNDERHEART.shoulder, THUNDERHEART.chest, THUNDERHEART.hands, THUNDERHEART.legs];

// Wastewalker Armor 659 (leather; Go bonuses at 2 and 4).
export const WASTEWALKER = {
	shoulder: 27797,
	chest: 28264,
	hands: 27531,
	legs: 27837,
} as const;
// Primal Intent 619 (leather; one Go bonus, at 3).
export const PRIMAL_INTENT = { chest: 29525, wrist: 29527, waist: 29526 } as const;
// Gladiator's Pursuit 586 (hunter PvP); 28335 is in `pvpGloveItemIDs`.
export const PURSUIT = { chest: 28334, hands: 28335 } as const;
// Cryptstalker Armor 530 (hunter T3; Go bonuses at 2, 4, 6 and 8).
export const CRYPTSTALKER = {
	head: 22438,
	shoulder: 22439,
	chest: 22436,
	wrist: 22443,
	hands: 22441,
	waist: 22442,
	legs: 22437,
	feet: 22440,
} as const;
// Justicar Battlegear 626 (ret plate). The Breastplate stands in for the Crown, whose meta
// socket the engine cannot fill over gemless gear.
export const JUSTICAR = {
	chest: 29071,
	shoulder: 29075,
	hands: 29072,
	legs: 29074,
} as const;
// Crystalforge Battlegear 629 (ret plate).
export const CRYSTALFORGE = { chest: 30129, hands: 30130, legs: 30132 } as const;

/** Thunderheart 2pc 50 and 4pc 80, with four pieces worn together worth −40. */
export const R_SCENARIO: Scenario = {
	worn: wornGear({}),
	pool: TH_FOUR_POOL,
	interactions: [{ ids: TH_FOUR, dps: -40 }],
	measureSetBonuses: true,
};

// Worn Malorne shoulder and chest, model 2pc 90. Own values chosen so the singles are the
// feral P2 BiS figures: Gauntlets +6, Leggings −12, Pauldrons 8 − 90 = −82,
// Chestguard 12 − 90 = −78.
export const PS_SCENARIO: Scenario = {
	worn: wornGear({ shoulder: MALORNE.shoulder, chest: MALORNE.chest }),
	pool: TH_FOUR_POOL,
	setBonuses: { ...SET_BONUSES, 640: { b2: 90, b4: 0 } },
	itemValue: withValues([
		[THUNDERHEART.shoulder, 8],
		[THUNDERHEART.chest, 12],
		[THUNDERHEART.hands, 6],
		[THUNDERHEART.legs, -12],
	]),
	measureSetBonuses: true,
};

// Worn: Thunderheart Gauntlets (Thunderheart at 1) and Malorne shoulder and chest (Malorne
// 2pc, so the worn-set ladder runs). Pool: the Thunderheart Pauldrons, Chestguard and
// Leggings, so Thunderheart reaches 4 and has a crossing check (the Leggings fill a slot
// Thunderheart does not).
export const SR_SCENARIO: Scenario = {
	worn: wornGear({
		hands: THUNDERHEART.hands,
		shoulder: MALORNE.shoulder,
		chest: MALORNE.chest,
	}),
	pool: [
		{ itemId: THUNDERHEART.shoulder, slot: 'shoulder' },
		{ itemId: THUNDERHEART.chest, slot: 'chest' },
		{ itemId: THUNDERHEART.legs, slot: 'legs' },
	],
	measureSetBonuses: true,
	// The production runner always reads the active bonuses.
	reportsSetBonuses: true,
};

/** Gear for the Stop tests, by name. */
export const STOP_SCENARIOS: ReadonlyArray<readonly [string, Scenario]> = [
	['the screen-run gear, screen on', { ...SR_SCENARIO, setScreenMode: 'on' }],
	[
		'one worn Thunderheart piece, flag and screen on',
		{
			worn: wornGear({ hands: THUNDERHEART.hands }),
			pool: TH_POOL.filter(p => p.slot !== 'hands'),
			measureSetBonuses: true,
			setScreenMode: 'on',
			reportsSetBonuses: true,
		},
	],
	[
		'worn Malorne hands and legs, flag on',
		{
			worn: wornGear({ hands: MALORNE.hands, legs: MALORNE.legs }),
			pool: [...TH_POOL, { itemId: NEUTRAL.hands[0], slot: 'hands' }, { itemId: NEUTRAL.legs[0], slot: 'legs' }],
			measureSetBonuses: true,
			reportsSetBonuses: true,
		},
	],
];

export type SweepSlot = 'head' | 'shoulder' | 'chest' | 'hands' | 'legs';

// Thunderheart is added in the order of the live sweep's gear (hands, legs, chest,
// shoulders); every other slot of the five wears a neutral piece.
export const SWEEP_TH_ORDER: readonly SweepSlot[] = ['hands', 'legs', 'chest', 'shoulder'];

// The Malorne and Nordrassil 4pc are worth far more than any 2pc (40) or any break (at most
// 50 + 80), so the 4pc is the credited bonus at every worn count and each row's 4pc
// increment is printed.
export const MALORNE_2PC_DPS = 40;
export const MALORNE_4PC_DPS = 400;
export const NORDRASSIL_4PC_DPS = 400;
export const SWEEP_BONUSES: SetBonusTable = {
	676: { b2: B2_TH, b4: B4_TH },
	640: { b2: MALORNE_2PC_DPS, b4: MALORNE_4PC_DPS },
	641: { b2: 0, b4: NORDRASSIL_4PC_DPS },
};
