/**
 * Which counts each set can reach and with which pieces (`setReach`), the piece counts above
 * the worn count at which the sim has a bonus the pool can reach (`setBonusCountsInReach`),
 * and whether one more piece of a worn set reaches a bonus (`measureCrossingChecks`, the
 * `Ranking`'s `crossingChecks`).
 */

import { type ChainBuild, chainSwapsWithRepairs } from './gear-swap';
import { repairErrorOr, requestOf } from './hit-budget';
import { getItem } from './items';
import { MetaRepairError } from './meta-repair';
import { type PoolEntry, simSlotsForPoolSlot } from './pool';
import type { CrossingCheck } from './rank-types';
import { SET_BONUS_SKIP_REASONS, setBonusCountsSkipNote, type SkipReason } from './run-notes';
import { bonusNotMeasured } from './set-bonus-values';
import { clearsSameGearNoise, errorText, isBuildFailure, isSimFailure, measureSameGearBonus } from './set-less-copies';
import type { SampleRunnerFor, SetPhaseContext } from './set-phase';
import {
	type AddedPiecesResult,
	bonusCountOf,
	type OwnDelta,
	type PlacedItem,
	selectAddedPieces,
	setCounts,
	setNameOf,
	setPieceSlots,
	type SetThreshold,
} from './set-value';
import { StopRefusedSim } from './sim-calls';
import { SIM_ORDER, type SimItemSpec } from './slots';

/** Which counts each set can reach, and with which pieces. */
export type SetReach = {
	/** Every set with a piece among the candidates, in pool order. */
	readonly setIdsWithCandidates: ReadonlySet<number>;
	/** The pieces of each set the player wears. */
	readonly wornCounts: ReadonlyMap<number, number>;
	/** The pieces added to reach `threshold`, chosen by `selectAddedPieces`. */
	readonly selectFor: (setId: number, threshold: SetThreshold) => AddedPiecesResult;
	/** With `measureSetBonuses`: the counts at which each set has a bonus, as the sim lists them. */
	readonly bonusCounts: ReadonlyMap<number, ReadonlySet<number>>;
	/** The counts in reach at which the set has a bonus. */
	readonly reachableCounts: (setId: number, piecesWorn: number) => SetThreshold[];
	/**
	 * The first SIM_ORDER slot each item fits; nothing is compared. For
	 * `applySetContext` to find each row's losses.
	 */
	readonly firstSlotIndexByItemId: Map<number, number>;
};

/**
 * Which sets the candidates hold pieces of, the pieces each adds at each
 * count, and the counts at which the sim lists a bonus. Its only sim calls
 * are `setBonusCountsInReach`'s bonus reads.
 */
export async function setReach(ctx: SetPhaseContext, nameOfSet: (setId: number) => string): Promise<SetReach> {
	const { candidates, equipment, input, ownDeltasByItemId, setCheckNotes, measureSetBonuses } = ctx;
	const setIdsWithCandidates = new Set<number>();
	for (const entry of candidates) {
		const setId = getItem(entry.itemId)?.setId;
		if (setId != null) setIdsWithCandidates.add(setId);
	}

	const wornCounts = setCounts(equipment);
	const slotIndexForPoolEntry = (entry: PoolEntry): number | undefined => {
		for (const slotName of simSlotsForPoolSlot(entry.slot, input.spec, entry.itemId)) {
			const idx = SIM_ORDER.indexOf(slotName);
			if (idx >= 0) return idx;
		}
		return undefined;
	};

	const selectFor = (setId: number, threshold: SetThreshold) =>
		selectAddedPieces(setId, threshold, equipment, candidates, [...ownDeltasByItemId.values()], slotIndexForPoolEntry);
	// Every count from one above the worn count up to the most pieces the pool
	// can fill, each with the pieces added to reach it.
	const addedByCount = (setId: number, piecesWorn: number) => {
		const out: Array<{ count: SetThreshold; pieces: PlacedItem[] }> = [];
		for (let t = Math.max(2, piecesWorn + 1); ; t++) {
			const selection = selectFor(setId, t);
			if (!selection.ok) break;
			out.push({ count: t, pieces: selection.addedPieces });
		}
		return out;
	};
	// With `measureSetBonuses`: the counts at which each set has a bonus,
	// as the sim lists them, so no count without a bonus is simmed
	// (Thunderheart Harness at 5).
	const bonusCounts = measureSetBonuses
		? await setBonusCountsInReach(
				ctx,
				setIdsWithCandidates,
				setId => {
					const byCount = addedByCount(setId, wornCounts.get(setId) ?? 0);
					return byCount[byCount.length - 1]?.pieces;
				},
				(setId, reason) =>
					setCheckNotes.push(
						setBonusCountsSkipNote({
							setName: nameOfSet(setId),
							reason,
						}),
					),
			)
		: new Map<number, ReadonlySet<number>>();
	// With `measureSetBonuses`: the counts in reach at which the set has a
	// bonus. The same-gear check (`checkSameGear` in set-bonus-values.ts)
	// decides which are worth something here.
	const reachableCounts = (setId: number, piecesWorn: number): SetThreshold[] => {
		const known = bonusCounts.get(setId);
		return addedByCount(setId, piecesWorn)
			.map(entry => entry.count)
			.filter(t => !known || known.has(t));
	};

	/** The first SIM_ORDER slot each item fits; nothing is compared. */
	const firstSlotIndexByItemId = new Map<number, number>();
	for (const entry of candidates) {
		const idx = slotIndexForPoolEntry(entry);
		if (idx === undefined) continue;
		if (!firstSlotIndexByItemId.has(entry.itemId)) {
			firstSlotIndexByItemId.set(entry.itemId, idx);
		}
	}
	return { setIdsWithCandidates, wornCounts, selectFor, bonusCounts, reachableCounts, firstSlotIndexByItemId };
}

/**
 * For each set, the piece counts above the worn count at which the sim has a
 * bonus, up to the most pieces the pool can fill (`mostAddedPieces` gives
 * those pieces). They are the bonuses the sim lists as active
 * (`<set> (<n>pc)`) with those pieces added, less those active on the current
 * gear, so no set name has to match one the tab keeps.
 *
 * When those pieces fail gem repair or a read fails, the set gets no counts:
 * no reachable bonus or `crossingChecks` entry is simmed for it, a console
 * warning names the set, and `onNotRead` gets the reason. When Stop refuses a
 * read the set gets no counts and no warning, and `rankUpgrades` drops the
 * whole set phase. A runner that cannot read bonuses gives an empty map, and
 * every count is then tried.
 */
export async function setBonusCountsInReach(
	ctx: SetPhaseContext,
	setIds: ReadonlySet<number>,
	mostAddedPieces: (setId: number) => PlacedItem[] | undefined,
	onNotRead: (setId: number, reason: SkipReason) => void,
): Promise<Map<number, ReadonlySet<number>>> {
	const { equipment, gems, composeFor } = ctx;
	const { sim } = ctx.deps;
	const out = new Map<number, ReadonlySet<number>>();
	if (!sim.activeSetBonuses) return out;
	const read = (eq: readonly SimItemSpec[]) => sim.activeSetBonuses!(composeFor(eq));
	let wornNames: ReadonlySet<string> | undefined;
	for (const setId of [...setIds].sort((a, b) => a - b)) {
		const top = mostAddedPieces(setId);
		if (!top) continue;
		let build: ChainBuild;
		try {
			build = chainSwapsWithRepairs(equipment, top, gems);
		} catch (err) {
			if (!(err instanceof MetaRepairError)) throw err;
			console.warn(`[upgrades] set ${setId}: its bonus counts were not read, the added pieces' gem repair failed`, err);
			onNotRead(setId, SET_BONUS_SKIP_REASONS.metaOff(err.message));
			out.set(setId, new Set());
			continue;
		}
		try {
			wornNames ??= new Set(await read(equipment));
			const counts = new Set<number>();
			for (const name of await read(build.equipment)) {
				if (wornNames.has(name)) continue;
				const count = bonusCountOf(name);
				if (count !== undefined) counts.add(count);
			}
			out.set(setId, counts);
		} catch (err) {
			// A read the Stop guard refused is no failure to report.
			if (!(err instanceof StopRefusedSim)) {
				console.warn(`[upgrades] set ${setId}: its bonus counts were not read`, err);
				onNotRead(setId, SET_BONUS_SKIP_REASONS.bonusListFailed(errorText(err)));
			}
			out.set(setId, new Set());
		}
	}
	return out;
}

/**
 * With `measureSetBonuses`: whether one more piece of a worn set reaches
 * a bonus, measured on the gear a row makes. One check per worn set with a
 * candidate in a slot the set does not fill, on that set's best such
 * candidate's own swap, so `crossesThreshold` reads a measurement rather
 * than the fixed table in `isBonusImplemented`.
 */
export async function measureCrossingChecks(ctx: SetPhaseContext, reach: SetReach, cachedSampleRun: SampleRunnerFor): Promise<CrossingCheck[]> {
	const { candidates, equipment, gems, composeFor, ownDeltasByItemId, measureSetBonuses, cutoff, requestsPerLayout } = ctx;
	const { setIdsWithCandidates, wornCounts, bonusCounts } = reach;
	if (!measureSetBonuses) return [];
	const crossingChecks: CrossingCheck[] = [];
	for (const setId of [...setIdsWithCandidates].sort((a, b) => a - b)) {
		const worn = wornCounts.get(setId) ?? 0;
		if (worn < 1) continue;
		// One more piece reaches no bonus the sim lists.
		if (bonusCounts.get(setId)?.has(worn + 1) === false) continue;
		const wornSlots = new Set(setPieceSlots(equipment, setId));
		let best: OwnDelta | undefined;
		for (const entry of candidates) {
			if (getItem(entry.itemId)?.setId !== setId) continue;
			const ownDelta = ownDeltasByItemId.get(entry.itemId);
			if (!ownDelta || wornSlots.has(ownDelta.slotIndex)) continue;
			if (!best || ownDelta.deltaDps > best.deltaDps || (ownDelta.deltaDps === best.deltaDps && ownDelta.itemId < best.itemId)) {
				best = ownDelta;
			}
		}
		if (!best) continue;
		const crossing = [{ slotIndex: best.slotIndex, itemId: best.itemId }];
		let swapped: ChainBuild | undefined;
		try {
			swapped = chainSwapsWithRepairs(equipment, crossing, gems);
		} catch (err) {
			if (!(err instanceof MetaRepairError)) throw err;
		}
		const crossingBuild = swapped;
		const crossingLabel = setNameOf(equipment, setId);
		// A copy's failed gem repair leaves this check unmeasured with no line,
		// as a failed repair of the swap itself does above.
		let layoutRepairFailed = false;
		const nextPieceResult = crossingBuild
			? await measureSameGearBonus(
					cachedSampleRun(`${crossingLabel} ${worn + 1}pc crossing check`),
					composeFor(crossingBuild.equipment),
					setPieceSlots(crossingBuild.equipment, setId),
					worn,
					// "On" and "off" are compared as a pair, so they come from
					// one call.
					async copiesList => {
						const entries = repairErrorOr(await requestsPerLayout(g => chainSwapsWithRepairs(equipment, crossing, g), crossingBuild, copiesList));
						if (!(entries instanceof MetaRepairError)) {
							return entries.map(requestOf);
						}
						layoutRepairFailed = true;
						// Never read: the check's result is dropped below.
						return copiesList.map(() => ({ buildError: errorText(entries) }));
					},
				)
			: undefined;
		const measured = layoutRepairFailed ? undefined : nextPieceResult;
		if (isSimFailure(measured)) {
			bonusNotMeasured(ctx, crossingLabel, worn + 1, SET_BONUS_SKIP_REASONS.simFailed(measured.simError));
		}
		if (isBuildFailure(measured)) {
			bonusNotMeasured(ctx, crossingLabel, worn + 1, SET_BONUS_SKIP_REASONS.notBuilt(measured.buildError));
		}
		const value = isSimFailure(measured) || isBuildFailure(measured) ? undefined : measured;
		crossingChecks.push({
			setId,
			count: worn + 1,
			itemId: best.itemId,
			...(value ? { dps: value.dps, se: value.se } : {}),
			cleared: value !== undefined && clearsSameGearNoise(value.dps, value.se, cutoff),
		});
	}
	return crossingChecks;
}
