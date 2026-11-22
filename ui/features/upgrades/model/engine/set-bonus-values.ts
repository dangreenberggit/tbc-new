/**
 * The set phase's `setBonuses`: each reachable count of each set, measured
 * (`measureSetBonusValues`), and a set's 2pc value from one sim of two of its pieces
 * (`measurePairTwoPiece`), which a worn-1 4pc needs for its `bonusDpsNet`.
 */

import type { GemContext } from './candidate-gems';
import { type ChainBuild, chainSwapsWithRepairs } from './gear-swap';
import { type CopyLayout, isRepairFailure, type LayoutRequest, repairErrorOr, requestOf, type RequestsPerCopyLayout } from './hit-budget';
import { type GemRecolor, MetaRepairError } from './meta-repair';
import type { Deps, SetBonusValue } from './rank-types';
import { SET_BONUS_SKIP_REASONS, setBonusSkipNote, type SkipReason } from './run-notes';
import type { RaidSimRequest, SimRunOpts } from './seams/sim-runner';
import { type BuildFailure, clearsSameGearNoise, errorText, isBuildFailure, isSimFailure, measureSameGearBonus } from './set-less-copies';
import type { SetPhaseContext } from './set-phase';
import type { SetReach } from './set-reach';
import {
	type BonusDpsResult,
	brokenSetBonuses,
	combineSe,
	computeBonusDps,
	type CountsAsBreak,
	type DpsSample,
	isBonusImplemented,
	type OwnDelta,
	type PlacedItem,
	sampleOf,
	type SelfSetConfound,
	SET_THRESHOLDS,
	setPieceSlots,
	type SetThreshold,
} from './set-value';
import { simOrFailure } from './sim-calls';
import type { SimItemSpec } from './slots';

/** What measuring a count reads beyond the context. */
export type BonusTools = {
	readonly countsAsBreak: CountsAsBreak;
	/** `cachedSampleRun` from set-phase.ts, passed in so the import goes one way. */
	readonly cachedSampleRun: (what: string) => (request: RaidSimRequest) => Promise<DpsSample>;
};

/** One count of one set. */
type BonusAt = {
	readonly setId: number;
	/** The set's name, for `setName`, the notes and the warnings. */
	readonly label: string;
	readonly threshold: SetThreshold;
	readonly piecesWorn: number;
};

/**
 * What a set's 2pc leaves for its 4pc, one per set: written while the 2pc
 * is measured, read while the 4pc is.
 */
type TwoPieceCarry = {
	/** The 2pc's `bonusDps`, which the 4pc's value subtracts. */
	twoPcBonusDps: number | undefined;
	/** The 2pc took one added piece, so it was not measured (worn 1). */
	twoPieceUnmeasurableAtThisWornCount: boolean;
	/**
	 * With `measureSetBonuses`: a 4pc's value subtracts the 2pc's, so it
	 * stays unset when the 2pc's sims were tried and failed.
	 */
	twoPieceFailed: boolean;
};

/** `sameGearDps` and `sameGearSe` from the same-gear check, or none. */
type SameGearFields = Pick<SetBonusValue, 'sameGearDps' | 'sameGearSe'>;

/**
 * `setBonuses`: each reachable count of each set with a candidate piece,
 * one value per count, by set in pool order and then by count. A set with
 * no count to measure goes in `setIdsNotValued`.
 */
export async function measureSetBonusValues(
	ctx: SetPhaseContext,
	reach: SetReach,
	tools: BonusTools,
	nameOfSet: (setId: number) => string,
	screenedOut: ReadonlySet<number>,
): Promise<{ results: SetBonusValue[]; setIdsNotValued: number[] }> {
	const { measureSetBonuses } = ctx;
	const { setIdsWithCandidates, wornCounts, reachableCounts } = reach;
	const results: SetBonusValue[] = [];
	const setIdsNotValued: number[] = [];
	for (const setId of setIdsWithCandidates) {
		const piecesWorn = wornCounts.get(setId) ?? 0;
		const label = nameOfSet(setId);
		const twoPiece: TwoPieceCarry = { twoPcBonusDps: undefined, twoPieceUnmeasurableAtThisWornCount: false, twoPieceFailed: false };

		const thresholds = measureSetBonuses ? reachableCounts(setId, piecesWorn) : SET_THRESHOLDS.filter(t => t > piecesWorn);
		// No bonus in reach, or the set screen dropped the set: no bonus sims at
		// all. The set goes in `setIdsNotValued`, so its rows keep their own losses
		// and `crossesThreshold` in `setContext`, but it gets no `setBonuses`
		// entry, since none of its counts is a bonus the ranking measured.
		if ((measureSetBonuses && thresholds.length === 0) || screenedOut.has(setId)) {
			setIdsNotValued.push(setId);
			continue;
		}

		for (const threshold of thresholds) {
			results.push(await measureBonusAtCount(ctx, reach, tools, { setId, label, threshold, piecesWorn }, twoPiece));
		}
	}
	return { results, setIdsNotValued };
}

/**
 * One count of one set, measured, in steps: the no-sim cases, the added
 * gear, the same-gear check, the added pieces' sim, the bonus value and the
 * worn-1 pair correction. Every path gives one value. A 2pc writes what its
 * 4pc reads into `twoPiece`.
 */
async function measureBonusAtCount(ctx: SetPhaseContext, reach: SetReach, tools: BonusTools, at: BonusAt, twoPiece: TwoPieceCarry): Promise<SetBonusValue> {
	const { equipment, ownDeltasByItemId, baseline, measureSetBonuses } = ctx;
	const { setId, label, threshold, piecesWorn } = at;
	const selected = addedPiecesOrNoSimValue(ctx, reach, at, twoPiece);
	if ('value' in selected) return selected.value;
	const { addedPieces } = selected;
	const fail = countFailures(ctx, at, addedPieces, twoPiece);
	const gear = buildAddedGear(ctx, addedPieces);
	if (gear instanceof MetaRepairError) return fail.repairFailed(gear);

	let sameGear: DpsSample | undefined;
	if (measureSetBonuses) {
		const checked = await checkSameGear(ctx, tools, at, addedPieces, gear, fail);
		if ('value' in checked) return checked.value;
		sameGear = checked.sameGear;
	}
	const sameGearFields = sameGear ? { sameGearDps: sameGear.dps, sameGearSe: sameGear.se } : {};
	const simmed = await simAddedPieces(ctx, at, addedPieces, gear, sameGearFields, fail);
	if ('value' in simmed) return simmed.value;
	const { addedPiecesSample, gearRepairRecolors } = simmed;

	const addedPieceSamples = addedPieces.map(p => {
		const ownDelta = ownDeltasByItemId.get(p.itemId);
		return {
			deltaDps: ownDelta?.deltaDps ?? 0,
			se: ownDelta?.se ?? 0,
		};
	});
	const bonusValue = computeBonusDps({
		baseline,
		addedPiecesSample,
		addedPieceSamples,
		...(threshold === 4 && twoPiece.twoPcBonusDps !== undefined ? { twoPcBonusDps: twoPiece.twoPcBonusDps } : {}),
	});
	if (threshold === 2) twoPiece.twoPcBonusDps = bonusValue.bonusDps;

	const breaks = brokenSetBonuses(equipment, addedPieces, setId, tools.countsAsBreak);
	const selfConfound = await correctWornOnePair(ctx, tools, at, addedPieces, bonusValue, twoPiece);
	const missingTwoPiece = measureSetBonuses && threshold === 4 && twoPiece.twoPieceFailed;
	return {
		setId,
		setName: label,
		threshold,
		piecesWorn,
		packageItemIds: addedPieces.map(p => p.itemId),
		packageDeltaDps: bonusValue.packageDeltaDps,
		...(missingTwoPiece ? {} : { bonusDps: bonusValue.bonusDps, se: bonusValue.se }),
		...sameGearFields,
		...(breaks.length > 0 ? { breaks } : {}),
		...(selfConfound ? { selfConfound } : {}),
		...(gearRepairRecolors.length > 0
			? {
					gemSubstitutions: gearRepairRecolors.map(s => ({
						itemId: s.itemId,
						itemIndex: s.itemIndex,
						socketIndex: s.socketIndex,
						from: s.from,
						to: s.to,
					})),
				}
			: {}),
	};
}

/**
 * The counts that run no sim: a bonus the sim lacks (without
 * `measureSetBonuses`), too few pieces in the pool, or one added piece.
 * Otherwise the added pieces.
 */
function addedPiecesOrNoSimValue(
	ctx: SetPhaseContext,
	reach: SetReach,
	at: BonusAt,
	twoPiece: TwoPieceCarry,
): { value: SetBonusValue } | { addedPieces: PlacedItem[] } {
	const { setId, threshold } = at;
	if (!ctx.measureSetBonuses && !isBonusImplemented(setId, threshold)) {
		return { value: notValued(at, [], { unmeasured: 'not-implemented-in-sim' }) };
	}

	const selection = reach.selectFor(setId, threshold);
	if (!selection.ok) {
		return { value: notValued(at, [], { unmeasured: 'insufficient-pieces' }) };
	}

	const addedPieces = selection.addedPieces;
	if (addedPieces.length === 1) {
		if (threshold === 2) twoPiece.twoPieceUnmeasurableAtThisWornCount = true;
		return {
			value: notValued(
				at,
				addedPieces.map(p => p.itemId),
				{ unmeasured: 'unmeasurable-at-this-worn-count' },
			),
		};
	}
	return { addedPieces };
}

/** How a count with two or more added pieces ends unmeasured. */
type CountFailures = {
	repairFailed: (err: MetaRepairError) => SetBonusValue;
	notMeasured: (reason: SkipReason, sameGearFields: SameGearFields) => SetBonusValue;
};

/**
 * Each failure notes why the bonus was not measured and gives its value. A
 * failed 2pc tells the 4pc it has no 2pc value to subtract.
 */
function countFailures(ctx: SetPhaseContext, at: BonusAt, addedPieces: readonly PlacedItem[], twoPiece: TwoPieceCarry): CountFailures {
	const { label, threshold } = at;
	return {
		/** A failed gem repair on this gear or any copy of it skips this bonus. */
		repairFailed: err => {
			console.warn(`[upgrades] ${label} ${threshold}pc bonus's added pieces not measured: gem repair failed`, err);
			bonusNotMeasured(ctx, label, threshold, SET_BONUS_SKIP_REASONS.metaOff(err.message));
			const value = notValued(
				at,
				addedPieces.map(p => p.itemId),
				{ unmeasured: 'repair-failed' },
			);
			if (threshold === 2) twoPiece.twoPieceFailed = true;
			return value;
		},
		notMeasured: (reason, sameGearFields) => {
			bonusNotMeasured(ctx, label, threshold, reason);
			const value = notValued(
				at,
				addedPieces.map(p => p.itemId),
				{ ...sameGearFields, unmeasured: 'sim-failed' },
			);
			if (threshold === 2) twoPiece.twoPieceFailed = true;
			return value;
		},
	};
}

/** The added pieces' gear, and what the requests for it leave behind. */
type AddedGear = {
	readonly builtGear: ChainBuild;
	readonly rebuildGear: (g: GemContext) => ChainBuild;
	/**
	 * The added pieces' sim and the same-gear check's two sims, bonus on
	 * and bonus off (`measureSameGearBonus`), must wear the same gems, so
	 * all three come from one `requestsPerLayout` call when the check runs.
	 * `plainLayout` keeps the request without copies, or why it could not
	 * be built.
	 */
	plainLayout?: LayoutRequest | BuildFailure;
	/**
	 * A copy's failed gem repair skips this bonus with the repair's error, as
	 * on the gear without copies; an undefined entry alone would show a
	 * failed sim, and none ran.
	 */
	layoutRepairError?: MetaRepairError;
};

/** The added pieces' gear, or the gem repair's error when it fails. */
function buildAddedGear(ctx: SetPhaseContext, addedPieces: readonly PlacedItem[]): AddedGear | MetaRepairError {
	const { equipment, gems } = ctx;
	let gearBuild: ChainBuild;
	try {
		gearBuild = chainSwapsWithRepairs(equipment, addedPieces, gems);
	} catch (err) {
		if (!(err instanceof MetaRepairError)) throw err;
		return err;
	}
	return { builtGear: gearBuild, rebuildGear: g => chainSwapsWithRepairs(equipment, addedPieces, g) };
}

/**
 * With `measureSetBonuses`, the same-gear check runs before the added
 * pieces' sim, so a count with no bonus here costs only the check's two
 * sims.
 */
async function checkSameGear(
	ctx: SetPhaseContext,
	tools: BonusTools,
	at: BonusAt,
	addedPieces: readonly PlacedItem[],
	gear: AddedGear,
	fail: CountFailures,
): Promise<{ sameGear: DpsSample } | { value: SetBonusValue }> {
	const { setId, label, threshold } = at;
	const addedRequestsFor = async (copiesList: readonly CopyLayout[]) => {
		const entries = repairErrorOr(await ctx.requestsPerLayout(gear.rebuildGear, gear.builtGear, [{}, ...copiesList]));
		if (entries instanceof MetaRepairError) {
			gear.layoutRepairError ??= entries;
			// Never read: the caller checks `layoutRepairError` first.
			const failed = { buildError: errorText(entries) };
			return copiesList.map(() => failed);
		}
		gear.plainLayout = entries[0];
		return entries.slice(1).map(requestOf);
	};

	const measured = await measureSameGearBonus(
		tools.cachedSampleRun(`${label} ${threshold}pc same-gear bonus`),
		ctx.composeFor(gear.builtGear.equipment),
		setPieceSlots(gear.builtGear.equipment, setId),
		threshold - 1,
		addedRequestsFor,
	);
	if (gear.layoutRepairError) return { value: fail.repairFailed(gear.layoutRepairError) };
	if (!measured || isSimFailure(measured) || isBuildFailure(measured)) {
		return {
			value: fail.notMeasured(
				!measured
					? SET_BONUS_SKIP_REASONS.measuringSimsNotBuilt
					: isSimFailure(measured)
						? SET_BONUS_SKIP_REASONS.simFailed(measured.simError)
						: SET_BONUS_SKIP_REASONS.notBuilt(measured.buildError),
				{},
			),
		};
	}
	if (!clearsSameGearNoise(measured.dps, measured.se, ctx.cutoff)) {
		return {
			value: notValued(
				at,
				addedPieces.map(p => p.itemId),
				{ sameGearDps: measured.dps, sameGearSe: measured.se, belowNoise: true },
			),
		};
	}
	return { sameGear: measured };
}

/**
 * The added pieces' sim, on their gear without copies, with the gem changes
 * it wore outside their own slots; or the count's value when it cannot run.
 */
async function simAddedPieces(
	ctx: SetPhaseContext,
	at: BonusAt,
	addedPieces: readonly PlacedItem[],
	gear: AddedGear,
	sameGearFields: SameGearFields,
	fail: CountFailures,
): Promise<{ value: SetBonusValue } | { addedPiecesSample: DpsSample; gearRepairRecolors: GemRecolor[] }> {
	const { deps, simVersion, runOpts, requestsPerLayout } = ctx;
	const { label, threshold } = at;
	if (!gear.plainLayout) {
		const entries = repairErrorOr(await requestsPerLayout(gear.rebuildGear, gear.builtGear, [{}]));
		if (entries instanceof MetaRepairError) {
			return { value: fail.repairFailed(entries) };
		}
		[gear.plainLayout] = entries;
	}
	const gearEntry = gear.plainLayout!;
	if (isBuildFailure(gearEntry)) {
		return { value: fail.notMeasured(SET_BONUS_SKIP_REASONS.notBuilt(gearEntry.buildError), sameGearFields) };
	}
	const gearRequest = gearEntry.request;
	// The gem changes to list: the repair swaps of the gear this sim wore,
	// outside the added pieces' own slots.
	const addedSlots = new Set(addedPieces.map(p => p.slotIndex));
	const gearRepairRecolors = gearEntry.recolors.filter(s => !addedSlots.has(s.itemIndex));
	const gearOutcome = await simOrFailure(deps, gearRequest, simVersion, runOpts);
	if ('simError' in gearOutcome) {
		// No warning for a sim the Stop guard refused.
		if (!deps.signal?.aborted) {
			console.warn(`[upgrades] ${label} ${threshold}pc bonus's added pieces not measured: the sim failed`, gearOutcome.simError);
		}
		return { value: fail.notMeasured(SET_BONUS_SKIP_REASONS.simFailed(errorText(gearOutcome.simError)), sameGearFields) };
	}
	const addedPiecesSample: DpsSample = sampleOf(gearOutcome.observation, runOpts.iterations);
	return { addedPiecesSample, gearRepairRecolors };
}

/**
 * A worn-1 4pc's `selfConfound`, with the pair's 2pc value added into
 * `bonusValue` in place when the pair sim measured it. Undefined for any
 * other count.
 */
async function correctWornOnePair(
	ctx: SetPhaseContext,
	tools: BonusTools,
	at: BonusAt,
	addedPieces: readonly PlacedItem[],
	bonusValue: BonusDpsResult,
	twoPiece: TwoPieceCarry,
): Promise<SelfSetConfound | undefined> {
	const { deps, equipment, gems, composeFor, ownDeltasByItemId, baseline, simVersion, runOpts, requestsPerLayout } = ctx;
	const { setId, label, threshold } = at;
	let selfConfound: SelfSetConfound | undefined = threshold === 4 && twoPiece.twoPieceUnmeasurableAtThisWornCount ? { threshold: 2 } : undefined;
	if (selfConfound) {
		// At worn 1 the 2pc takes one added piece, so it is never measured on
		// its own, and each piece's own gain includes it: the raw 4pc value is
		// short by the 2pc once per piece after the first. Two of the pieces
		// simmed together reach only the 2pc, so the 2pc is their own gains
		// minus the pair's gain. A lost bonus of another worn set would bias
		// that, so the pieces must lose none alone or as a pair: two pieces
		// that each keep worn Malorne 3 at 2 take it to 1 together. With no
		// such pair `bonusDpsNet` stays unset.
		const breakFree = addedPieces.filter(p => brokenSetBonuses(equipment, [p], setId, tools.countsAsBreak).length === 0 && ownDeltasByItemId.has(p.itemId));
		const pair = breakFree
			.flatMap((a, i) => breakFree.slice(i + 1).map(b => [a, b]))
			.find(p => brokenSetBonuses(equipment, p, setId, tools.countsAsBreak).length === 0);
		const pairTwoPiece =
			pair !== undefined
				? await measurePairTwoPiece(
						`${label} ${threshold}pc`,
						deps,
						pair,
						equipment,
						gems,
						composeFor,
						ownDeltasByItemId,
						baseline,
						simVersion,
						runOpts,
						requestsPerLayout,
						reason => bonusNotMeasured(ctx, label, 2, reason),
					)
				: undefined;
		if (pairTwoPiece) {
			const extra = addedPieces.length - 1;
			bonusValue.bonusDps += extra * pairTwoPiece.dps;
			bonusValue.se = Math.sqrt(bonusValue.se ** 2 + (extra * pairTwoPiece.se) ** 2);
			selfConfound = { threshold: 2, dps: pairTwoPiece.dps };
		}
	}
	return selfConfound;
}

/**
 * A count's value with no bonus measured: `packageDeltaDps` 0 and no
 * `bonusDps`. `tail` says why, or holds the same-gear check's figures; it
 * goes last, in its own key order.
 */
function notValued(at: BonusAt, packageItemIds: number[], tail: SameGearFields & Pick<SetBonusValue, 'belowNoise' | 'unmeasured'>): SetBonusValue {
	return {
		setId: at.setId,
		setName: at.label,
		threshold: at.threshold,
		piecesWorn: at.piecesWorn,
		packageItemIds,
		packageDeltaDps: 0,
		...tail,
	};
}

/** Adds the run note that a bonus was not measured, and why. */
function bonusNotMeasured(ctx: SetPhaseContext, setName: string, threshold: SetThreshold, reason: SkipReason): void {
	ctx.setBonusNotes.push(setBonusSkipNote({ setName, threshold, reason }));
}

/**
 * One sim of two set pieces that lose no worn bonus, added together at worn
 * 1: the 2pc's value is their own gains minus the pair's gain. Undefined when
 * the gem repair or the sim fails; the caller then leaves the 4pc's
 * `bonusDpsNet` unset. Why goes to `onNotMeasured` with the error, except for
 * a sim Stop refused.
 */
export async function measurePairTwoPiece(
	bonusLabel: string,
	deps: Deps,
	pair: readonly PlacedItem[],
	equipment: readonly SimItemSpec[],
	gems: GemContext,
	composeFor: (equipment: readonly SimItemSpec[]) => RaidSimRequest,
	ownDeltasByItemId: ReadonlyMap<number, OwnDelta>,
	baseline: DpsSample,
	simVersion: string,
	runOpts: SimRunOpts,
	requestsPerLayout: RequestsPerCopyLayout,
	onNotMeasured: (reason: SkipReason) => void,
): Promise<{ dps: number; se: number } | undefined> {
	let pairBuild: ChainBuild;
	try {
		pairBuild = chainSwapsWithRepairs(equipment, pair, gems);
	} catch (err) {
		if (!(err instanceof MetaRepairError)) throw err;
		console.warn(`[upgrades] ${bonusLabel} net value not measured: gem repair failed for the worn-1 pair that measures the 2pc`, err);
		onNotMeasured(SET_BONUS_SKIP_REASONS.metaOff(err.message));
		return undefined;
	}
	const [entry] = await requestsPerLayout(g => chainSwapsWithRepairs(equipment, pair, g), pairBuild, [{}]);
	if (isRepairFailure(entry)) {
		console.warn(`[upgrades] ${bonusLabel} net value not measured: gem repair failed for the worn-1 pair that measures the 2pc`, entry.repairError);
		onNotMeasured(SET_BONUS_SKIP_REASONS.metaOff(entry.repairError.message));
		return undefined;
	}
	if (!entry || isBuildFailure(entry)) {
		console.warn(
			`[upgrades] ${bonusLabel} net value not measured: the request for the worn-1 pair that measures the 2pc could not be built`,
			entry?.buildError,
		);
		if (entry) onNotMeasured(SET_BONUS_SKIP_REASONS.notBuilt(entry.buildError));
		return undefined;
	}
	const request = entry.request;
	const outcome = await simOrFailure(deps, request, simVersion, runOpts);
	if ('simError' in outcome) {
		// No warning for a sim the Stop guard refused.
		if (!deps.signal?.aborted) {
			console.warn(`[upgrades] ${bonusLabel} net value not measured: the sim failed for the worn-1 pair that measures the 2pc`, outcome.simError);
			onNotMeasured(SET_BONUS_SKIP_REASONS.simFailed(errorText(outcome.simError)));
		}
		return undefined;
	}
	const ownDeltas = pair.map(p => ownDeltasByItemId.get(p.itemId)!);
	const pairSample: DpsSample = sampleOf(outcome.observation, runOpts.iterations);
	return {
		dps: ownDeltas.reduce((sum, s) => sum + s.deltaDps, 0) - (pairSample.dps - baseline.dps),
		se: combineSe([baseline, pairSample, ...ownDeltas.map(s => ({ dps: 0, se: s.se }))]),
	};
}
