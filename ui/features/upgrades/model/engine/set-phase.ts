/**
 * The set phase of a run, after the candidate sims. `runSetPhase` runs it: `buildSetBonuses`
 * measures what each set bonus is worth, then each row gets its `setContext` and the
 * bonus-gear sims run. rank.ts builds the `Ranking`'s set fields from what it gives.
 */

import type { GemContext } from './candidate-gems';
import type { Cutoff } from './cutoff';
import type { RunNote } from './disclosure';
import { type ChainBuild, chainSwapsWithRepairs } from './gear-swap';
import { type BaselineHitBudget, isRepairFailure, requestOf, type RequestsPerCopyLayout } from './hit-budget';
import { MetaRepairError } from './meta-repair';
import { estimateCombinedDelta, type PartnerPiece } from './partner-choice';
import type { PoolEntry } from './pool';
import type { CandidateResults } from './rank-candidates';
import type { RunContext } from './rank-setup';
import type { BrokenSetValue, CrossingCheck, Deps, RankInput, SetBonusValue, WornSetCountEntry } from './rank-types';
import { setScreenSkipNote } from './run-notes';
import type { RaidSimRequest, SimObservation, SimRunOpts } from './seams/sim-runner';
import { measureBonusGear } from './set-bonus-gear';
import { applyNetCorrection } from './set-bonus-net';
import { measureSetBonusValues } from './set-bonus-values';
import { applySetContext } from './set-context';
import { measureCrossingChecks, type SetReach, setReach } from './set-reach';
import { runSetScreenOn, type SetScreen, type SetScreenInput } from './set-screen';
import { brokenSetBonuses, type CountsAsBreak, type DpsSample, type OwnDelta, sampleOf, setNameOf } from './set-value';
import { countsAsBreakFrom, wornSetValues } from './set-worn-ladder';
import { runSimAt, simOrFailure } from './sim-calls';
import type { SimItemSpec } from './slots';

/**
 * What the set phase reads, the same for every step of it. `runSetPhase`
 * builds it once.
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
 * Makes the set phase's store-cached sim run; `what` names the sims in its
 * failure warning.
 */
export type SampleRunnerFor = (what: string) => (request: RaidSimRequest) => Promise<DpsSample>;

/**
 * The set-bonus sims, in order: the worn sets' values, which counts each set
 * can reach, the crossing checks, the "on" screen, the value of each
 * reachable count, then the correction for lost worn bonuses. It writes no
 * row; `runSetPhase` adds the rows' set fields after it.
 */
export async function buildSetBonuses(ctx: SetPhaseContext): Promise<SetPhaseResult> {
	const { candidates, equipment, baselineStdev } = ctx;
	const makeCachedSampleRun = (what: string) => cachedSampleRun(ctx, what);
	const { wornSetLadder, countsAsBreak, brokenSetValues, brokenBonusDpsByKey } = await wornSetValues(ctx, makeCachedSampleRun);
	// Set names for the notes: from the worn gear, else from the candidates.
	const candidateItemIds = candidates.map(entry => entry.itemId);
	const nameOfSet = (setId: number) => setNameOf(equipment, setId, candidateItemIds);
	const reach = await setReach(ctx, nameOfSet);
	const { setIdsWithCandidates, firstSlotIndexByItemId } = reach;

	// The screen runs after the worn-set values and before the loop over
	// reachable bonuses.
	const screenInput = setScreenInputFor(ctx, reach, nameOfSet);
	const crossingChecks = await measureCrossingChecks(ctx, reach, makeCachedSampleRun);
	const setScreen: SetScreen | undefined = screenInput
		? await runSetScreenOn({
				...screenInput,
				estimatedDeltaAt: (setId, threshold) => estimatedDeltaAt(ctx, reach, countsAsBreak, brokenBonusDpsByKey, crossingChecks, setId, threshold),
				baselineStdev,
			})
		: undefined;
	const screenedOut = new Set(setScreen ? setScreen.sets.filter(s => !s.kept).map(s => s.setId) : []);

	if (setIdsWithCandidates.size === 0) {
		return {
			bonuses: [],
			brokenSetValues,
			brokenBonusDpsByKey,
			wornSetLadder,
			crossingChecks: [],
			firstSlotIndexByItemId: new Map(),
			setIdsNotValued: [],
			...(setScreen ? { setScreen } : {}),
		};
	}

	const { results, setIdsNotValued } = await measureSetBonusValues(
		ctx,
		reach,
		{ countsAsBreak, cachedSampleRun: makeCachedSampleRun },
		nameOfSet,
		screenedOut,
	);
	applyNetCorrection(results, equipment, firstSlotIndexByItemId, countsAsBreak, brokenBonusDpsByKey);

	return {
		bonuses: results,
		brokenSetValues,
		brokenBonusDpsByKey,
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
					// The same swaps as `buildAddedGear` in set-bonus-values.ts, so the
					// screen sims the gear `measureSetBonusValues` would build for this
					// count.
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
						// fails is not measured, as in `measureSetBonusValues`.
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
	brokenBonusDpsByKey: ReadonlyMap<string, number | undefined>,
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
			breakDps: (s, c) => brokenBonusDpsByKey.get(`${s}:${c}`),
		},
		rest,
	);
	return estimate === undefined ? undefined : estimate - pieces.length * crossedPerPiece;
}

/** What the set phase gives when it does not run, or when Stop drops it. */
export function emptySetPhase(): SetPhaseResult {
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

/**
 * What the set phase leaves for the ranking. `dropSetFigures` empties it in
 * place when Stop fires after the candidate loop.
 */
export type SetPhaseOutcome = {
	setBonusResult: SetPhaseResult;
	countsAsBreak: CountsAsBreak | undefined;
	bonusGearResult: Awaited<ReturnType<typeof measureBonusGear>> | undefined;
	/** The set phase pushes to both, and a Stop empties them in place. */
	setBonusNotes: RunNote[];
	setCheckNotes: RunNote[];
};

/**
 * The whole set phase, in order: `buildSetBonuses`, then each row's
 * `setContext` (`applySetContext`), then the bonus-gear and bonus-off sims
 * (`measureBonusGear`), which write into each row's `setContext`. After a
 * Stop before it starts, it runs no sim and gives the empty set phase. After
 * a Stop during it, it starts no further sim and gives what it has;
 * `runRanking` then sees the Stop, and `dropSetFigures` empties that.
 */
export async function runSetPhase(
	ctx: RunContext,
	candidates: CandidateResults,
	baselineHitBudget: BaselineHitBudget,
	observation: SimObservation,
	requestsPerLayout: RequestsPerCopyLayout,
	abortedBefore: boolean,
): Promise<SetPhaseOutcome> {
	const { input, deps, guardedDeps, cutoff, composeFor, iterations, simVersion, runOpts, equipment } = ctx;
	const { ranked, ownDeltasByItemId, simCandidates } = candidates;
	const { gems } = baselineHitBudget;
	const signal = deps.signal;
	let aborted = abortedBefore;

	// A line for every set bonus the set phase could not measure, and for
	// every set screen or worn-set value sim that failed, most with the sim's
	// error.
	const setBonusNotes: RunNote[] = [];
	const setCheckNotes: RunNote[] = [];

	const setBonusResult = aborted
		? emptySetPhase()
		: await buildSetBonuses({
				deps: guardedDeps,
				candidates: simCandidates,
				equipment,
				gems,
				input,
				composeFor,
				ownDeltasByItemId,
				baseline: sampleOf(observation, iterations),
				simVersion,
				runOpts,
				setBonusNotes,
				setCheckNotes,
				measureSetBonuses: deps.measureSetBonuses ?? false,
				cutoff,
				baselineStdev: observation.stdev,
				requestsPerLayout,
			});
	if (signal?.aborted) aborted = true;
	// With `measureSetBonuses`, a swap loses a worn bonus only at a count
	// `wornSetLadder` counted, and no table is read. An aborted run has none,
	// so it charges no loss.
	const countsAsBreak: CountsAsBreak | undefined = deps.measureSetBonuses ? countsAsBreakFrom(setBonusResult.wornSetLadder) : undefined;
	const setBonuses = setBonusResult.bonuses;
	// With `measureSetBonuses`, a set row's future bonuses are valued by
	// one sim of the row plus its partner pieces.
	const simBonusGear = (deps.measureSetBonuses ?? false) && !aborted;
	const hasSetContext = setBonuses.length > 0 || setBonusResult.setIdsNotValued.length > 0;
	if (hasSetContext) {
		applySetContext({
			ranked,
			setBonuses,
			equipment,
			brokenBonusDpsByKey: setBonusResult.brokenBonusDpsByKey,
			firstSlotIndexByItemId: setBonusResult.firstSlotIndexByItemId,
			ownDeltasByItemId,
			countsAsBreak,
			measured: simBonusGear ? { crossingChecks: setBonusResult.crossingChecks } : undefined,
			setIdsNotValued: setBonusResult.setIdsNotValued,
		});
	}
	// After the future bonuses are filled in and before replication rewrites
	// the top rows' `deltaDps`: one sim per distinct gear of a row plus its
	// partner pieces.
	const bonusGearResult =
		simBonusGear && hasSetContext && countsAsBreak
			? await measureBonusGear({
					deps: guardedDeps,
					ranked,
					setBonuses,
					equipment,
					gems,
					composeFor,
					ownDeltasByItemId,
					brokenBonusDpsByKey: setBonusResult.brokenBonusDpsByKey,
					firstSlotIndexByItemId: setBonusResult.firstSlotIndexByItemId,
					countsAsBreak,
					baseline: sampleOf(observation, iterations),
					simVersion,
					runOpts,
					cutoff,
					requestsPerLayout,
					bonusNotes: setBonusNotes,
				})
			: undefined;
	return { setBonusResult, countsAsBreak, bonusGearResult, setBonusNotes, setCheckNotes };
}
