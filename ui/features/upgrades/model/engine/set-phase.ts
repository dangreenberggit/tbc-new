/**
 * The set phase of a run: after the candidate sims, it measures what each set bonus is worth
 * and fills the `Ranking`'s set fields.
 */

import type { GemContext } from './candidate-gems';
import type { Cutoff } from './cutoff';
import type { RunNote } from './disclosure';
import { type ChainBuild, chainSwapsWithRepairs } from './gear-swap';
import { isRepairFailure, requestOf, type RequestsPerCopyLayout } from './hit-budget';
import { MetaRepairError } from './meta-repair';
import { estimateCombinedDelta, type PartnerPiece } from './partner-choice';
import type { PoolEntry } from './pool';
import type { BrokenSetValue, CrossingCheck, Deps, RankInput, SetBonusValue, WornSetCountEntry } from './rank-types';
import { setScreenSkipNote } from './run-notes';
import type { RaidSimRequest, SimRunOpts } from './seams/sim-runner';
import { applyNetCorrection } from './set-bonus-net';
import { measureSetBonusValues } from './set-bonus-values';
import { measureCrossingChecks, type SetReach, setReach } from './set-reach';
import { runSetScreenOn, type SetScreen, type SetScreenInput } from './set-screen';
import { brokenSetBonuses, type CountsAsBreak, type DpsSample, type OwnDelta, sampleOf, setNameOf } from './set-value';
import { wornSetValues } from './set-worn-ladder';
import { runSimAt, simOrFailure } from './sim-calls';
import type { SimItemSpec } from './slots';

/**
 * What the set phase reads, the same for every step of it. `runSetPhase` in
 * rank.ts builds it once.
 */
export type SetPhaseContext = {
	/** `guardedDeps`: the run's deps with the Stop guard on its sim. */
	readonly deps: Deps;
	readonly candidates: readonly PoolEntry[];
	readonly equipment: readonly SimItemSpec[];
	readonly gems: GemContext;
	readonly input: RankInput;
	/**
	 * `rankUpgrades`'s own compose helper, passed in rather than rebuilt here
	 * so the two cannot drift. Every composed request must carry the database
	 * its own equipment needs.
	 */
	readonly composeFor: (equipment: readonly SimItemSpec[]) => RaidSimRequest;
	readonly ownDeltasByItemId: ReadonlyMap<number, OwnDelta>;
	readonly baseline: DpsSample;
	readonly simVersion: string;
	readonly runOpts: SimRunOpts;
	/** The caller's arrays: the set phase pushes to them, and a Stop empties them in place. */
	readonly setBonusNotes: RunNote[];
	readonly setCheckNotes: RunNote[];
	/**
	 * When set, measure every worn set's bonuses on the player's gear, charge
	 * only the counted ones as losses, and check each reachable bonus against
	 * noise.
	 */
	readonly measureSetBonuses: boolean;
	/** The ranking's cutoff, for the same-gear check on measured bonuses. */
	readonly cutoff: Cutoff;
	/**
	 * The baseline sim's per-iteration stdev (`Ranking.baseline.stdev`), for
	 * the "on" screen's noise estimate.
	 */
	readonly baselineStdev: number;
	/** Every set-phase request with repaired gems comes from it. */
	readonly requestsPerLayout: RequestsPerCopyLayout;
};

/** What the set phase gives the run. */
export type SetPhaseResult = {
	bonuses: SetBonusValue[];
	brokenSetValues: BrokenSetValue[];
	/** `brokenSetValues`' DPS by `bonusKey`, for every reader of a lost bonus's value. */
	brokenBonusDpsByKey: ReadonlyMap<string, number | undefined>;
	/** The worn sets' DPS at each piece count. Stored name: "ladder" is the list of counts. */
	wornSetLadder: WornSetCountEntry[];
	crossingChecks: CrossingCheck[];
	/**
	 * The first SIM_ORDER slot each item fits; nothing is compared. For
	 * `applySetContext` to find each row's losses.
	 */
	firstSlotIndexByItemId: Map<number, number>;
	/**
	 * No bonus in reach, or the set screen dropped them. Their rows still get
	 * a `setContext`.
	 */
	setIdsNotValued: number[];
	setScreen?: SetScreen;
};

/**
 * The set phase's steps, in order: the worn sets' values, which counts each
 * set can reach, the crossing checks, the "on" screen, the value of each
 * reachable count, then the correction for lost worn bonuses.
 */
export async function buildSetBonuses(ctx: SetPhaseContext): Promise<SetPhaseResult> {
	const { candidates, equipment, baselineStdev } = ctx;
	const runCached = (what: string) => cachedSampleRun(ctx, what);
	const { wornSetLadder, countsAsBreak, brokenSetValues, brokenDpsByKey } = await wornSetValues(ctx, runCached);
	// Set names for the notes: from the worn gear, else from the candidates.
	const candidateItemIds = candidates.map(entry => entry.itemId);
	const nameOfSet = (setId: number) => setNameOf(equipment, setId, candidateItemIds);
	const reach = await setReach(ctx, nameOfSet);
	const { setIdsWithCandidates, firstSlotIndexByItemId } = reach;

	// The screen runs after the worn-set values and before the loop over
	// reachable bonuses.
	const screenInput = setScreenInputFor(ctx, reach, nameOfSet);
	const crossingChecks = await measureCrossingChecks(ctx, reach, runCached);
	const setScreen: SetScreen | undefined = screenInput
		? await runSetScreenOn({
				...screenInput,
				estimatedDeltaAt: (setId, threshold) => estimatedDeltaAt(ctx, reach, countsAsBreak, brokenDpsByKey, crossingChecks, setId, threshold),
				baselineStdev,
			})
		: undefined;
	const screenedOut = new Set(setScreen ? setScreen.sets.filter(s => !s.kept).map(s => s.setId) : []);

	if (setIdsWithCandidates.size === 0) {
		return {
			bonuses: [],
			brokenSetValues,
			brokenBonusDpsByKey: brokenDpsByKey,
			wornSetLadder,
			crossingChecks: [],
			firstSlotIndexByItemId: new Map(),
			setIdsNotValued: [],
			...(setScreen ? { setScreen } : {}),
		};
	}

	const { results, setIdsNotValued } = await measureSetBonusValues(ctx, reach, { countsAsBreak, cachedSampleRun: runCached }, nameOfSet, screenedOut);
	applyNetCorrection(results, equipment, firstSlotIndexByItemId, countsAsBreak, brokenDpsByKey);

	return {
		bonuses: results,
		brokenSetValues,
		brokenBonusDpsByKey: brokenDpsByKey,
		wornSetLadder,
		crossingChecks,
		firstSlotIndexByItemId,
		setIdsNotValued,
		...(setScreen ? { setScreen } : {}),
	};
}

/**
 * The set sims' store-cached run; the caller decides what a failed sim
 * costs.
 */
function cachedSampleRun(ctx: SetPhaseContext, what: string): (request: RaidSimRequest) => Promise<DpsSample> {
	const { deps, simVersion, runOpts } = ctx;
	return async (request: RaidSimRequest): Promise<DpsSample> => {
		const outcome = await simOrFailure(deps, request, simVersion, runOpts);
		if ('simError' in outcome) {
			// After Stop the guard refused the sim, which is no sim failure,
			// and the caller drops this run's set figures.
			if (!deps.signal?.aborted) {
				console.warn(`[upgrades] ${what} not measured: the sim failed`, outcome.simError);
			}
			throw outcome.simError;
		}
		return sampleOf(outcome.observation, runOpts.iterations);
	};
}

/**
 * The "on" set screen's input, or undefined when the screen does not run.
 * Building it runs no sim; `runSetScreenOn` runs them.
 */
function setScreenInputFor(ctx: SetPhaseContext, reach: SetReach, nameOfSet: (setId: number) => string): SetScreenInput | undefined {
	const { deps, equipment, gems, composeFor, simVersion, runOpts, setCheckNotes, measureSetBonuses, requestsPerLayout } = ctx;
	const { setIdsWithCandidates, wornCounts, selectFor, reachableCounts } = reach;
	return measureSetBonuses && deps.setScreenMode === 'on'
		? {
				sets: [...setIdsWithCandidates]
					.sort((a, b) => a - b)
					.map(setId => {
						const worn = wornCounts.get(setId) ?? 0;
						const reachable = reachableCounts(setId, worn);
						return {
							setId,
							worn,
							reach: reachable[reachable.length - 1] ?? worn,
						};
					}),
				gearAt: (setId, threshold) => {
					const selection = selectFor(setId, threshold);
					if (!selection.ok) return undefined;
					// The same swaps as the loop below, so the screen sims the gear
					// that loop would build for this count.
					const pieces = selection.addedPieces;
					let base: ChainBuild;
					try {
						base = chainSwapsWithRepairs(equipment, pieces, gems);
					} catch (err) {
						if (!(err instanceof MetaRepairError)) throw err;
						return undefined;
					}
					return {
						request: composeFor(base.equipment),
						added: pieces,
						// Each copy layout gets its own gem repair; one whose repair
						// fails is not measured, as in the loop below.
						requestsFor: async copiesList =>
							(await requestsPerLayout(g => chainSwapsWithRepairs(equipment, pieces, g), base, copiesList)).map(entry =>
								isRepairFailure(entry) ? undefined : requestOf(entry),
							),
					};
				},
				runSimAt: (request, opts) => runSimAt(deps, request, simVersion, opts),
				seed: runOpts.seed,
				...(deps.signal ? { signal: deps.signal } : {}),
				onSimFailed: (setId, error) =>
					setCheckNotes.push(
						setScreenSkipNote({
							setName: nameOfSet(setId),
							error,
						}),
					),
				onRequestNotBuilt: (setId, error) =>
					setCheckNotes.push(
						setScreenSkipNote({
							setName: nameOfSet(setId),
							error,
							notBuilt: true,
						}),
					),
			}
		: undefined;
}

/**
 * The "on" screen estimates the added pieces' gain at each count with
 * `estimateCombinedDelta`, which adds no term for the set's own bonuses.
 * The estimate treats the row like any other added piece, so which piece is
 * the row does not matter. But each own delta of a set worn at w was simmed
 * with w + 1 pieces, so when w + 1 is a bonus count every own delta holds
 * that bonus once. The pair counts it already, so the crossing check's
 * value, which is that bonus, is taken out once per added piece (ticket
 * 886). A crossing check that ran without a value leaves the estimate
 * unset, and the screen keeps the set.
 */
function estimatedDeltaAt(
	ctx: SetPhaseContext,
	reach: SetReach,
	countsAsBreak: CountsAsBreak,
	brokenDpsByKey: ReadonlyMap<string, number | undefined>,
	crossingChecks: readonly CrossingCheck[],
	setId: number,
	threshold: number,
): number | undefined {
	const { equipment, ownDeltasByItemId } = ctx;
	const { selectFor } = reach;
	const selection = selectFor(setId, threshold);
	if (!selection.ok) return undefined;
	const crossing = crossingChecks.find(c => c.setId === setId && c.count === selection.piecesWorn + 1);
	if (crossing && crossing.dps === undefined) return undefined;
	const crossedPerPiece = crossing?.dps ?? 0;
	const pieces: PartnerPiece[] = [];
	for (const piece of selection.addedPieces) {
		const ownDelta = ownDeltasByItemId.get(piece.itemId)?.deltaDps;
		if (ownDelta === undefined) return undefined;
		pieces.push({
			itemId: piece.itemId,
			slotIndex: piece.slotIndex,
			ownDeltaDps: ownDelta,
		});
	}
	const [row, ...rest] = pieces;
	if (!row) return undefined;
	const estimate = estimateCombinedDelta(
		{
			row,
			brokenBy: swaps => brokenSetBonuses(equipment, swaps, setId, countsAsBreak),
			breakDps: (s, c) => brokenDpsByKey.get(`${s}:${c}`),
		},
		rest,
	);
	return estimate === undefined ? undefined : estimate - pieces.length * crossedPerPiece;
}

/** What the set phase gives when it does not run, or when Stop drops it. */
export function emptySetPhase(): Awaited<ReturnType<typeof buildSetBonuses>> {
	return {
		bonuses: [],
		brokenSetValues: [],
		brokenBonusDpsByKey: new Map(),
		wornSetLadder: [],
		crossingChecks: [],
		firstSlotIndexByItemId: new Map(),
		setIdsNotValued: [],
	};
}
