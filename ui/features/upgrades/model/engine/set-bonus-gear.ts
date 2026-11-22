/**
 * `bonusGearSims`: partner choice and the sims of the full gear a set piece's row would be
 * worn in, its partners chosen. `measureBonusGear` also runs the bonus-off sims
 * (`setBonusOffSims`, in `set-bonus-off.ts`) on the gears chosen here.
 */

import type { GemContext } from './candidate-gems';
import type { Cutoff } from './cutoff';
import type { RunNote } from './disclosure';
import { type ChainBuild, chainSwapsWithRepairs } from './gear-swap';
import { isRepairFailure, type RequestsPerCopyLayout } from './hit-budget';
import { getItem } from './items';
import { MetaRepairError } from './meta-repair';
import { choosePartners, PARTNER_RULE, type PartnerPiece, partnerPool } from './partner-choice';
import type { BonusGearSims, Deps, RankedItem, SetBonusOffSims, SetBonusValue, SetContext } from './rank-types';
import { SET_BONUS_SKIP_REASONS, setBonusSkipNote, type SkipReason } from './run-notes';
import { type RaidSimRequest, simCacheKey, type SimRunOpts } from './seams/sim-runner';
import { measureBonusOff } from './set-bonus-off';
import { clearsSameGearNoise, isBuildFailure, isSimFailure } from './set-less-copies';
import {
	type BrokenSetBonus,
	brokenSetBonuses,
	type CountsAsBreak,
	type DpsSample,
	type OwnDelta,
	type PlacedItem,
	setPieceSlots,
	type SetThreshold,
} from './set-value';
import { brokenBonusWithDps } from './set-worn-ladder';
import { runCounted, type SimCounter, simEachOnce } from './sim-calls';
import type { SimItemSpec } from './slots';

export type FutureBonus = NonNullable<SetContext['futureBonuses']>[number];

/** What `measureBonusGear` reads; `measureBonusOff` reads it too. */
export type BonusGearArgs = {
	deps: Deps;
	ranked: RankedItem[];
	setBonuses: readonly SetBonusValue[];
	equipment: readonly SimItemSpec[];
	gems: GemContext;
	composeFor: (equipment: readonly SimItemSpec[]) => RaidSimRequest;
	ownDeltasByItemId: ReadonlyMap<number, OwnDelta>;
	/** `brokenBonusDpsByKey` of the set phase's `brokenSetValues`. */
	brokenBonusDpsByKey: ReadonlyMap<string, number | undefined>;
	firstSlotIndexByItemId: ReadonlyMap<number, number>;
	countsAsBreak: CountsAsBreak;
	baseline: DpsSample;
	simVersion: string;
	runOpts: SimRunOpts;
	cutoff: Cutoff;
	/** Every request here comes from it. */
	requestsPerLayout: RequestsPerCopyLayout;
	/** A line, with the sim's error, for each bonus whose partner or bonus-off sim failed. */
	bonusNotes: RunNote[];
};

/**
 * Builds the gear of a row and its partners: the current gear with the swaps
 * in slot order and the usual gem repairs. The bonus-off sims build on the
 * same gears.
 */
export type BonusGearBuilders = {
	/** The row-and-partners gear, or the error of its failed gem repair. */
	chain: (swaps: readonly PlacedItem[]) => ChainBuild | MetaRepairError;
	/** The row-and-partners gear, or undefined when a gem repair fails. */
	build: (swaps: readonly PlacedItem[]) => ChainBuild | undefined;
	rebuild: (swaps: readonly PlacedItem[]) => (g: GemContext) => ChainBuild;
};

/**
 * What partner choice leaves: one request per distinct row-and-partners
 * gear, the future bonuses waiting on each, and, for the bonus-off sims,
 * each row's own swap and each bonus's partners.
 */
type PartnerGears = {
	requests: Map<string, RaidSimRequest>;
	pending: Array<{ future: FutureBonus; key: string; setName: string }>;
	rowSwapOf: Map<RankedItem, PlacedItem>;
	partnersOf: Map<FutureBonus, PlacedItem[]>;
};

/** What partner choice shares across rows. */
type PartnerChoiceRun = {
	args: BonusGearArgs;
	builders: BonusGearBuilders;
	counter: SimCounter;
	nameOf: ReadonlyMap<number, string>;
	gears: PartnerGears;
};

/** A set row with at least one future bonus to value, and what its partner choice reads. */
type PartnerRow = {
	item: RankedItem;
	setContext: SetContext;
	ownDelta: OwnDelta;
	eligible: FutureBonus[];
	pool: PartnerPiece[];
	rowSwap: PlacedItem;
	brokenBy: (swaps: readonly PlacedItem[]) => BrokenSetBonus[];
};

const BONUS_GEAR_FAILURE = '[upgrades] set bonus gear not measured: the sim failed';

/**
 * With `measureSetBonuses`, values each set row's future bonuses by sim.
 * For each bonus above noise, `choosePartners` picks the other set pieces,
 * and the current gear plus the row plus those pieces (swapped in slot order,
 * with the usual gem repairs) is simmed once per distinct gear; its
 * `bonusGearDps` is that sim minus the baseline. A failed choice, repair or
 * sim leaves the row unmeasured and never fails the ranking. Then the
 * bonus-off sims run for the bonuses the popover shows.
 */
export async function measureBonusGear(args: BonusGearArgs): Promise<{
	bonusGearSims: BonusGearSims;
	bonusOffSims: SetBonusOffSims;
}> {
	const bonusGearCounter: SimCounter = { simmed: 0, fromStore: 0 };
	const builders = bonusGearBuilders(args.equipment, args.gems);
	const gears = await choosePartnerGears(args, builders, bonusGearCounter);

	// Identical gears are simmed once. Each task handles its own sim failure,
	// so one failed sim leaves only its own future bonuses unmeasured.
	const { deltas, errors: bonusGearErrors } = await simEachOnce(args, gears.requests, bonusGearCounter, BONUS_GEAR_FAILURE);
	for (const { future, key, setName } of gears.pending) {
		const simError = bonusGearErrors.get(key);
		if (simError !== undefined) {
			skipOnSomeRows(args.bonusNotes, setName, future.threshold, SET_BONUS_SKIP_REASONS.rowSimsFailed(simError));
		}
		const delta = deltas.get(key);
		if (!delta) continue;
		future.bonusGearDps = delta.deltaDps;
		future.bonusGearSe = delta.se;
	}

	const bonusOffSims = await measureBonusOff(args, {
		builders,
		rowSwapOf: gears.rowSwapOf,
		partnersOf: gears.partnersOf,
	});

	return {
		bonusGearSims: {
			partnerRule: PARTNER_RULE,
			gears: gears.requests.size,
			simmed: bonusGearCounter.simmed,
			fromStore: bonusGearCounter.fromStore,
		},
		bonusOffSims,
	};
}

/** A bonus some rows could not measure, and why. */
function skipOnSomeRows(bonusNotes: RunNote[], setName: string, threshold: SetThreshold, reason: SkipReason): void {
	bonusNotes.push(setBonusSkipNote({ setName, threshold, reason, onSomeRows: true }));
}

/** The row-and-partners gear builders on the current gear and the run's gems. */
function bonusGearBuilders(equipment: readonly SimItemSpec[], gems: GemContext): BonusGearBuilders {
	const inSlotOrder = (swaps: readonly PlacedItem[]) => [...swaps].sort((a, b) => a.slotIndex - b.slotIndex);
	const chain = (swaps: readonly PlacedItem[]): ChainBuild | MetaRepairError => {
		try {
			return chainSwapsWithRepairs(equipment, inSlotOrder(swaps), gems);
		} catch (err) {
			if (!(err instanceof MetaRepairError)) throw err;
			return err;
		}
	};
	return {
		chain,
		build: swaps => {
			const built = chain(swaps);
			return built instanceof MetaRepairError ? undefined : built;
		},
		rebuild: swaps => g => chainSwapsWithRepairs(equipment, inSlotOrder(swaps), g),
	};
}

/**
 * With its own gem repair, or why it could not be built: a failed gem repair
 * or a request build error.
 */
async function bonusGearRequest(args: BonusGearArgs, builders: BonusGearBuilders, swaps: readonly PlacedItem[]): Promise<RaidSimRequest | SkipReason> {
	const build = builders.chain(swaps);
	if (build instanceof MetaRepairError) {
		return SET_BONUS_SKIP_REASONS.metaOff(build.message);
	}
	const entry = (await args.requestsPerLayout(builders.rebuild(swaps), build, [{}]))[0]!;
	if (isRepairFailure(entry)) {
		return SET_BONUS_SKIP_REASONS.metaOff(entry.repairError.message);
	}
	return isBuildFailure(entry) ? SET_BONUS_SKIP_REASONS.rowsNotBuilt(entry.buildError) : entry.request;
}

const isSkipReason = (value: RaidSimRequest | SkipReason): value is SkipReason => 'because' in value;

/**
 * Partner choice for every set row with a future bonus above noise, in row
 * order: each bonus's partners, and one queued request per distinct
 * row-and-partners gear.
 */
async function choosePartnerGears(args: BonusGearArgs, builders: BonusGearBuilders, counter: SimCounter): Promise<PartnerGears> {
	const gears: PartnerGears = {
		requests: new Map(),
		pending: [],
		rowSwapOf: new Map(),
		partnersOf: new Map(),
	};
	const run: PartnerChoiceRun = {
		args,
		builders,
		counter,
		nameOf: new Map(args.ranked.map(r => [r.itemId, r.name])),
		gears,
	};
	for (const item of args.ranked) {
		const row = partnerRowOf(args, item);
		if (!row) continue;
		gears.rowSwapOf.set(item, row.rowSwap);
		for (const f of row.eligible) {
			await choosePartnersFor(run, row, f);
		}
	}
	return gears;
}

/**
 * A set row's future bonuses above noise and its partner pool, or undefined
 * when it has none. Writes the row's `singleDeltaDps` first.
 */
function partnerRowOf(args: BonusGearArgs, item: RankedItem): PartnerRow | undefined {
	const { equipment, countsAsBreak } = args;
	const setContext = item.setContext;
	if (!setContext) return undefined;
	const ownDelta = args.ownDeltasByItemId.get(item.itemId);
	if (!ownDelta) return undefined;
	setContext.singleDeltaDps = ownDelta.deltaDps;
	const eligible = (setContext.futureBonuses ?? []).filter(
		f => !f.belowNoise && f.sameGearDps !== undefined && clearsSameGearNoise(f.sameGearDps, f.sameGearSe ?? 0, args.cutoff),
	);
	if (eligible.length === 0) return undefined;

	const setId = setContext.setId;
	const wornSetSlots = new Set(setPieceSlots(equipment, setId));
	const pieces: PartnerPiece[] = [];
	for (const [itemId, slotIndex] of args.firstSlotIndexByItemId) {
		if (itemId === item.itemId || getItem(itemId)?.setId !== setId) continue;
		const delta = args.ownDeltasByItemId.get(itemId);
		if (!delta) continue;
		pieces.push({ itemId, slotIndex, ownDeltaDps: delta.deltaDps });
	}
	const pool = partnerPool({
		pieces,
		wornSetSlots,
		rowSlotIndex: ownDelta.slotIndex,
	});
	const rowSwap: PlacedItem = {
		itemId: item.itemId,
		slotIndex: ownDelta.slotIndex,
	};
	const brokenBy = (swaps: readonly PlacedItem[]) => brokenSetBonuses(equipment, swaps, setId, countsAsBreak);
	return { item, setContext, ownDelta, eligible, pool, rowSwap, brokenBy };
}

/**
 * One future bonus of a row: chooses its partners, writes its partner
 * fields, and queues its row-and-partners gear's request. A bonus whose
 * request cannot be built gets a line and no sim. With no choice, or an
 * unmeasured one (`partnerUnmeasured`), it gets no sim and no line:
 * `choosePartners` gives either only before any partner sim.
 */
async function choosePartnersFor(run: PartnerChoiceRun, row: PartnerRow, f: FutureBonus): Promise<void> {
	const { args, gears } = run;
	const { item, setContext, ownDelta, pool, rowSwap, brokenBy } = row;
	const setId = setContext.setId;
	// A partner combination whose sim fails is skipped, and the chosen
	// combination's gear is simmed below, so a failure counts for the row
	// only when no combination is chosen.
	let partnerSimFailure: SkipReason | undefined;
	const choice = await choosePartners({
		row: {
			itemId: item.itemId,
			slotIndex: ownDelta.slotIndex,
			ownDeltaDps: ownDelta.deltaDps,
		},
		setId,
		threshold: f.threshold,
		needed: f.threshold - setContext.piecesAfterSwap,
		pool,
		brokenBy,
		breakDps: (s, c) => args.brokenBonusDpsByKey.get(`${s}:${c}`),
		simGear: async partners => {
			const request = await bonusGearRequest(args, run.builders, [rowSwap, ...partners]);
			if (isSkipReason(request)) {
				partnerSimFailure ??= request;
				return undefined;
			}
			const delta = await runCounted(args, request, run.counter, BONUS_GEAR_FAILURE);
			if (!isSimFailure(delta)) return delta;
			partnerSimFailure ??= SET_BONUS_SKIP_REASONS.rowSimsFailed(delta.simError);
			return undefined;
		},
	});
	// Here a future bonus's `pieces` and `breaks` come from the partner
	// choice, so the `pathToThreshold` ones are dropped first.
	delete f.pieces;
	delete f.breaks;
	if (choice === undefined) {
		if (partnerSimFailure !== undefined) {
			skipOnSomeRows(args.bonusNotes, setContext.setName, f.threshold, partnerSimFailure);
		}
		return;
	}
	if ('unmeasured' in choice) {
		f.partnerUnmeasured = choice.unmeasured;
		return;
	}
	const slotOf = new Map<number, number>();
	for (const p of pool) {
		slotOf.set(p.itemId, p.slotIndex);
	}
	const partners: PlacedItem[] = choice.itemIds.map(itemId => ({ itemId, slotIndex: slotOf.get(itemId)! })).sort((a, b) => a.slotIndex - b.slotIndex);
	gears.partnersOf.set(f, partners);
	f.partnerRule = PARTNER_RULE;
	f.pieces = partners.map(p => ({
		itemId: p.itemId,
		name: run.nameOf.get(p.itemId) ?? String(p.itemId),
	}));
	// Every counted worn bonus this gear loses against the current gear,
	// the row's own loss included, because the popover line is a total
	// against the current gear.
	const broken = brokenBy([rowSwap, ...partners]);
	if (broken.length > 0) {
		f.breaks = broken.map(brk => brokenBonusWithDps(brk, args.brokenBonusDpsByKey));
	}
	const request = await bonusGearRequest(args, run.builders, [rowSwap, ...partners]);
	if (isSkipReason(request)) {
		skipOnSomeRows(args.bonusNotes, setContext.setName, f.threshold, request);
		return;
	}
	const key = simCacheKey(request, args.simVersion, args.runOpts);
	gears.requests.set(key, request);
	gears.pending.push({ future: f, key, setName: setContext.setName });
}
