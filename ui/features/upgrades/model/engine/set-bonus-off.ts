/**
 * `setBonusOffSims`: for each bonus the set-bonus popover shows that loses worn bonuses, the
 * gear before it with the lost sets' replaced pieces sent as set-less copies, simmed so the
 * popover can put those losses on their own line. `measureBonusGear` calls it with the
 * gears its partner choice built.
 */

import type { RunNote } from './disclosure';
import { repairErrorOr } from './hit-budget';
import { getItem } from './items';
import { MetaRepairError } from './meta-repair';
import type { RankedItem, SetBonusOffSims } from './rank-types';
import { breakSplitSkipNote } from './run-notes';
import { type RaidSimRequest, simCacheKey, stableStringify } from './seams/sim-runner';
import type { BonusGearArgs, BonusGearBuilders, FutureBonus } from './set-bonus-gear';
import { isBuildFailure } from './set-less-copies';
import { type PlacedItem, setNameOf, type SetThreshold } from './set-value';
import { readCachedSim, type SimCounter, simEachOnce } from './sim-calls';
import type { SimItemSpec } from './slots';
import { setCreditUnmeasured, setPotentialIncrements } from './view';

/** A worn bonus a shown bonus loses. */
type BrokenBonus = { setId: number; threshold: SetThreshold };

/** What partner choice hands the bonus-off sims: each row's own swap, each bonus's partners, and the gear builders. */
export type ChosenPartners = {
	builders: BonusGearBuilders;
	rowSwapOf: ReadonlyMap<RankedItem, PlacedItem>;
	partnersOf: ReadonlyMap<FutureBonus, PlacedItem[]>;
};

/**
 * One bonus-off request per distinct gear, with the gear-before request it
 * pairs with, and each shown bonus waiting on one.
 */
type BonusOffQueue = {
	requests: Map<string, { request: RaidSimRequest; plain: RaidSimRequest }>;
	pending: Array<{
		future: FutureBonus;
		key: string;
		broken: BrokenBonus[];
	}>;
};

/**
 * The bonus-off sims of `measureBonusGear`: queues a request for each shown
 * bonus that loses worn bonuses (one per distinct gear), sims those whose
 * gear before is in the store, and writes each bonus's `bonusOffDps`.
 */
export async function measureBonusOff(args: BonusGearArgs, chosen: ChosenPartners): Promise<SetBonusOffSims> {
	// The bonus-off sims run for exactly the bonuses the popover shows, so this
	// uses the view's own list of them (`setPotentialIncrements`).
	const offCounter: SimCounter = { simmed: 0, fromStore: 0 };
	const queue: BonusOffQueue = { requests: new Map(), pending: [] };
	let skippedIncrements = await queueShownBonuses(args, chosen, queue);

	// The popover's loss line is the bonus-off sim minus the sim of the gear
	// before without copies (the previous bonus's gear, or the row's own swap).
	// Only a gear-before sim this run already holds makes that a paired
	// difference, so a request whose gear-before sim is missing is not simmed.
	const paired = new Map<string, RaidSimRequest>();
	for (const [key, { request, plain }] of queue.requests) {
		if (await readCachedSim(args.deps, plain, args.simVersion, args.runOpts)) {
			paired.set(key, request);
		}
	}
	const { deltas: offDeltas, errors: offErrors } = await simEachOnce(
		args,
		paired,
		offCounter,
		'[upgrades] increment not split into breaks and pieces: the sim failed',
	);
	for (const { future, key, broken } of queue.pending) {
		if (!paired.has(key)) {
			skippedIncrements += 1;
			continue;
		}
		const simError = offErrors.get(key);
		if (simError !== undefined) {
			pushBreakSplitNotes(args.bonusNotes, args.equipment, broken, { error: simError });
		}
		const delta = offDeltas.get(key);
		if (!delta) continue;
		future.bonusOffDps = delta.deltaDps;
		future.bonusOffSe = delta.se;
		future.bonusOff = broken;
	}

	return {
		gears: queue.requests.size,
		simmed: offCounter.simmed,
		fromStore: offCounter.fromStore,
		failedGears: offErrors.size,
		skippedIncrements,
		beforeInStore: paired.size,
	};
}

/**
 * Walks each row's shown bonuses in order and queues a bonus-off request for
 * each one that loses worn bonuses. Gives the number of those it could not
 * queue.
 */
async function queueShownBonuses(args: BonusGearArgs, chosen: ChosenPartners, queue: BonusOffQueue): Promise<number> {
	let skippedIncrements = 0;
	for (const item of args.ranked) {
		const setContext = item.setContext;
		const rowSwap = chosen.rowSwapOf.get(item);
		if (!setContext?.usesBonusGear || !rowSwap || setCreditUnmeasured(setContext)) continue;
		const increments = setPotentialIncrements(setContext, args.cutoff);
		if (!increments) continue;
		let prevSwaps: PlacedItem[] | undefined = [rowSwap];
		let firstIncrement = true;
		for (const increment of increments) {
			const f = (setContext.futureBonuses ?? []).find(x => x.threshold === increment.threshold);
			const partners = f ? chosen.partnersOf.get(f) : undefined;
			const swaps = partners ? [rowSwap, ...partners] : undefined;
			if (increment.broken.length > 0) {
				const broken = increment.broken.map(b => ({
					setId: b.setId,
					threshold: b.threshold as SetThreshold,
				}));
				const queued =
					f !== undefined &&
					swaps !== undefined &&
					prevSwaps !== undefined &&
					(await queueBonusOff(args, chosen.builders, queue, { future: f, prevSwaps, swaps, broken, firstIncrement }));
				if (!queued) skippedIncrements += 1;
			}
			prevSwaps = swaps;
			firstIncrement = false;
		}
	}
	return skippedIncrements;
}

/** Queues one shown bonus's bonus-off request; false when none can be built. */
async function queueBonusOff(
	args: BonusGearArgs,
	builders: BonusGearBuilders,
	queue: BonusOffQueue,
	shown: {
		future: FutureBonus;
		prevSwaps: readonly PlacedItem[];
		swaps: readonly PlacedItem[];
		broken: BrokenBonus[];
		firstIncrement: boolean;
	},
): Promise<boolean> {
	const { future, prevSwaps, swaps, broken, firstIncrement } = shown;
	const beforeBuild = builders.build(prevSwaps);
	const before = beforeBuild?.equipment;
	const after = builders.build(swaps)?.equipment;
	if (!beforeBuild || !before || !after) return false;
	const brokenSets = new Set(broken.map(b => b.setId));
	const prevIds = new Set(prevSwaps.map(p => p.itemId));
	const replaced = [...new Set(swaps.filter(p => !prevIds.has(p.itemId)).map(p => p.slotIndex))]
		.filter(slot => {
			const setId = setIdAt(before, slot);
			return setId !== undefined && brokenSets.has(setId);
		})
		.sort((a, b) => a - b);
	if (replaced.length === 0) return false;
	// Copying the replaced pieces must leave each lost set at its count after
	// this bonus's swaps; otherwise (a two-hander's off-hand, a repair) the
	// bonus-off gear is not the gear before minus exactly these bonuses.
	for (const setId of brokenSets) {
		const copied = replaced.filter(slot => setIdAt(before, slot) === setId).length;
		if (countOf(before, setId) - copied !== countOf(after, setId)) {
			return false;
		}
	}
	// `plain` must be the request simmed for the gear before and the bonus-off
	// request its pair, so both come from one call. For later bonuses entry 0
	// is the previous bonus's own request (the gear build is deterministic and
	// its read is cached).
	const beforeAndOffEntries = repairErrorOr(await args.requestsPerLayout(builders.rebuild(prevSwaps), beforeBuild, [{}, { setLess: replaced }]));
	// As when the gear before or after fails its repair above: the split is
	// skipped, with no line, since no call failed.
	if (beforeAndOffEntries instanceof MetaRepairError) {
		console.warn(
			'[upgrades] increment not split into breaks and pieces: the gem repair of the gear before or the bonus-off gear failed',
			beforeAndOffEntries,
		);
		return false;
	}
	const [plainEntry, offEntry] = beforeAndOffEntries;
	if (!plainEntry || !offEntry || isBuildFailure(plainEntry) || isBuildFailure(offEntry)) {
		const error = [plainEntry, offEntry].find(isBuildFailure)?.buildError;
		console.warn('[upgrades] increment not split into breaks and pieces: its request could not be built', error);
		if (error !== undefined) {
			pushBreakSplitNotes(args.bonusNotes, args.equipment, broken, { error, notBuilt: true });
		}
		return false;
	}
	const plain = plainEntry.request;
	const request = offEntry.request;
	// For the first bonus the gear before is the row's own swap, built here on
	// the run's hit budget. If entry 0 was repaired again for set-bonus hit
	// that budget misses, it differs from that build, so the split is skipped
	// rather than paired with gear gemmed another way. The candidate loop repairs
	// on the row's own stats read, so it may have simmed entry 0; this check
	// does not look for that sim.
	if (firstIncrement && stableStringify(plain) !== stableStringify(args.composeFor(before))) {
		return false;
	}
	const key = simCacheKey(request, args.simVersion, args.runOpts);
	if (!queue.requests.has(key)) queue.requests.set(key, { request, plain });
	queue.pending.push({ future, key, broken });
	return true;
}

function setIdAt(gear: readonly SimItemSpec[], slot: number): number | undefined {
	const id = gear[slot]?.id;
	return (id ? getItem(id)?.setId : undefined) ?? undefined;
}

function countOf(gear: readonly SimItemSpec[], setId: number): number {
	return gear.filter((_, slot) => setIdAt(gear, slot) === setId).length;
}

/** A `breakSplitSkipNote` for each lost worn bonus whose split did not happen. */
function pushBreakSplitNotes(
	notes: RunNote[],
	equipment: readonly SimItemSpec[],
	broken: readonly BrokenBonus[],
	skip: { error: string; notBuilt?: true },
): void {
	for (const b of broken) {
		notes.push(
			breakSplitSkipNote({
				setName: setNameOf(equipment, b.setId),
				threshold: b.threshold,
				...skip,
			}),
		);
	}
}
